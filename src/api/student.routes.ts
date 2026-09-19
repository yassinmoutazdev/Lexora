import express from 'express';
import type { Prisma, Submission } from '@prisma/client';
import type { WritingCorrection, WritingCriterionScore } from '../ai/AIEvaluationService.ts';
import { getStudentSession, studentSessionMiddleware } from '../auth/session.ts';
import {
  bandForScore,
  bandForSectionScore,
  getContentLoader,
  type ContentBundle,
} from '../content/ContentLoader.ts';
import type { Question } from '../content/contentSchemas.ts';
import { submissionRepository } from '../data/SubmissionRepository.ts';
import {
  scoreDeterministicSections,
  type SectionScore,
} from '../domain/scoring/DeterministicScoringService.ts';
import { getSubmissionService } from '../domain/submission/SubmissionService.ts';
import {
  draftAutosaveBodySchema,
  type AssessmentContent,
  type DraftAnswers,
  type DraftAutosaveBody,
  type ReportQuestion,
  type ReportSection,
  type ReportWriting,
  type ReportWritingCriterion,
  type StudentReport,
} from '../shared/types/draft.ts';
import { SECTION_KEYS } from '../shared/types/sections.ts';
import { requireStudentSession } from './middleware/requireStudentSession.ts';
import { UNAUTHORIZED_MESSAGE } from './middleware/requireSession.ts';
import { validateBody } from './middleware/validateBody.ts';

/**
 * The student router — the assessment and the report, for the one submission the session owns
 * (ARCHITECTURE Section 10, Section 18).
 *
 * ## There is no submission id in any path here
 *
 * The route is `/api/student/draft`, not `/api/student/submissions/:id/draft`. The active
 * submission is read from the session (`getStudentSession`) and from nowhere else, so a caller
 * cannot name a record — there is no parameter to guess, swap, or share. That absence *is* the
 * implementation of NFR-SEC-009 (Section 9), and it is the reason every route on this router can
 * treat "which submission?" as an already-answered question.
 *
 * ## Two independent drafts cannot be confused
 *
 * Because the session is scoped to exactly one submission at issuance (Section 1), a session issued
 * while one draft was open cannot be spent on another. The route never has to verify that the
 * caller is entitled to the row it looks up: the row is the entitlement.
 */

/**
 * The refusal for a write that arrives against a record that is no longer a draft.
 *
 * Unlike an identity refusal this names no secret: it is the student's own submission, and the
 * fact that it is submitted is already public to them (`student-verify` reports the same status).
 * Saying so plainly is what lets the SPA explain the screen instead of showing a generic failure.
 */
const SUBMITTED_NO_EDIT_MESSAGE =
  'This assessment has already been submitted, so it can no longer be changed';

/**
 * The refusal for a report requested before there is one.
 *
 * Like the message above, it names nothing secret: it is the student's own assessment, and whether
 * they have submitted it is already theirs to know (`student-verify` reports the same status). It
 * exists so the SPA can send them back to finish rather than showing a failure.
 */
const NOT_SUBMITTED_MESSAGE =
  'This assessment has not been submitted yet, so there is no report to show';

export const studentRouter = express.Router();

// Mounted on this router rather than globally, for the reason Section 9 gives: a staff session is
// meaningless on a student route and vice versa, and the two access boundaries must never merge.
studentRouter.use(studentSessionMiddleware);

/**
 * The draft, with the content it was created under.
 *
 * Returns the saved answers and the content bundle for the submission's own `contentVersion` — the
 * version frozen at draft creation, never "current" (Section 12). A student who started under `v1`
 * keeps answering `v1` questions even after `v2` becomes current, which is what makes historical
 * interpretability (FR-CONTENT-001/003) a property of the read path rather than a hopeful one: this
 * route asks `getContent(version)`, and that call *throws* for a version it does not hold instead of
 * falling back (see `ContentLoader.getContent`).
 *
 * `status` is returned rather than enforced here. A submitted student is not refused — they are
 * told, so the SPA can put them on `/report` (Section 9). Rejecting the read instead would leave a
 * returning student with an error where their report should be; rejecting *writes* to a submitted
 * record is the separate guarantee the PATCH route owns (Section 12).
 */
