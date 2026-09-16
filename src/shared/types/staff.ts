import type { StudentProblemsCategory, WritingCorrection } from '../../ai/AIEvaluationService.ts';
import type { DraftAnswers } from './draft.ts';
import type { ProcessingStatus, SubmissionStatus } from './sections.ts';

/**
 * The staff wire contract (ARCHITECTURE Section 4 — `src/shared/types/`: "Types/schemas shared
 * between API and frontend"; PRD Section 9.7).
 *
 * ## What lives here, and what does not
 *
 * This module holds the responses a **route assembles from a row** — the individual submission
 * detail (T8.2.1) is the first. That is the same category as `StudentReport` in `draft.ts`, which
 * `src/api/student.routes.ts` builds by joining a `Submission` to the content it was taken under.
 *
 * The dashboard payload is deliberately **not** here. It is not assembled by a route at all —
 * `/api/staff/dashboard` passes `DashboardService`'s own answer straight through, and that answer
 * carries real domain content (the score bands, the conditional difficulty capability) that belongs
 * to the service that decides it. Types a service owns stay with the service; types a route
 * assembles are shared. The frontend imports the dashboard's type from `DashboardService.ts` with
 * `import type`, which is erased at build time and pulls nothing into the browser bundle.
 *
 * ## The privacy rule this module has to make unmissable
 *
 * FR-PROB-015 and NFR-PRIV-005 restrict all three forms of Student Problems data — the student's
 * original text, the AI's normalized representation, and the AI's categories — to authorized staff.
 * FR-PROB-011 additionally requires the derived forms to be *"clearly labeled as derived data — not
 * presented as the student's original words or as guaranteed fact."*
 *
 * That second requirement is why `openTextOriginal` and `textDerived` are separate fields under
 * separate names rather than one merged "text" field with a flag. A page cannot render them as one
 * thing without deliberately reaching for both, and the type says which is which.
 */

/** One rubric criterion's judgment, with the rubric's own label for it. */
export type StaffWritingCriterion = {
  /** The rubric's criterion key from the submission's frozen `contentVersion`. */
  key: string;
  /** The rubric's own wording for that key — never restated in code (Section 18). */
  label: string;
  score: number;
  rationale: string;
};

/**
 * The writing evaluation's qualitative feedback, as the model returned it (FR-WRITE-007).
 *
 * `corrections` reuses the AI boundary's own type rather than restating it: the stored feedback was
 * written from those fields by the provider, so a second definition would be a second thing to keep
 * in step with nothing gained. The same reasoning `draft.ts`'s `ReportWriting` gives.
 */
export type StaffWritingFeedback = {
  strengths: string[];
  weaknesses: string[];
  corrections: WritingCorrection[];
  suggestions: string[];
};

/**
 * One Student Problems statement, as this student answered it.
 *
 * A *statement response*, which is the student's own data (FR-PROB-005), joined to the wording it
 * was answered against. The wording is resolved from the submission's frozen `contentVersion`, so a
 * staff member reading an old submission sees the statement the student actually saw rather than
 * today's (Section 12).
 */
export type StaffProblemResponse = {
  statementId: string;
  /** The statement's wording, from the frozen bundle. */
  statement: string;
  area: string;
  /** The area's own label, or its id when the bundle does not name it. */
  areaLabel: string;
  /** 1–5 (FR-PROB-002). */
  value: number;
  /** That point's label from the instrument's scale, or null when the bundle does not name it. */
  valueLabel: string | null;
};

/**
 * The AI's reading of the student's open-text response — **derived data**, never the student's words
 * (FR-PROB-010/011).
 *
 * Both fields come from `problemsTextDerived`, which Section 6 keeps in its own column precisely so
 * it can never be confused with `problemsOpenTextOriginal`. The column is written once, by the
 * background worker, from a schema-validated model response; the original is written once, by
 * finalization, and never overwritten.
 */
export type StaffDerivedProblemsText = {
  /** An English normalization or translation of the response (FR-PROB-010). Derived, not original. */
  normalizedText: string;
  /** The difficulties the model identified. May be empty, which is an honest answer. */
  categories: StudentProblemsCategory[];
};

/**
 * One submission in full, for authorized staff (FR-STAFF-010).
 *
 * ## Why the raw columns are returned alongside the joined labels
 *
 * `answers` is the student's work exactly as stored, and `scores`, `writing`, and `studentProblems`
 * are the submission's own columns. The joined labelling — the statement wording, the criterion
 * labels, the scale's own words — is resolved from the frozen `contentVersion` because none of it
 * is stored on the row and all of it is needed to read the row at all.
 *
 * Both are present rather than only the joined form, because a staff member investigating a
 * disputed score needs what was stored, not a projection of it. The projection is a convenience;
 * the columns are the record.
 */
export type StaffSubmissionDetail = {
  id: string;
  cohort: { id: string; code: string; name: string };
  /** As the student typed it, preserved for display (Section 6). */
  rollNumber: string;
  studentName: string;
  status: SubmissionStatus;
  /** Frozen at draft creation; every label below resolves against this, never "current" (Section 12). */
  contentVersion: string;
  /** ISO 8601. */
  createdAt: string;
  /** ISO 8601, or null while the submission is still a draft. */
  submittedAt: string | null;

  /** Every section's saved answers, exactly as stored (Section 12's `answers` column shape). */
  answers: DraftAnswers;

  /**
   * The deterministic scores **as stored on the row** (Section 6), not recomputed.
   *
   * This is the opposite of the student report, which recomputes them from `answers` so it can also
   * show each question's explanation — see `StudentReport` in `draft.ts`. Here the stored columns
   * are what staff review, they are what the dashboard aggregates over, and recomputing them would
   * mean the two could disagree about a number a student has already been shown.
   */
  scores: {
    grammar: number | null;
    vocabulary: number | null;
    reading: number | null;
  };

  writing: {
    status: ProcessingStatus;
    /** The 0–100 computed by `WritingScoreCalculator` at evaluation time (FR-WRITE-006). */
    overallScore: number | null;
    /** Every rubric criterion in the stored evaluation, labelled from the frozen rubric. */
    criteria: StaffWritingCriterion[];
    feedback: StaffWritingFeedback | null;
  };

  studentProblems: {
    /** The five-point responses, joined to their statement wording (FR-PROB-005). */
    likert: StaffProblemResponse[];
    /**
     * The student's own words, exactly as submitted (FR-PROB-009).
     *
     * Read from `problemsOpenTextOriginal`. This is the authoritative record; the derived
     * representation below is not a substitute for it and is never shown in its place.
     */
    openTextOriginal: string | null;
    textStatus: ProcessingStatus;
    /** The AI's reading of the above — derived, and labelled as such (FR-PROB-011). */
    textDerived: StaffDerivedProblemsText | null;
  };
};
