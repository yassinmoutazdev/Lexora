import { z } from 'zod';
import type { WritingCorrection } from '../../ai/AIEvaluationService.ts';
import type {
  DeterministicSectionFile,
  ReadingFile,
  StudentProblemsFile,
  WritingPromptFile,
} from '../../content/contentSchemas.ts';
// The section vocabulary lives in a zod-free sibling so that a frontend importing `SECTION_KEYS`
// does not drag this module's validator into the browser bundle — see `sections.ts`.
import type { ProcessingStatus, SectionKey, SubmissionStatus } from './sections.ts';

/**
 * The content *types* (`Question`, `ReadingFile`, and the rest) are re-exported, so that the
 * frontend has one import root for the wire contract instead of reaching into `src/content/`, whose
 * other export — the schemas that validate the content files at boot — is none of its business.
 *
 * Type-only, and therefore erased: importing this module never puts the content schemas, or `zod`,
 * into the browser bundle.
 */
export type * from '../../content/contentSchemas.ts';

/**
 * The draft contract shared by the API and the assessment UI (ARCHITECTURE Section 4 —
 * `src/shared/types/`: "Types/schemas shared between API and frontend").
 *
 * This module is the single written-down description of what `GET /api/student/draft` answers with
 * and what `PATCH /api/student/draft` accepts (Section 10). Both sides import it, so a change to
 * the wire shape is one edit that fails to compile on whichever side did not keep up — rather than
 * two shapes that agree until the day they silently stop.
 *
 * ## Two things this module is not
 *
 * It is **not** a second copy of the assessment content: the question and statement *types* are
 * imported from `src/content/contentSchemas.ts`, which owns them because it validates the files at
 * boot. What is defined here is the *wire* — which sections exist, and what a student's answers in
 * each one look like.
 *
 * It is **not** where answers are scored. The schemas below check the *shape* of what arrives, not
 * its correctness: whether `'b'` is the right answer to a question is decided against content, at
 * scoring time (E5), by the service that owns that rule (Section 7).
 *
 * ## This module is imported type-only by the frontend
 *
 * It imports `zod`, so a *value* import from here puts the validator in the browser bundle. The
 * section vocabulary the SPA needs at runtime lives in `sections.ts`, which has no dependencies.
 */

/**
 * Grammar, Vocabulary, and Reading: the question id answered, and the option id chosen.
 *
 * A map keyed by question id, because that is how scoring reads it back (Section 7 — "a student's
 * `answers.grammar/vocabulary/reading` plus the loaded content"). Answering a question again
 * replaces its entry; an unanswered question is simply absent, which is a state the report can
 * describe ("not answered") without inventing a sentinel value for it.
 *
 * The values are not checked against the content's option ids here, and deliberately so: which
 * options exist depends on the submission's frozen `contentVersion`, which this module knows
 * nothing about. A value that matches no option scores as incorrect, which is the correct answer
 * to "the student selected something that is not an option".
 */
export const choiceAnswersSchema = z.record(z.string(), z.string());

/**
 * Writing: one open-ended free-writing task and nothing else (FR-WRITE-001/002).
 *
 * `essayText` is the key the rest of the system already reads it by — `getEvaluationContext`
 * resolves a writing job's text from `answers.writing.essayText` (ARCHITECTURE Section 8).
 *
 * It is optional because a section can be legitimately empty: a student who has opened Writing and
 * typed nothing yet still has a Writing section, and an autosave of it must not be an error.
 */
export const writingAnswersSchema = z
  .object({
    essayText: z.string().optional(),
  })
  .strict();

/**
 * Student Problems: the five-point scale responses, plus the optional open-ended answer.
 *
 * Kept as two fields under one section rather than flattened, because FR-PROB-005 requires the
 * structured scale responses and the free text to be preserved *distinctly* — they are analysed
 * differently, and the open text is the one that leaves this system for AI processing.
 *
 * `likertAnswers` is keyed by statement id, mirroring the `problemsLikertAnswers` column
 * (ARCHITECTURE Section 6). The 1–5 range is FR-PROB-002's approved five-point agreement scale — a
 * product rule, not a content value, which is why it is stated here rather than read from the
 * versioned bundle. `student-problems-statements.json` independently validates that its own scale
 * is exactly those five points.
 *
 * `openText` accepts any string, in either language, including the empty string: FR-ASSESS-007
 * makes the open-ended question optional, so clearing it is a normal thing for a student to do and
 * must not be rejected as malformed. Nothing here filters or redacts it — the PRD scopes that out
 * and makes the privacy notice the mitigation (NFR-PRIV-009).
 */