studentRouter.get('/draft', requireStudentSession, async (req, res, next) => {
  try {
    // `requireStudentSession` has already refused a request without one, so this cannot be null —
    // but it is read rather than asserted, so the handler stays correct if the guard is ever
    // rearranged, and the compiler is told the truth instead of being overruled.
    const session = getStudentSession(req);

    if (!session) {
      res.status(401).json({ error: UNAUTHORIZED_MESSAGE });
      return;
    }

    const submission = await submissionRepository.findById(session.submissionId);

    // The session is signed and names a row that no longer exists. Nothing deletes submissions in
    // this system, so this is a data-integrity anomaly rather than a plausible client error — but
    // from the caller's side the remedy is exactly the one for holding no session at all (verify
    // identity again), so it is answered identically rather than with a second client path.
    if (!submission) {
      res.status(401).json({ error: UNAUTHORIZED_MESSAGE });
      return;
    }

    res.json({
      status: submission.status,
      contentVersion: submission.contentVersion,
      content: toAssessmentContent(getContentLoader().getContent(submission.contentVersion)),
      answers: toDraftAnswers(submission.answers),
    });
  } catch (error) {
    // Express 4 does not forward rejections from an async handler on its own, so an unhandled
    // error here would hang the request rather than reach the error handler.
    next(error);
  }
});

/**
 * Autosave: merge **one** section's answers into the draft (ARCHITECTURE Section 12).
 *
 * The body names a single section and carries only that section's answers — never the whole
 * `answers` object. That restriction is the entire design: a request that could send the whole
 * document would make every save a full overwrite, and two tabs open on different sections would
 * silently clobber one another. Under a section-keyed merge they cannot, because the two writes
 * touch different keys (Section 12, and the concurrency cases it enumerates).
 *
 * The refusal for a non-draft record is a 409 *and not a no-op success*. Section 11 treats a
 * duplicate **submit** as success — the student clicked twice and should see their report — but a
 * write that arrives after submission is a different thing: it is either a stale tab that has been
 * open since before the student submitted, or an attempt to edit an immutable record. Silently
 * accepting it would leave a client believing unsaved work had been stored. The status is reported
 * so the SPA can move that tab to the report (Section 9).
 *
 * `validateBody` runs first, so by the time the merge is reached the section key is one of the five
 * and the answers match that section's shape (Section 10 — "malformed input never reaches business
 * logic"). This is not a formality for this endpoint: the section key becomes a *key* in the JSONB
 * column, so an unchecked one would not be a bad value in a field, it would be a new field.
 */
studentRouter.patch(
  '/draft',
  requireStudentSession,
  validateBody(draftAutosaveBodySchema),
  async (req, res, next) => {
    try {
      const session = getStudentSession(req);

      if (!session) {
        res.status(401).json({ error: UNAUTHORIZED_MESSAGE });
        return;
      }

      // `validateBody` replaced `req.body` with the schema's output, so this is the parsed body and
      // not the raw payload: `section` is one of the five real keys and `sectionAnswers` carries
      // that section's shape. No re-checking below, and no second opinion about the request's shape.
      const { section, sectionAnswers } = req.body as DraftAutosaveBody;

      const result = await submissionRepository.mergeSectionAnswers(
        session.submissionId,
        section,
        sectionAnswers,
      );

      if (result.outcome === 'not_found') {
        res.status(401).json({ error: UNAUTHORIZED_MESSAGE });
        return;
      }

      if (result.outcome === 'not_draft') {
        res.status(409).json({ error: SUBMITTED_NO_EDIT_MESSAGE });
        return;
      }

      // The section is echoed back so a client can tell which save it is looking at the result of —
      // with several sections autosaving through one endpoint, "saved" without a subject is exactly
      // the acknowledgement a debounce bug would hide behind.
      res.json({ status: 'saved', section });
    } catch (error) {
      next(error);
    }
  },
);

