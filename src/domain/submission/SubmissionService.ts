import type { Submission } from '@prisma/client';
import { getContentLoader, type ContentBundle, type ContentLoader } from '../../content/ContentLoader.ts';
import {
  submissionRepository,
  type SubmissionRepository,
  type SubmissionTx,
} from '../../data/SubmissionRepository.ts';
import type { ChoiceAnswers, DraftAnswers } from '../../shared/types/draft.ts';
// The job vocabulary lives in the job domain's own module, not here: this service is one of the
// three modules that must agree on those strings, and a shared vocabulary does not belong inside
// one of its speakers. See `src/domain/jobs/jobTypes.ts`.
import { JOB_TYPES } from '../jobs/jobTypes.ts';
import { SECTION_KEYS, type SectionKey } from '../../shared/types/sections.ts';
import {
  scoreDeterministicSections,
  type DeterministicScores,
} from '../scoring/DeterministicScoringService.ts';

/**
 * Finalizing a submission — draft to immutable record (ARCHITECTURE Section 7, Section 18 —
 * canonical location for "Submission finalization rules").
 *
 * Section 7 states the property this file has to hold: *"The single canonical implementation of
 * submission finalization. Every invariant in Section 12 that concerns 'what happens at submit
 * time' is implemented exactly once here — the API route never contains this logic, and there is no
 * second code path that finalizes a submission differently."* So the route that calls this decides
 * only what to answer with, never what happens.
 *
 * The steps are Section 3's data flow, in its order:
 *
 *   1. lock the submission row (`SELECT … FOR UPDATE`)
 *   2. if it is already submitted → hand back the existing state (idempotent no-op)
 *   3. if a required section is incomplete → refuse, naming the sections
 *   4. score Grammar, Vocabulary, and Reading against the content version it was taken under
 *   5. write the scores, the status, and the Student Problems originals
 *   6. enqueue the processing jobs — all inside the same transaction
 *
 * ## Why the lock is the whole concurrency story
 *
 * Section 3 draws the check between a read and a write, which is the classic race: two submits can
 * both read `status='draft'` and both conclude they should finalize. The pre-check is not what stops
 * the second one — the row lock is. `FOR UPDATE` inside step 1 means the second caller blocks until
 * the first commits, and then *sees* the committed `'submitted'`; its pre-check is evaluating state
 * that can no longer change under it.
 *
 * This is what "relies on database-level uniqueness rather than application logic alone" means in
 * practice, and it is why the check and the write cannot be split across two transactions. Splitting
 * them would leave a window in which both callers have decided and neither has written.
 *
 * ## Why the frozen content version is guaranteed here rather than remembered
 *
 * Scoring resolves `submission.contentVersion` — the version frozen at draft creation — and never
 * `getCurrentVersion()`. That is not a rule this file has to remember: it is the only version it
 * ever has in hand, because the submission is what it reads. The same holds for background
 * evaluation later (Section 8). A submission scored against today's content would be scored against
 * questions its student never saw, and the failure would be invisible — the numbers would look
 * perfectly reasonable.
 */

/**
 * What a finalization did, or why it did nothing.
 *
 * A discriminated union rather than an exception, for the reason `StudentIdentityResolution` gives:
 * three of these four are ordinary product outcomes, not failures. "Already submitted" in particular
 * is *success* — Section 11 lists a double-clicked submit under "Treated as success — the existing
 * report is returned, not an error" — so it must not be modelled as a thrown refusal the caller has
 * to remember to catch and translate.
 *
 * `finalized` and `already_submitted` are kept distinct even though both carry a submission and both
 * are answered with the same report: the caller's response is identical, but the log line and the
 * test assertion are not, and a merge of the two would make "the second submit was a no-op"
 * unobservable.
 */
export type FinalizeResult =
  | { outcome: 'finalized'; submission: Submission }
  | { outcome: 'already_submitted'; submission: Submission }
  | { outcome: 'incomplete'; incompleteSections: SectionKey[] }
  | { outcome: 'not_found' };

export type SubmissionDeps = {
  submissions: SubmissionRepository;
  content: ContentLoader;
};

/**
 * Whether a stored answer for a question id is a real choice rather than a missing or blank one.
 *
 * An empty string is not an answer, which is the same reading `choiceAnswersSchema` allows and the
 * client's completeness gate already takes. The two sides have to agree about a submission — the
 * client decides whether to enable a button, the server decides whether to accept it — and a
 * disagreement would show up as a submit button that is enabled and then refused.
 */
