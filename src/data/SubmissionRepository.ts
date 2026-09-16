import type { Prisma, ProcessingStatus, Submission, SubmissionStatus } from '@prisma/client';
import { JOB_TYPES, isJobType, type JobType } from '../domain/jobs/jobTypes.ts';
import { getPrismaClient } from './prismaClient.ts';

/**
 * Data access for `Submission` (ARCHITECTURE Section 18 — "Database access: src/data/*Repository.ts").
 *
 * This layer holds queries, not rules. It does not decide whether a student may start an
 * assessment, whether a draft is complete, or what a roll number should normalize to — those are
 * domain decisions that live in `src/domain/`. In particular it deliberately takes
 * `rollNumberNormalized` as a *given* rather than computing it from `rollNumberRaw`, so
 * normalization has exactly one implementation (`StudentIdentityService`, T3.2.1) instead of two
 * that could drift apart.
 *
 * The class is a thin handle over the shared client rather than a connection owner: every method
 * resolves the process-wide Prisma client lazily, so constructing a repository is free and no
 * second connection pool is ever opened.
 */

export type CreateDraftInput = {
  cohortId: string;
  /** As typed by the student, preserved for display. */
  rollNumberRaw: string;
  /** Trimmed + lowercased by the caller; the uniqueness/lookup key. */
  rollNumberNormalized: string;
  studentName: string;
  /** Frozen at draft creation from `ContentLoader.getCurrentVersion()`. */
  contentVersion: string;
};

export class SubmissionRepository {
  /** Looks a submission up by primary key. Returns null rather than throwing when absent. */
  async findById(id: string): Promise<Submission | null> {
    return getPrismaClient().submission.findUnique({ where: { id } });
  }

  /**
   * The identity lookup — one submission per cohort + normalized roll number (FR-STU-005/007).
   *
   * `findUnique` is used rather than `findFirst` because `@@unique([cohortId,
   * rollNumberNormalized])` makes this a genuine unique lookup, which is what lets the database
   * guarantee at most one row is returned under any interleaving.
   */
  async findByCohortAndRollNumber(
    cohortId: string,
    rollNumberNormalized: string,
  ): Promise<Submission | null> {
    return getPrismaClient().submission.findUnique({
      where: { cohortId_rollNumberNormalized: { cohortId, rollNumberNormalized } },
    });
  }

  /**
   * Creates an empty draft.
   *
   * `answers` starts as `{}` — the section-keyed shape (Section 12) with no section filled in
   * yet. New drafts start under `status='draft'` and the `writingStatus`/`problemsTextStatus`
   * defaults from the schema, so nothing else needs to be set here.
   */
  async createDraft(input: CreateDraftInput): Promise<Submission> {
    return getPrismaClient().submission.create({
      data: {
        cohortId: input.cohortId,
        rollNumberRaw: input.rollNumberRaw,
        rollNumberNormalized: input.rollNumberNormalized,
        studentName: input.studentName,
        contentVersion: input.contentVersion,
        answers: {},
      },
    });
  }

  /**
   * Creates a draft, or returns the row that already exists for the same identity.
   *
   * This exists so the caller can be a *find-or-create* without knowing how the "or" is spelled.
   * `createDraft` alone would be enough for every request that arrives after the first, but two
   * requests that arrive together — a student double-clicking "Start", or two tabs opened from the
   * same entry page — both find nothing and both insert. Postgres rejects the second with a unique
   * violation on `@@unique([cohortId, rollNumberNormalized])`, which is the guarantee; without
   * this method that rejection would surface as a 500 on a legitimate first visit.
   *
   * The unique-violation code is read structurally rather than by importing Prisma's error class,
   * so this stays a check on the constraint rather than a dependency on a runtime subpath.
   *
   * If the violation turns out not to be this constraint, or the row cannot be re-read, the
   * original error is rethrown — swallowing it would hide a genuine failure behind a retry.
   */
  async createDraftIfAbsent(input: CreateDraftInput): Promise<Submission> {
    try {
      return await this.createDraft(input);
    } catch (error) {
      if (!isUniqueConstraintViolation(error)) throw error;

      const existing = await this.findByCohortAndRollNumber(
        input.cohortId,
        input.rollNumberNormalized,
      );

      if (!existing) throw error;

      return existing;
    }
  }