/**
 * Submitting the assessment (ARCHITECTURE Section 10, Section 3).
 *
 * The body is empty and nothing here reads one: `SubmissionService.finalize` resolves everything it
 * needs from the session's submission, so there is no field a caller could use to name a different
 * record or to assert a state the record is not in. That absence is the same one NFR-SEC-009 is
 * about, and it is why this route needs no `validateBody` — there is no input to validate.
 *
 * Three ways this answers, and the reasoning for each:
 *
 * - **Already submitted → 200 with the existing report.** Section 11 lists a double-clicked submit
 *   under "Treated as success — the existing report is returned, not an error", and a student whose
 *   request was retried by a flaky connection has done nothing wrong.
 * - **Incomplete → 400 naming the unfinished sections.** The client already gates its submit button
 *   on the same rule (FR-ASSESS-007), so reaching this means a stale tab or a client bug rather than
 *   a student who ignored a prompt — but the refusal still has to say *which* sections, because the
 *   point of a server-authoritative rule is that the server can explain it.
 * - **No such submission → 401.** The session is signed and names a row that no longer exists,
 *   which for the caller has the same remedy as holding no session at all.
 */
studentRouter.post('/submit', requireStudentSession, async (req, res, next) => {
  try {
    const session = getStudentSession(req);

    if (!session) {
      res.status(401).json({ error: UNAUTHORIZED_MESSAGE });
      return;
    }

    const result = await getSubmissionService().finalize(session.submissionId);

    switch (result.outcome) {
      case 'not_found':
        res.status(401).json({ error: UNAUTHORIZED_MESSAGE });
        return;

      case 'incomplete':
        res.status(400).json({
          error: 'Some sections are not finished yet, so this assessment cannot be submitted',
          incompleteSections: result.incompleteSections,
        });
        return;

      case 'finalized':
      case 'already_submitted':
        // Both are success, and both answer with the report — the student sees the same screen
        // whether this was their first click or their third.
        res.json(toStudentReport(result.submission));
        return;
    }
  } catch (error) {
    next(error);
  }
});

/**
 * The report (ARCHITECTURE Section 7, Section 10).
 *
 * Reads the submission the session owns and shapes it — Section 7's "there is no separate 'report'
 * entity", made literal: this route stores nothing and computes nothing that is not a pure function
 * of the row and the content it was taken under.
 *
 * ## A draft has no report
 *
 * An unsubmitted assessment is refused rather than answered with an empty report, for two reasons
 * that point the same way. PRD Section 13 lists a draft as "not a 'result' state" — there is no
 * result to show yet. And FR-DET-003 ties the section scores to submission: serving them earlier
 * would let a student read their marks before the transition that makes them final, which is the
 * one thing the draft/submitted split exists to prevent.
 *
 * 409 rather than 404, because the submission does exist and the caller is entitled to it — what is
 * wrong is its state, which is the same shape of refusal the autosave route gives a submitted
 * record. The SPA's own routing already keeps drafts on `/assessment` (Section 9); this is the
 * server's independent answer for anyone who arrives here directly.
 *
 * ## It never waits on anything
 *
 * Nothing in this handler calls an AI service or touches a job. The deterministic sections are a
 * pure function of `answers` and content, both already in hand; the two processing statuses are
 * columns on the row. So the report is complete the instant a submission is finalized
 * (FR-FEEDBACK-001), and the page can poll this same route to watch those statuses move
 * (FR-FEEDBACK-003/004).
 */