function hasChoiceAnswer(chosen: ChoiceAnswers | undefined, questionId: string): boolean {
  const value = chosen?.[questionId];

  return typeof value === 'string' && value.length > 0;
}

/**
 * The required sections that are not finished (FR-ASSESS-007), in presentation order.
 *
 * ## The rule, and its one inference
 *
 * Grammar, Vocabulary, and Reading are complete when every question has a chosen option — every
 * question, including the ones in Reading's later passages. Writing is complete when the response
 * has something in it that is not whitespace, because a check whose purpose is that the student
 * wrote must not be satisfied by `"   "`. Student Problems is complete when every *statement* has a
 * scale response; the open-ended answer is deliberately not consulted, since FR-ASSESS-007 carves it
 * out as optional and EDGE-007 states that leaving it blank "must not block final submission on
 * this field".
 *
 * That the statements themselves are required is read from FR-ASSESS-007 naming only the open-ended
 * response as optional, and from `student-problems-statements.json` marking `openTextQuestion.
 * required: false` and nothing else. The PRD does not say so in those words, which makes this the
 * one product inference in the rule — the same one `frontend/src/assessmentCompleteness.ts` records
 * in the same place, on the other side of the wire.
 *
 * ## Why this is written twice, and how the two are kept honest
 *
 * The client has its own copy of this rule, and it has to: this one is server code and the browser
 * cannot run it. The client's copy decides only whether a button is enabled, and it says so — the
 * server is authoritative and the page surfaces a refusal rather than reconciling the two. So the
 * duplication is real but bounded, and the discipline it needs is that a change to one is a change
 * to both. Both files carry the rule in the same words for that reason.
 */
export function incompleteSections(
  content: ContentBundle,
  answers: DraftAnswers,
): SectionKey[] {
  return SECTION_KEYS.filter((section) => !isSectionComplete(section, content, answers));
}

function isSectionComplete(
  section: SectionKey,
  content: ContentBundle,
  answers: DraftAnswers,
): boolean {
  switch (section) {
    case 'grammar':
    case 'vocabulary':
    case 'reading': {
      const chosen = answers[section];
      const questions =
        section === 'reading'
          ? content.reading.passages.flatMap((passage) => passage.questions)
          : content[section].questions;

      return questions.every((question) => hasChoiceAnswer(chosen, question.id));
    }

    case 'writing':
      return (answers.writing?.essayText ?? '').trim().length > 0;

    case 'studentProblems': {
      const scale = answers.studentProblems?.likertAnswers;

      return content.studentProblems.statements.every(
        // Only the presence of a response is checked here. That it is one of the five points was
        // settled at the API boundary when it was saved (`studentProblemsAnswersSchema`), and
        // re-deciding a validated write is how the two would come to disagree.
        (statement) => typeof scale?.[statement.id] === 'number',
      );
    }
  }
}

/**
 * The student's open-ended Student Problems answer, or null when they did not give one.
 *
 * Whitespace alone is not an answer, matching how the Writing section is read: a check for "did they
 * write something" must not be satisfied by spaces.
 *
 * The value returned is the text *exactly as submitted*, untrimmed — FR-PROB-009 makes the original
 * the record, and trimming it here to test it and then storing the trimmed version would quietly
 * alter what the student wrote.
 */
function readOpenText(answers: DraftAnswers): string | null {
  const openText = answers.studentProblems?.openText;

  if (typeof openText !== 'string' || openText.trim().length === 0) return null;

  return openText;
}

export class SubmissionService {
  private readonly deps: SubmissionDeps;

  constructor(deps: SubmissionDeps) {
    this.deps = deps;
  }

  /**
   * Finalizes a draft, or reports why it did not.
   *
   * Idempotent: calling it on an already-submitted row is a no-op that returns the row, whether the
   * second call is a double-clicked button, a retried request, or a concurrent duplicate. Safe to
   * call from anywhere, because calling it twice is indistinguishable from calling it once.
   */
  async finalize(submissionId: string): Promise<FinalizeResult> {
    return this.deps.submissions.transaction(async (tx) => this.finalizeLocked(tx, submissionId));
  }

