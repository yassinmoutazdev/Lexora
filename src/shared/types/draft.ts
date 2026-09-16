import { z } from 'zod';
import type {
  DeterministicSectionFile,
  ReadingFile,
  StudentProblemsFile,
  WritingPromptFile,
} from '../../content/contentSchemas.ts';

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
 */

/**
 * The five sections, in the order the assessment presents them (PRD Section 10).
 *
 * Declared once as a value and derived into a type, rather than written twice, because this list is
 * load-bearing in three places that must agree: the autosave request's section key is a *closed
 * set* (Section 12 — an open one would let a caller write arbitrary top-level keys into the JSONB
 * `answers` column), the assessment UI's navigation order, and the section keys the draft response
 * may carry.
 */
export const SECTION_KEYS = ['grammar', 'vocabulary', 'reading', 'writing', 'studentProblems'] as const;

/** A section of the assessment — the unit of both autosave and navigation. */
export type SectionKey = (typeof SECTION_KEYS)[number];

/**
 * The submission's lifecycle state, as far as a student can observe it.
 *
 * Declared here rather than imported from `@prisma/client` so the frontend can name it without
 * depending on the generated database client. The two are the same union, which is what lets the
 * server assign a `SubmissionStatus` straight into this field.
 */
export type SubmissionStatus = 'draft' | 'submitted';

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