export const studentProblemsAnswersSchema = z
  .object({
    likertAnswers: z.record(z.string(), z.number().int().min(1).max(5)).optional(),
    openText: z.string().optional(),
  })
  .strict();

export type ChoiceAnswers = z.infer<typeof choiceAnswersSchema>;
export type WritingAnswers = z.infer<typeof writingAnswersSchema>;
export type StudentProblemsAnswers = z.infer<typeof studentProblemsAnswersSchema>;

/**
 * The saved answers, section-keyed — exactly the shape of the `answers` JSONB column (Section 6).
 *
 * Typed as the section shapes above rather than as `unknown`, on the strength of a single fact:
 * *every* write to that column passes through `draftAutosaveBodySchema` below. That is what makes
 * the read type sound, and it is asserted in exactly one place — `toDraftAnswers` in
 * `src/api/student.routes.ts` — so the assumption is visible rather than spread across every
 * reader.
 */
export type DraftAnswers = {
  grammar?: ChoiceAnswers;
  vocabulary?: ChoiceAnswers;
  reading?: ChoiceAnswers;
  writing?: WritingAnswers;
  studentProblems?: StudentProblemsAnswers;
};

/**
 * The content the assessment UI is served, for the draft's frozen `contentVersion`.
 *
 * A projection of the full content bundle rather than the bundle itself: the AI's rubric
 * instructions and scoring weights (ARCHITECTURE Section 18 — `writing-rubric.json`) are inputs to
 * background evaluation, not to a page a student is looking at, and there is no reason to put the
 * prompt the model is graded against in front of the student who is being graded with it.
 */
export type AssessmentContent = {
  grammar: DeterministicSectionFile;
  vocabulary: DeterministicSectionFile;
  reading: ReadingFile;
  writing: WritingPromptFile;
  studentProblems: StudentProblemsFile;
};

/** The body of `GET /api/student/draft` (ARCHITECTURE Section 10). */
export type StudentDraft = {
  /**
   * `draft` for an assessment in progress, `submitted` for one already finalized (FR-STU-006).
   * The server reports it and the SPA routes on it — a `submitted` student belongs on `/report`,
   * never back in the assessment (Section 9).
   */
  status: SubmissionStatus;
  /** The version frozen at draft creation (Section 12). Content below resolves against this. */
  contentVersion: string;
  content: AssessmentContent;
  answers: DraftAnswers;
};

/**
 * The body of `POST /api/student/submit` and `GET /api/student/report` (ARCHITECTURE Section 10).
 *
 * One type for both, because they answer with the same thing: Section 3 ends the submit flow at
 * "Response: submission report", and Section 7 states plainly that there is no separate report
 * artifact — the endpoint reads the submission row and shapes it. Two types here would be two
 * descriptions of one response, which is how a page and its endpoint come to disagree.
 *
 * There is no `status` field, because a report exists only for a submission that has one: an
 * unsubmitted assessment has no results, and PRD Section 13 lists a draft as "not a 'result'
 * state". Reaching the report route with a draft is refused rather than answered with an empty
 * report, so the state a `status` field would carry is already settled by the response being a
 * response at all.
 *
 * ## Deterministic results are recomputed, not read back
 *
 * `deterministic` is scored from `answers` against the frozen `contentVersion` at the moment the
 * report is built — not read from the `grammarScore`/`vocabularyScore`/`readingScore` columns.
 * Scoring is a pure function of (answers, content), so the two agree by construction; the
 * recomputation is what makes the per-question explanations (FR-DET-004) available at all, since
 * those live in content and are not stored on the row. The columns remain the record for the staff
 * aggregate queries that must not re-read content (E8).
 *
 * `writingStatus`/`problemsTextStatus` *are* read from the row — they are background state, not a
 * function of anything the report can compute, and they are what lets the page say "still being
 * prepared" (FR-FEEDBACK-004) instead of implying the report is complete (FR-FEEDBACK-008).
 */