studentRouter.get('/report', requireStudentSession, async (req, res, next) => {
  try {
    const session = getStudentSession(req);

    if (!session) {
      res.status(401).json({ error: UNAUTHORIZED_MESSAGE });
      return;
    }

    const submission = await submissionRepository.findById(session.submissionId);

    if (!submission) {
      res.status(401).json({ error: UNAUTHORIZED_MESSAGE });
      return;
    }

    if (submission.status !== 'submitted') {
      res.status(409).json({ error: NOT_SUBMITTED_MESSAGE });
      return;
    }

    res.json(toStudentReport(submission));
  } catch (error) {
    next(error);
  }
});

/** The student-facing projection of a content bundle. See `AssessmentContent` for what is left out. */
function toAssessmentContent(bundle: ContentBundle): AssessmentContent {
  return {
    grammar: bundle.grammar,
    vocabulary: bundle.vocabulary,
    reading: bundle.reading,
    writing: bundle.writingPrompt,
    studentProblems: bundle.studentProblems,
  };
}

/**
 * Narrows the stored `answers` to the section-keyed contract the client is written against.
 *
 * Two things happen here, and only the first is a guarantee.
 *
 * **The guarantee:** the response is an object carrying only section keys, with nothing invented
 * for a section that has never been saved. The column is JSONB, so what comes back is whatever was
 * last written into it; the section filter is what stops a key written by some future code path
 * from reaching a frontend that believes the key set is closed.
 *
 * **The assertion:** the *values* are typed as the section answer shapes rather than as `unknown`.
 * That rests on one fact — `draftAutosaveBodySchema` validates every write to this column — and
 * this cast is the single place in the codebase where that assumption is made, so it is visible
 * rather than repeated at every reader. Nothing here re-validates our own writes: deep-checking
 * data on the way out of the database it was validated into would buy nothing and cost a parse per
 * section per page load.
 */
function toDraftAnswers(answers: unknown): DraftAnswers {
  if (typeof answers !== 'object' || answers === null || Array.isArray(answers)) return {};

  const stored = answers as Record<string, unknown>;
  const selected: Record<string, unknown> = {};

  for (const key of SECTION_KEYS) {
    if (key in stored) selected[key] = stored[key];
  }

  return selected as DraftAnswers;
}

/**
 * Shapes a submission row into the report a student reads (ARCHITECTURE Section 7, Section 10).
 *
 * Section 7 is explicit that there is no report artifact: this function *is* report generation, and
 * both routes that answer with a report call it, so a student sees the identical screen whether
 * they arrived by submitting or by returning later (FR-FEEDBACK-005).
 *
 * ## Why the deterministic sections are scored here rather than read from the columns
 *
 * The row carries `grammarScore`, `vocabularyScore`, and `readingScore`. This recomputes them from
 * `answers` and the frozen content instead of reading them, and the reason is the explanations: the
 * report must show a prewritten explanation per question (FR-DET-004), and those live in the
 * content bundle, not on the row. Recomputing gets the breakdown and the totals from one source;
 * reading the columns and scoring separately would be two sources for one number.
 *
 * Nothing is at risk from that, because scoring is a pure function of (answers, content) — the same
 * inputs the columns were written from (Section 12). The columns keep their own purpose, which is
 * the staff aggregate queries that must not re-read every submission's content (E8).
 *
 * The content version is the one frozen on the row, never the current one. `getContent` throws for a
 * version it does not hold, which is the loud failure Section 12 asks for: a report rendered against
 * the wrong content would show a student questions they were never asked.
 */
function toStudentReport(submission: Submission): StudentReport {
  const content = getContentLoader().getContent(submission.contentVersion);

  // The same single-justification cast `toDraftAnswers` makes: every write to this column passed
  // through `draftAutosaveBodySchema`.
  const answers = submission.answers as DraftAnswers;
  const scores = scoreDeterministicSections(answers, content);

  return {
    contentVersion: submission.contentVersion,
    submittedAt: submission.submittedAt?.toISOString() ?? null,
    deterministic: {
      grammar: toReportSection(
        'grammar',
        content.grammar.title,
        content.grammar.questions,
        scores.grammar,
        content,
      ),
      vocabulary: toReportSection(
        'vocabulary',
        content.vocabulary.title,
        content.vocabulary.questions,
        scores.vocabulary,
        content,
      ),
      reading: toReportSection(
        'reading',
        content.reading.title,
        content.reading.passages.flatMap((passage) => passage.questions),
        scores.reading,
        content,
      ),
    },
    writingStatus: submission.writingStatus,
    writing: toReportWriting(submission, content),
    problemsTextStatus: submission.problemsTextStatus,
  };
}