  /**
   * Merges one section's answers into the stored `answers`, atomically (ARCHITECTURE Section 12).
   *
   * This is the section-level autosave write, and it is deliberately **not** a read-modify-write.
   * Prisma exposes no operator for Postgres' `jsonb ||`, so the merge is expressed as the raw
   * statement Section 12 specifies:
   *
   *     answers = answers || jsonb_build_object($section, $sectionAnswers)
   *
   * Postgres replaces only the named top-level key and leaves every other key exactly as it was, so
   * two requests touching different sections cannot lose each other's work and neither can lose the
   * whole document. That property is the database's, not this method's discipline — which is what
   * makes it hold under concurrency rather than only under sequential use.
   *
   * `status = 'draft'` is part of the `WHERE` clause, not a check performed before it. A submitted
   * row is never *targeted* by this statement at all (Section 12 — "immutable after submission"),
   * so there is no window between deciding a write is allowed and making it.
   *
   * ## On the raw SQL
   *
   * Every value is a bound parameter; nothing from the request is interpolated into the statement.
   * The `$executeRaw` tagged template is the parameterized form — the placeholders below become
   * `$1`, `$2`, `$3` in the query Prisma sends, so `section` is data (a text value) and never
   * syntax. `sectionAnswers` is serialized by `JSON.stringify` and cast to `jsonb` on the server
   * side, so it arrives as one value rather than as SQL.
   *
   * ## Why a follow-up read
   *
   * Zero rows updated means either the row is absent or it is no longer a draft, and one statement
   * cannot say which. The read below answers only that question — it is *not* part of deciding
   * whether to write, and a row that changes between the two cannot make a write that did not
   * happen appear to have happened, or vice versa. Its whole job is choosing between two error
   * codes for a caller that needs to know whether to re-verify identity or show a report instead.
   */
  async mergeSectionAnswers(
    submissionId: string,
    section: string,
    sectionAnswers: unknown,
  ): Promise<SectionMergeResult> {
    const rowsUpdated = await getPrismaClient().$executeRaw`
      UPDATE "Submission"
         SET "answers" = "answers" || jsonb_build_object(${section}::text, ${JSON.stringify(sectionAnswers ?? null)}::jsonb),
             "updatedAt" = now()
       WHERE "id" = ${submissionId}
         AND "status" = 'draft'
    `;

    if (rowsUpdated === 1) return { outcome: 'merged' };

    const existing = await this.findById(submissionId);

    if (!existing) return { outcome: 'not_found' };

    return { outcome: 'not_draft', status: existing.status };
  }

  /**
   * Runs `fn` inside one database transaction.
   *
   * Exposed as a *handle* rather than as a repository method per finalization step, because
   * finalization's steps are not independent queries — they are one read-check-write whose middle
   * step is a domain decision (Section 6, transaction boundary #1). The decision has to be made
   * between the read and the write, inside the same transaction, so the shape that works is the one
   * where the caller sequences the steps and this layer performs them.
   *
   * The alternative — reading outside, deciding, then writing — is exactly the race the transaction
   * exists to close: two submits that both read `status='draft'` would both decide to finalize, and
   * only the database could stop the second.
   */
  async transaction<T>(fn: (tx: SubmissionTx) => Promise<T>): Promise<T> {
    return getPrismaClient().$transaction(fn);
  }