export type StudentReport = {
  contentVersion: string;
  /** ISO 8601, or null while the submission is still a draft. */
  submittedAt: string | null;
  /**
   * Grammar, Vocabulary, and Reading — immediate, and independent of any AI call (FR-FEEDBACK-001).
   *
   * Keyed by section, as everywhere else in this module. The three keys are
   * `DETERMINISTIC_SECTION_KEYS`, which is the runtime list a page iterates.
   */
  deterministic: {
    grammar: ReportSection;
    vocabulary: ReportSection;
    reading: ReportSection;
  };
  /** Where the Writing evaluation has got to (FR-FEEDBACK-002/004/007). */
  writingStatus: ProcessingStatus;
  /**
   * The finished writing evaluation, or null when there is not one to show (FR-WRITE-006/007).
   *
   * Non-null exactly when `writingStatus` is `succeeded`, and the pairing is why both are here
   * rather than one being derivable from the other. `writingStatus` is what the page polls on and
   * what tells a student "still being prepared" apart from "we could not prepare this"; `writing`
   * is the feedback itself. A page that switched on the status alone would have to claim a result
   * the response does not carry.
   *
   * Nothing in here is computed by the report. The overall score was computed once by
   * `WritingScoreCalculator` and stored; the criterion labels come from the rubric in the
   * submission's frozen `contentVersion`, looked up by key rather than restated, so a criterion can
   * never be labelled with another version's wording.
   */
  writing: ReportWriting | null;
  /**
   * Where the Student Problems text processing has got to; `not_applicable` when no text was given.
   *
   * Sent because the report describes the submission, not because the student reads it: FR-PROB-007
   * puts the Learning Difficulties view out of MVP scope, and staff see this data through the
   * dashboard instead (E8).
   */
  problemsTextStatus: ProcessingStatus;
};

/**
 * One criterion's judgment, as the report displays it (FR-WRITE-005).
 *
 * `label` is the rubric's own wording and `key` is its own key, both read from the submission's
 * frozen content version. Neither is spelled out in this module, because the five approved criteria
 * live in `writing-rubric.json` and a second copy here would be a list that can drift from the one
 * the model is actually asked about.
 */
export type ReportWritingCriterion = {
  key: string;
  label: string;
  score: number;
  rationale: string;
  /**
   * Where this score falls on the rubric's band scale (`ContentLoader.bandForScore`), and what that
   * band means for this criterion specifically.
   *
   * Added so a score is never shown as a bare number: `writing-rubric.json`'s band descriptors
   * already exist to anchor the model's judgement, and the same text anchors the student's reading
   * of it — "62" says little on its own, "62 — Competent: ..." says what a 62 actually looks like.
   */
  band: string;
  bandDescriptor: string;
};

/**
 * A finished writing evaluation as the report shows it (FR-WRITE-006/007).
 *
 * The shape mirrors `writingFeedback`'s four lists, and `corrections` reuses the AI boundary's own
 * type rather than restating it: the stored feedback was written from those fields, so a second
 * definition would be a second thing to keep in step with nothing gained.
 */
export type ReportWriting = {
  /** The 0–100 overall, computed by `WritingScoreCalculator` at evaluation time (FR-WRITE-006). */
  overallScore: number;
  /** Every rubric criterion, in the rubric's own order. */
  criteria: ReportWritingCriterion[];
  strengths: string[];
  weaknesses: string[];
  corrections: WritingCorrection[];
  /**
   * The rubric's cap on `corrections` (`writing-rubric.json`'s `outputRequirements.maxCorrections`),
   * carried through so the report can tell the honest difference between "here is every error worth
   * noting" (`corrections.length < maxCorrections`) and "here are the most important errors, and
   * there may be more" (`corrections.length === maxCorrections`) — rather than a student reading a
   * capped list as an exhaustive one.
   */
  maxCorrections: number;
  suggestions: string[];
};

/**
 * One section of the report: its score, and every question in it.
 *
 * ## Why this is not the scorer's `SectionScore`
 *
 * `DeterministicScoringService` answers "what did this score". A report answers "what should the
 * student read", and that needs the question's own text and the chosen option's text — neither of
 * which scoring has any use for, and both of which live in the content bundle. The route joins the
 * two, which is exactly Section 7's "the endpoint simply reads the Submission row and shapes it
 * into a response"; putting display fields on the scorer's output instead would make every caller
 * of scoring carry content it does not read.
 *
 * `title` is the content's own section title, so a heading can never name a section differently
 * from the section it belongs to.
 */