  /** Finalization's read-check-write, run inside the transaction that holds the row lock. */
  private async finalizeLocked(tx: SubmissionTx, submissionId: string): Promise<FinalizeResult> {
    const submission = await this.deps.submissions.lockById(tx, submissionId);

    if (!submission) return { outcome: 'not_found' };

    // Section 11: a duplicate submit is answered as success with the existing report, not refused.
    // Reading the row *after* the lock is what makes this check trustworthy — before it, another
    // transaction could commit between the read and the decision.
    if (submission.status === 'submitted') {
      return { outcome: 'already_submitted', submission };
    }

    // The frozen version, or nothing — never the current one (Section 12). `getContent` throws for a
    // version it does not hold rather than falling back, so a submission whose content has gone
    // missing fails loudly here instead of being scored against different questions.
    const content = this.deps.content.getContent(submission.contentVersion);

    // Every write to `answers` passed through `draftAutosaveBodySchema` (Section 12), which is the
    // single fact that makes this cast sound; the read path makes the same one, in
    // `toDraftAnswers`.
    const answers = submission.answers as DraftAnswers;

    const incomplete = incompleteSections(content, answers);
    if (incomplete.length > 0) {
      // Refused *before* anything is written, so an incomplete submit leaves the draft exactly as
      // the student left it — still editable, nothing enqueued, nothing scored.
      return { outcome: 'incomplete', incompleteSections: incomplete };
    }

    const scores = scoreDeterministicSections(answers, content);
    const openText = readOpenText(answers);

    const finalized = await this.writeFinalState(tx, submission.id, scores, answers, openText);
    await this.enqueueFinalizationJobs(tx, submission.id, openText);

    return { outcome: 'finalized', submission: finalized };
  }

  /** Step 5 — the write that makes the draft a submitted record. */
  private writeFinalState(
    tx: SubmissionTx,
    submissionId: string,
    scores: DeterministicScores,
    answers: DraftAnswers,
    openText: string | null,
  ): Promise<Submission> {
    return this.deps.submissions.markSubmitted(tx, submissionId, {
      grammarScore: scores.grammar.score,
      vocabularyScore: scores.vocabulary.score,
      readingScore: scores.reading.score,

      // The structured responses are lifted into their own column here, once, so that later analysis
      // reads them without having to know the shape of `answers` (Section 6). The section is
      // required and has just been checked complete, so this is populated.
      problemsLikertAnswers: answers.studentProblems?.likertAnswers ?? {},

      problemsOpenTextOriginal: openText,

      // Writing is always outstanding at this moment: the writing_eval job is enqueued below, and
      // T7.3.1 is what moves this off `pending`. Setting it is what flips the submission off the
      // `not_applicable` default, which is why the report can say "still being prepared" rather than
      // "not applicable" the instant a student submits.
      writingStatus: 'pending',

      // `not_applicable` is exactly what this enum value documents: no open-text answer was given, so
      // there is no text to process. It stays that way for the life of the submission.
      problemsTextStatus: openText === null ? 'not_applicable' : 'pending',
    });
  }

  /**
   * Step 6 — enqueues the jobs this submission's finalization creates.
   *
   * Inserted here, inside the finalize transaction, and not through E6's `JobService`: a job is part
   * of what "submitted" means, so a commit that recorded the submission without its jobs would leave
   * a submission nothing would ever evaluate. One transaction makes that state unrepresentable.
   *
   * The Student Problems job is created only when there is text to process. An empty job would be
   * claimed by the worker, evaluate nothing, and complete — the enum's `not_applicable` exists
   * precisely so that case is stated instead of worked around.
   */
  private enqueueFinalizationJobs(
    tx: SubmissionTx,
    submissionId: string,
    openText: string | null,
  ): Promise<void> {
    const jobTypes: string[] = [JOB_TYPES.writingEvaluation];

    if (openText !== null) jobTypes.push(JOB_TYPES.studentProblemsText);

    return this.deps.submissions.enqueueJobs(tx, submissionId, jobTypes);
  }
}

let instance: SubmissionService | undefined;

/**
 * The process-wide service, wired to the shared repository and content loader.
 *
 * Lazy, for the same reason `getContentLoader()` and `getStudentIdentityService()` are: importing
 * this module for its *type* must not read the content tree or open a database connection.
 */
export function getSubmissionService(): SubmissionService {
  instance ??= new SubmissionService({
    submissions: submissionRepository,
    content: getContentLoader(),
  });

  return instance;
}