  /**
   * Reads a submission and holds a row lock on it until the transaction ends — `SELECT … FOR
   * UPDATE` (Section 3's finalize flow).
   *
   * This is the mechanism that makes finalization idempotent under concurrency rather than merely
   * under repetition, and it is deliberately a *database* mechanism. A second finalize that arrives
   * while the first is mid-transaction blocks here, and when the first commits, the lock is granted
   * on the row's new version — so the second reads `status='submitted'` and becomes a no-op. An
   * application-level check could not do this: it would have to run before the lock, which is the
   * one place it is guaranteed to be looking at stale state.
   *
   * Returns null when there is no such row, so a caller can distinguish "gone" from "locked".
   */
  async lockById(tx: SubmissionTx, id: string): Promise<Submission | null> {
    const locked = await tx.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "Submission" WHERE "id" = ${id} FOR UPDATE
    `;

    if (locked.length === 0) return null;

    // Read through the typed client rather than from the raw row, so the caller gets a `Submission`
    // and not a map of columns. It is the row just locked, in this transaction, so it cannot change
    // between the two statements.
    return tx.submission.findUnique({ where: { id } });
  }

  /**
   * The finalize write: draft becomes the immutable submitted record (Section 3, Section 12).
   *
   * Called only from inside the transaction that holds the row lock, which is why it carries no
   * `status = 'draft'` predicate of its own — the lock has already established that this caller is
   * the only one looking at the row, and the caller has already decided. Adding a second guard here
   * would make the version in `SubmissionService` untestable while appearing to be the real one.
   *
   * `answers` is deliberately absent from the write: it is the frozen record, already complete, and
   * nothing during finalization changes it.
   */
  async markSubmitted(tx: SubmissionTx, id: string, write: FinalizeWrite): Promise<Submission> {
    return tx.submission.update({
      where: { id },
      data: {
        status: 'submitted',
        submittedAt: new Date(),
        ...write,
      },
    });
  }

  /**
   * Inserts a finalized submission's processing jobs (Section 3, Section 6 boundary #1).
   *
   * Takes job-type strings rather than an enum because `ProcessingJob.jobType` is a plain string
   * column (Section 6): the set of job types belongs to the domain layer that enqueues and consumes
   * them, not to the query that stores them.
   *
   * `status` and `nextAttemptAt` are left to their schema defaults — `pending` and now — so a job is
   * claimable by the worker's very next poll tick without this having to state either.
   */
  async enqueueJobs(tx: SubmissionTx, submissionId: string, jobTypes: string[]): Promise<void> {
    if (jobTypes.length === 0) return;

    await tx.processingJob.createMany({
      data: jobTypes.map((jobType) => ({ submissionId, jobType })),
    });
  }

  /**
   * Writes a succeeded writing evaluation onto the submission (Section 3, Section 6 boundary #4).
   *
   * `overallScore` is *passed in* rather than computed here. FR-WRITE-006 and Section 7 reserve that
   * number for `WritingScoreCalculator`, which computes it from these criterion scores and the
   * versioned rubric weights; this layer stores what it is handed, exactly as it does for the
   * criterion judgments themselves. The three columns move together or not at all — a row whose
   * `writingStatus` is `succeeded` always carries both the criteria and the score derived from them.
   *
   * Called only inside the transaction that also marks the job succeeded, which is the whole point of
   * boundary #4: the result and the record of having produced it are one fact.
   */
  async recordWritingEvaluation(
    tx: SubmissionTx,
    submissionId: string,
    write: WritingEvaluationWrite,
  ): Promise<void> {
    await tx.submission.update({
      where: { id: submissionId },
      data: {
        writingCriteriaScores: write.criteriaScores,
        writingOverallScore: write.overallScore,
        writingFeedback: write.feedback,
        writingStatus: 'succeeded',
      },
    });
  }

  /**
   * Writes a succeeded Student Problems analysis onto the submission (Section 12, Section 6).
   *
   * Writes `problemsTextDerived` and nothing else on the data side. `problemsOpenTextOriginal` is
   * absent from this statement — not omitted by oversight, but because it is the one column the AI
   * must never reach (FR-PROB-009/FR-PROB-013), and a write that cannot name it cannot overwrite it.
   */
  async recordStudentProblemsAnalysis(
    tx: SubmissionTx,
    submissionId: string,
    derived: Prisma.InputJsonValue,
  ): Promise<void> {
    await tx.submission.update({
      where: { id: submissionId },
      data: { problemsTextDerived: derived, problemsTextStatus: 'succeeded' },
    });
  }

  /**
   * Records that a writing evaluation will not produce a result (FR-WRITE-011, EDGE-004).
   *
   * Only the status column. The student's response is in `answers.writing.essayText`, which this
   * statement cannot reach — Section 12's "the original is preserved" is a property of the write
   * being this narrow, not of a caller remembering not to touch it.
   */
  async markWritingEvaluationNeedsReview(tx: SubmissionTx, submissionId: string): Promise<void> {
    await tx.submission.update({
      where: { id: submissionId },
      data: { writingStatus: 'failed_needs_review' },
    });
  }

  /** The same for Student Problems processing (FR-PROB-013, EDGE-008), and equally narrow. */
  async markProblemsTextNeedsReview(tx: SubmissionTx, submissionId: string): Promise<void> {
    await tx.submission.update({
      where: { id: submissionId },
      data: { problemsTextStatus: 'failed_needs_review' },
    });
  }

  /**
   * Resolves everything a background job needs to run, from the Submission row and nothing else
   * (ARCHITECTURE Section 8, Section 18 — canonical location for "resolving a submission's
   * authoritative response text / content for background evaluation").
   *
   * ## Why the job table is not consulted
   *
   * Section 8 is explicit that a `ProcessingJob` row carries *"which submission and which kind of
   * work — nothing more"*, and gives the reason: *"it means the job table can never hold a stale or
   * divergent copy of the response text or rubric, and a submission's data has exactly one place it
   * lives."* This method is that sentence made operational. It takes a submission id and a job type
   * and reads one row; there is no field it could take from the job even if a caller offered one,
   * because `processing_jobs` does not have one (Section 6).
   *
   * The `contentVersion` it returns is the one frozen on the submission at draft creation, never
   * `getCurrentVersion()`. That is what makes Section 12's historical interpretability hold: a
   * submission is evaluated against the rubric it was written for, and the caller's next step —
   * `ContentLoader.getContent(context.contentVersion)` — throws rather than falling back if that
   * version is missing.
   *
   * ## Why the missing-field cases throw instead of returning empty
   *
   * Both failures below are *unreachable through the normal flow* — `finalize` only enqueues a
   * writing job after checking the response is non-blank, and only enqueues the Student Problems job
   * when there was open text to process. So reaching either means a row that no code path in this
   * system wrote, and the two answers available are "hand back an empty string" or "refuse". An
   * empty string would be evaluated as a blank essay and *scored*: the model would return criterion
   * judgments about a text that does not exist, the numbers would look entirely reasonable, and
   * nothing anywhere would report a problem. A refusal is visible, and lands the job in
   * `failed_needs_review` where staff can see it (FR-WRITE-011).
   *
   * The check is `trim().length === 0` and the value returned is **untrimmed**, for the reason
   * `SubmissionService.readOpenText` gives: the original is the record (FR-PROB-009), and trimming
   * it to test it and then handing back the trimmed version would quietly alter what the student
   * wrote before it was ever sent to the model.
   */
  async getEvaluationContext(submissionId: string, jobType: string): Promise<EvaluationContext> {
    if (!isJobType(jobType)) {
      throw new Error(
        `Cannot resolve an evaluation context for unrecognized job type ${JSON.stringify(jobType)}. ` +
          `Known types: ${Object.values(JOB_TYPES).join(', ')}.`,
      );
    }

    const submission = await this.findById(submissionId);

    if (!submission) {
      throw new Error(
        `Cannot resolve an evaluation context: no submission with id ${submissionId}.`,
      );
    }

    const responseText =
      jobType === JOB_TYPES.writingEvaluation
        ? writingResponseText(submission)
        : studentProblemsResponseText(submission);

    return { jobType, responseText, contentVersion: submission.contentVersion };
  }
}

/**
 * What a job needs, resolved fresh at claim time (ARCHITECTURE Section 8).
 *
 * One shape rather than a union on `jobType`: Section 8's sketch shows the two variants carrying
 * identical fields, so a discriminated union here would discriminate nothing — the caller picks its
 * evaluation by the job type it already holds, not by narrowing this. If a future job type needs
 * input this one does not, that is the point at which a union earns its place.
 */
export type EvaluationContext = {
  jobType: JobType;
  /** The student's own words, exactly as stored. Never empty — see `getEvaluationContext`. */
  responseText: string;
  /** The version frozen at draft creation; the caller resolves content through it, never "current". */
  contentVersion: string;
};

/** The writing response, from `answers.writing.essayText` (Section 8). */
function writingResponseText(submission: Submission): string {
  const writing = (submission.answers as DraftAnswersLike).writing;
  const essayText = writing?.essayText;

  if (typeof essayText !== 'string' || essayText.trim().length === 0) {
    throw new Error(
      `Cannot evaluate writing for submission ${submission.id}: it has no essay text. ` +
        'A writing job is only enqueued for a response that was written, so this row is not one ' +
        'any submission path produces.',
    );
  }

  return essayText;
}

/** The Student Problems open text, from its own column — never from `answers` (Section 6). */
function studentProblemsResponseText(submission: Submission): string {
  const original = submission.problemsOpenTextOriginal;

  if (typeof original !== 'string' || original.trim().length === 0) {
    throw new Error(
      `Cannot process Student Problems text for submission ${submission.id}: ` +
        'problemsOpenTextOriginal is empty. A Student Problems job is only enqueued when open ' +
        'text was given, so this row is not one any submission path produces.',
    );
  }

  return original;
}

/**
 * The part of `answers` this file reads.
 *
 * Declared structurally rather than imported from `src/shared/types/draft.ts`, because this module
 * needs one field of one section and nothing else — importing the whole answer contract to name
 * `writing.essayText` would make the data layer depend on the wire format of every section. The
 * shape is asserted by the writers (`draftAutosaveBodySchema`), which is the same single fact
 * `toDraftAnswers` relies on.
 */
type DraftAnswersLike = {
  writing?: { essayText?: unknown };
};

/**
 * The AI result columns a succeeded writing job writes (Section 6).
 *
 * Two JSON values rather than the boundary's `WritingEvaluation`, so this layer stores what it is
 * handed without taking a dependency on the shape of the AI contract — the mapping from criterion
 * judgments to `writingCriteriaScores` and feedback to `writingFeedback` is a domain decision and
 * lives in `JobService`.
 */
export type WritingEvaluationWrite = {
  /** Criterion key → `{ score, rationale }` (Section 6's `writingCriteriaScores`). */
  criteriaScores: Prisma.InputJsonValue;
  /**
   * The 0–100 overall, already computed by `WritingScoreCalculator` (Section 6's
   * `writingOverallScore`, an `Int?` — which is why the calculator rounds).
   */
  overallScore: number;
  /** Strengths, weaknesses, corrections, and suggestions (Section 6's `writingFeedback`). */
  feedback: Prisma.InputJsonValue;
};

/**
 * A handle for a transaction the caller owns.
 *
 * Named here rather than taking Prisma's type at every call site, so the domain service can pass a
 * transaction around without naming the client library.
 */
export type SubmissionTx = Prisma.TransactionClient;

/** The columns finalization writes onto the submission it finalizes (Section 3). */
export type FinalizeWrite = {
  grammarScore: number;
  vocabularyScore: number;
  readingScore: number;
  /** The structured scale responses, lifted out of `answers` into their own column (Section 6). */
  problemsLikertAnswers: Record<string, number>;
  /** Written exactly once, here, and never again (FR-PROB-009, Section 12). */
  problemsOpenTextOriginal: string | null;
  writingStatus: ProcessingStatus;
  problemsTextStatus: ProcessingStatus;
};

/**
 * What a section merge did — or, when it did nothing, which of the two reasons applies.
 *
 * A discriminated union because the caller must handle all three: two of them are refusals with
 * different remedies (re-verify identity, versus show the report), and making them a boolean or a
 * nullable would let a route collapse them by accident.
 */
export type SectionMergeResult =
  | { outcome: 'merged' }
  | { outcome: 'not_draft'; status: SubmissionStatus }
  | { outcome: 'not_found' };

/** Whether an error is Postgres' unique-constraint violation as Prisma reports it. */
function isUniqueConstraintViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'P2002'
  );
}

/** The process-wide repository instance. */
export const submissionRepository = new SubmissionRepository();