export type ReportSection = {
  title: string;
  score: number;
  maxScore: number;
  questions: ReportQuestion[];
  /**
   * Where this section's score falls on the shared Grammar/Vocabulary/Reading band scale
   * (`ContentLoader.bandForSectionScore`, `content/section-bands.json`), and that band's own text
   * for this specific section.
   *
   * Added for the same reason `ReportWritingCriterion.band`/`bandDescriptor` were: `score`/`maxScore`
   * alone is a bare percentage with no anchor for what it means, and a student reading "62%" gets
   * far less than a student reading "62% — Developing: ...".
   */
  band: string;
  bandDescriptor: string;
};

/**
 * One question as the report shows it (FR-DET-004).
 *
 * Every question in the section appears, answered or not: an explanation is what a student who
 * skipped a question most needs, and the section's `score` out of `maxScore` is only meaningful
 * beside the questions it was computed from.
 *
 * The answer texts are carried alongside the ids rather than instead of them because the two say
 * different things. An id that matches no option — which the autosave schema permits — has no text,
 * and the report has to be able to say what was actually stored rather than print nothing.
 */
export type ReportQuestion = {
  questionId: string;
  prompt: string;
  /** The option id the student chose, or null when they did not answer. */
  givenAnswer: string | null;
  /** That option's text, or null when there is no answer or it names no option. */
  givenAnswerText: string | null;
  correctAnswer: string;
  /** The answer key's option text; null only if the content were internally inconsistent. */
  correctAnswerText: string | null;
  correct: boolean;
  /** FR-DET-002's prewritten explanation — written once per question, never generated. */
  explanation: string;
};

/**
 * Each section's answer shape, keyed by section.
 *
 * This map exists for its *type*: `satisfies Record<SectionKey, …>` makes adding a section to
 * `SECTION_KEYS` a compile error until the section is answered for here — the cheapest place to
 * notice. The union below then refers to these rather than restating them, so a shape is defined
 * exactly once.
 */
const SECTION_ANSWER_SCHEMAS = {
  grammar: choiceAnswersSchema,
  vocabulary: choiceAnswersSchema,
  reading: choiceAnswersSchema,
  writing: writingAnswersSchema,
  studentProblems: studentProblemsAnswersSchema,
} satisfies Record<SectionKey, z.ZodTypeAny>;

/**
 * The body of `PATCH /api/student/draft` (ARCHITECTURE Section 12).
 *
 * A discriminated union on `section`, so that the section key and the answers' shape are checked
 * *together*. A flat `{section: enum, sectionAnswers: unknown}` would accept `{section: 'writing',
 * sectionAnswers: {'gr-01': 'a'}}` and store grammar answers under the writing key — a mistake that
 * would surface much later, as a student's essay being scored as blank.
 *
 * Why the section key is a closed set at all: the merge writes it *as a key* into the JSONB column,
 * so an unvalidated one is not a bad value in a field — it is a new field. Checking it against the
 * five real sections is what keeps a caller from adding top-level keys to `answers` that no part of
 * the system knows how to read.
 *
 * Each member is `.strict()`, matching the content schemas: an unrecognised key means the field
 * that was written is not the field that is read, and silently dropping it would store a save that
 * did not save what the client thought it did.
 */
export const draftAutosaveBodySchema = z.discriminatedUnion('section', [
  z
    .object({ section: z.literal('grammar'), sectionAnswers: SECTION_ANSWER_SCHEMAS.grammar })
    .strict(),
  z
    .object({ section: z.literal('vocabulary'), sectionAnswers: SECTION_ANSWER_SCHEMAS.vocabulary })
    .strict(),
  z
    .object({ section: z.literal('reading'), sectionAnswers: SECTION_ANSWER_SCHEMAS.reading })
    .strict(),
  z
    .object({ section: z.literal('writing'), sectionAnswers: SECTION_ANSWER_SCHEMAS.writing })
    .strict(),
  z
    .object({
      section: z.literal('studentProblems'),
      sectionAnswers: SECTION_ANSWER_SCHEMAS.studentProblems,
    })
    .strict(),
]);

/** The autosave request body, as a type — the frontend's half of the same contract. */
export type DraftAutosaveBody = z.infer<typeof draftAutosaveBodySchema>;