/**
 * The finished writing evaluation, or null while there is not one to show (FR-WRITE-006/007,
 * FR-FEEDBACK-004/007).
 *
 * ## Why this reads the columns instead of recomputing
 *
 * Everything else in `toStudentReport` is recomputed from `answers` and content, because those
 * numbers are a pure function of both (Section 12). This is the opposite case and deliberately so:
 * the criterion scores are a *model's judgment* and the overall is the calculator's output — neither
 * is derivable from anything the report holds. The row is the record, and this reads it.
 *
 * ## Why the criteria are ordered and labelled from content
 *
 * The stored `writingCriteriaScores` is a keyed object, and a key has no label and no order. Both
 * come from `writing-rubric.json`'s `criteria` array in the submission's **frozen** version — the
 * same file the prompt was built from and the weights came from. So a report is always labelled in
 * the rubric's own words for the rubric the response was actually graded against.
 *
 * ## The three columns are read as one fact
 *
 * A `succeeded` row carries all three — `recordWritingEvaluation` writes them in a single statement,
 * and the overall score cannot be computed at all unless every weighted criterion is present
 * (T7.3.1). A row missing one is therefore not a row any code path in this system produces, and this
 * returns null rather than rendering a partial evaluation. Null means the page says the feedback
 * could not be prepared — the same thing it says for `failed_needs_review` — which is the honest
 * description of a report with nothing in it, and keeps the deterministic results visible rather
 * than failing the whole response over one inconsistent column (FR-FEEDBACK-007).
 */
function toReportWriting(submission: Submission, content: ContentBundle): ReportWriting | null {
  if (submission.writingStatus !== 'succeeded') return null;

  const overallScore = submission.writingOverallScore;
  const scores = toCriterionScores(submission.writingCriteriaScores);
  const feedback = toWritingFeedback(submission.writingFeedback);

  if (overallScore === null || scores === null || feedback === null) return null;

  const criteria = content.writingRubric.criteria.flatMap((criterion): ReportWritingCriterion[] => {
    const scored = scores[criterion.key];

    // A criterion the rubric names with no stored score is dropped, exactly as `toReportSection`
    // drops a question with no outcome: there is nothing to show and nothing honest to invent. It
    // cannot happen for a `succeeded` row, for the reason the doc comment gives.
    if (!scored) return [];

    const placement = bandForScore(content.writingRubric, criterion.key, scored.score);

    return [
      {
        key: criterion.key,
        label: criterion.label,
        score: scored.score,
        rationale: scored.rationale,
        band: placement.band,
        bandDescriptor: placement.descriptor,
      },
    ];
  });

  return {
    overallScore,
    criteria,
    ...feedback,
    maxCorrections: content.writingRubric.outputRequirements.maxCorrections,
  };
}

/**
 * The stored criterion scores, or null when the column is not the shape evaluation writes.
 *
 * A narrowing rather than a schema validation, for the reason `toDraftAnswers` gives: this reads
 * data this system wrote, and re-validating our own writes on the way out would cost a parse per
 * report for nothing. What it does check is the shape it is about to *index*, so a column that is
 * not the expected object cannot become a silently empty criteria list.
 */
function toCriterionScores(stored: Prisma.JsonValue): Record<string, WritingCriterionScore> | null {
  if (typeof stored !== 'object' || stored === null || Array.isArray(stored)) return null;

  const scores: Record<string, WritingCriterionScore> = {};

  for (const [key, value] of Object.entries(stored)) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;

    const { score, rationale } = value as { score?: unknown; rationale?: unknown };

    if (typeof score !== 'number' || typeof rationale !== 'string') return null;

    scores[key] = { score, rationale };
  }

  return scores;
}

/**
 * The four stored feedback lists, or null when the column is not the shape evaluation writes.
 *
 * All four are required together: `writingFeedback` is written once, from one evaluation, and a
 * report showing strengths without weaknesses would be a partial reading of a single judgment.
 */
function toWritingFeedback(
  stored: Prisma.JsonValue,
): Pick<ReportWriting, 'strengths' | 'weaknesses' | 'corrections' | 'suggestions'> | null {
  if (typeof stored !== 'object' || stored === null || Array.isArray(stored)) return null;

  const { strengths, weaknesses, corrections, suggestions } = stored as Record<string, unknown>;

  if (!isStringArray(strengths)) return null;
  if (!isStringArray(weaknesses)) return null;
  if (!isStringArray(suggestions)) return null;
  if (!isCorrectionArray(corrections)) return null;

  return { strengths, weaknesses, corrections, suggestions };
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function isCorrectionArray(value: unknown): value is WritingCorrection[] {
  return (
    Array.isArray(value) &&
    value.every(
      (entry) =>
        typeof entry === 'object' &&
        entry !== null &&
        typeof (entry as WritingCorrection).original === 'string' &&
        typeof (entry as WritingCorrection).corrected === 'string' &&
        typeof (entry as WritingCorrection).explanation === 'string',
    )
  );
}

/**
 * Joins a section's content with its scored outcomes into what the report displays.
 *
 * Iterating the *questions* and looking each outcome up, rather than the other way round, is what
 * guarantees every entry has a prompt — a question is only renderable with its own text, and the
 * lookup only fails in the one case that cannot happen: scoring derives its outcomes from this same
 * list of questions, for this same content version.
 */
function toReportSection(
  sectionKey: 'grammar' | 'vocabulary' | 'reading',
  title: string,
  questions: Question[],
  scored: SectionScore,
  content: ContentBundle,
): ReportSection {
  const outcomeById = new Map(scored.questions.map((outcome) => [outcome.questionId, outcome]));

  const entries = questions.flatMap((question): ReportQuestion[] => {
    const outcome = outcomeById.get(question.id);

    if (!outcome) return [];

    return [
      {
        questionId: question.id,
        prompt: question.prompt,
        givenAnswer: outcome.givenAnswer,
        givenAnswerText: optionText(question, outcome.givenAnswer),
        correctAnswer: outcome.correctAnswer,
        correctAnswerText: optionText(question, outcome.correctAnswer),
        correct: outcome.correct,
        explanation: outcome.explanation,
      },
    ];
  });

  // A section with zero points possible cannot happen — `questionsArraySchema` requires at least
  // one question and every question's `points` is a positive integer — but dividing by a `maxScore`
  // of 0 would be silent NaN rather than a loud failure, so this is explicit about the precondition
  // `bandForSectionScore` depends on.
  const percent = scored.maxScore > 0 ? (scored.score / scored.maxScore) * 100 : 0;
  const placement = bandForSectionScore(content.sectionBands, sectionKey, percent);

  return {
    title,
    score: scored.score,
    maxScore: scored.maxScore,
    questions: entries,
    band: placement.band,
    bandDescriptor: placement.descriptor,
  };
}

/**
 * The text of one of a question's options, or null when there is no such option.
 *
 * Null for an unanswered question, and null for an answer that names no option — a value the
 * autosave schema accepts (any string is a valid choice answer) and that scoring already treats as
 * incorrect. The report shows the stored id in that case rather than pretending the answer was
 * blank; see `ReportQuestion`.
 */
function optionText(question: Question, optionId: string | null): string | null {
  if (optionId === null) return null;

  return question.options?.find((option) => option.id === optionId)?.text ?? null;
}
