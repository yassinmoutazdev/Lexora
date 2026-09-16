import { z } from 'zod';

/**
 * Zod schemas every version's content files are validated against at boot (ARCHITECTURE Section 2,
 * Section 4, Section 18).
 *
 * Content is authored by hand in JSON, so it is an untrusted input boundary in exactly the way an
 * HTTP body is: a typo'd key or a missing answer key would otherwise reach students as a silently
 * broken question. Validating here means a bad content file stops the process at boot rather than
 * surfacing as a scoring bug during the pilot.
 *
 * Every object is `.strict()`. An unrecognised key is treated as an error rather than ignored,
 * because "the field you wrote is not the field the code reads" is the failure this file exists to
 * catch — and a content file is not a place where silently dropping unknown keys is ever right.
 */

/** PRD Section 10 — the three difficulty levels represented within the relevant sections. */
export const difficultySchema = z.enum(['basic', 'intermediate', 'upper-intermediate']);

/**
 * Question types in use. Kept to the two that v1 content actually contains rather than
 * enumerating types nothing implements — `true_false` is a two-option multiple choice and shares
 * the same rendering and scoring path.
 */
export const questionTypeSchema = z.enum(['multiple_choice', 'true_false']);

/**
 * Marks whether a file's *content* has been confirmed by the team.
 *
 * The structure of every file is final; several files' contents are explicitly TBD in PRD Section
 * 23.1 (question set, statement wording, rubric weights, task prompt). Without this marker a
 * placeholder weight or a development question reads exactly like an approved one. A
 * `provisional` file must say why it is provisional.
 */
export const contentStatusSchema = z.enum(['provisional', 'approved']);

const optionSchema = z
  .object({
    id: z.string().min(1),
    text: z.string().min(1),
  })
  .strict();

/**
 * One deterministic question (Grammar / Vocabulary / Reading).
 *
 * Carries every metadata field FR-DET-002 requires: section (from the enclosing file), skill/topic
 * label, difficulty level, question type, correct answer, prewritten explanation, and scoring
 * information (`points`).
 */
export const questionSchema = z
  .object({
    id: z.string().min(1),
    /** FR-DET-002 — skill/topic label, used for staff analysis. */
    skill: z.string().min(1),
    difficulty: difficultySchema,
    type: questionTypeSchema,
    prompt: z.string().min(1),

    /** Required for every choice-based type; the answer is one of these ids. */
    options: z.array(optionSchema).min(2).optional(),

    /** FR-DET-002 — the answer the deterministic scorer compares against. */
    correctAnswer: z.string().min(1),

    /** FR-DET-002 — prewritten feedback shown per FR-DET-004, never generated at runtime. */
    explanation: z.string().min(1),

    /** FR-DET-002 — scoring information. */
    points: z.number().positive(),
  })
  .strict()
  .superRefine((question, ctx) => {
    if (!question.options) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['options'],
        message: `a ${question.type} question must list its options`,
      });
      return;
    }

    const ids = question.options.map((option) => option.id);
    if (new Set(ids).size !== ids.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['options'],
        message: 'option ids must be unique within a question',
      });
    }

    if (!ids.includes(question.correctAnswer)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['correctAnswer'],
        message: `correctAnswer ${JSON.stringify(question.correctAnswer)} does not match any option id (${ids.join(', ')})`,
      });
    }

    // A `true_false` question shares the choice-rendering path, so it must look like one.
    if (question.type === 'true_false' && question.options.length !== 2) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['options'],
        message: 'a true_false question must have exactly two options',
      });
    }
  });

const questionsArraySchema = z
  .array(questionSchema)
  .min(1)
  .superRefine((questions, ctx) => {
    const ids = questions.map((question) => question.id);
    const duplicate = ids.find((id, index) => ids.indexOf(id) !== index);

    if (duplicate) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `duplicate question id ${JSON.stringify(duplicate)}`,
      });
    }
  });

/** Shared header for a section file. */
const sectionFileBase = {
  title: z.string().min(1),
  contentStatus: contentStatusSchema,
  statusNote: z.string().min(1).optional(),
  instructions: z.string().min(1),
};

/** Rejects a file that claims to be approved while carrying a note about being provisional. */
function requireStatusNote(
  file: { contentStatus: z.infer<typeof contentStatusSchema>; statusNote?: string },
  ctx: z.RefinementCtx,
): void {
  if (file.contentStatus === 'provisional' && !file.statusNote) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['statusNote'],
      message:
        'a provisional file must explain what is unconfirmed and which PRD Section 23.1 item covers it',
    });
  }
}

/** Grammar and Vocabulary: a flat list of questions. */
export const deterministicSectionFileSchema = z
  .object({
    section: z.enum(['grammar', 'vocabulary']),
    ...sectionFileBase,
    questions: questionsArraySchema,
  })
  .strict()
  .superRefine(requireStatusNote);

/**
 * Reading: questions grouped under the passage they belong to, so `AssessmentPage` can render a
 * passage once and its questions beneath it (T4.3.2).
 */
export const readingFileSchema = z
  .object({
    section: z.literal('reading'),
    ...sectionFileBase,
    passages: z
      .array(
        z
          .object({
            id: z.string().min(1),
            title: z.string().min(1),
            text: z.string().min(1),
            questions: questionsArraySchema,
          })
          .strict(),
      )
      .min(1),
  })
  .strict()
  .superRefine(requireStatusNote);

/** The single open-ended free-writing task (FR-WRITE-001/002). */
export const writingPromptFileSchema = z
  .object({
    section: z.literal('writing'),
    ...sectionFileBase,
    task: z
      .object({
        id: z.string().min(1),
        genre: z.string().min(1),
        prompt: z.string().min(1),
        guidance: z.string().min(1),
      })
      .strict(),
  })
  .strict()
  .superRefine(requireStatusNote);

/**
 * The writing rubric: the fixed instructions the LLM is given, plus the scoring weights.
 *
 * The weights live here, not in code, because ARCHITECTURE Section 18 makes this file the
 * canonical location for "writing rubric instructions & weights (configurable, not hardcoded;
 * versioned with content)". They are validated to sum to 100 and to name exactly the approved
 * criteria, so a weight cannot be added, dropped, or mistyped without the weights ceasing to be a
 * complete partition of the overall score.
 */
export const writingRubricFileSchema = z
  .object({
    section: z.literal('writing'),
    contentStatus: contentStatusSchema,
    statusNote: z.string().min(1).optional(),
    criteria: z
      .array(
        z
          .object({
            key: z.string().min(1),
            label: z.string().min(1),
            description: z.string().min(1),
          })
          .strict(),
      )
      .min(1),
    /** Criterion key → percentage of the overall 0-100 score. */
    weights: z.record(z.string().min(1), z.number().positive()),
    scoreRange: z
      .object({
        min: z.number(),
        max: z.number(),
      })
      .strict(),
    instructions: z.string().min(1),
    outputRequirements: z
      .object({
        criterionRationaleRequired: z.boolean(),
        maxCorrections: z.number().int().positive(),
        fields: z.record(z.string().min(1), z.string().min(1)),
      })
      .strict(),
  })
  .strict()
  .superRefine((rubric, ctx) => {
    requireStatusNote(rubric, ctx);

    if (rubric.scoreRange.min >= rubric.scoreRange.max) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['scoreRange'],
        message: 'scoreRange.min must be less than scoreRange.max',
      });
    }

    const keys = rubric.criteria.map((criterion) => criterion.key);
    const duplicate = keys.find((key, index) => keys.indexOf(key) !== index);
    if (duplicate) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['criteria'],
        message: `duplicate criterion key ${JSON.stringify(duplicate)}`,
      });
    }

    const weightedKeys = Object.keys(rubric.weights);
    const unweighted = keys.filter((key) => !weightedKeys.includes(key));
    const unknown = weightedKeys.filter((key) => !keys.includes(key));

    if (unweighted.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['weights'],
        message: `no weight given for criterion(s): ${unweighted.join(', ')}`,
      });
    }
    if (unknown.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['weights'],
        message: `weight given for unknown criterion(s): ${unknown.join(', ')}`,
      });
    }

    const total = weightedKeys.reduce((sum, key) => sum + (rubric.weights[key] ?? 0), 0);
    if (Math.abs(total - 100) > 1e-9) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['weights'],
        message: `weights must sum to 100, got ${total}`,
      });
    }
  });

/** The Student Problems instrument (PRD Section 9.5, Section 11). */
export const studentProblemsFileSchema = z
  .object({
    section: z.literal('studentProblems'),
    ...sectionFileBase,
    /** FR-PROB-002 — the approved five-point agreement scale. */
    scale: z
      .array(
        z
          .object({
            value: z.number().int().min(1).max(5),
            label: z.string().min(1),
          })
          .strict(),
      )
      .length(5),
    areas: z
      .array(
        z
          .object({
            id: z.string().min(1),
            label: z.string().min(1),
          })
          .strict(),
      )
      .min(1),
    statements: z
      .array(
        z
          .object({
            id: z.string().min(1),
            area: z.string().min(1),
            text: z.string().min(1),
          })
          .strict(),
      )
      .min(1),
    openTextQuestion: z
      .object({
        id: z.string().min(1),
        prompt: z.string().min(1),
        /** FR-ASSESS-007 / EDGE-007 — a blank open-text answer never blocks submission. */
        required: z.literal(false),
        /** NFR-GEN-004 — English or Arabic (FR-PROB-004). */
        languages: z.array(z.enum(['en', 'ar'])).min(1),
        /** FR-PROB-014 / NFR-PRIV-009. */
        privacyNotice: z.string().min(1),
        privacyNoticeHeading: z.string().min(1),
      })
      .strict(),
  })
  .strict()
  .superRefine((file, ctx) => {
    requireStatusNote(file, ctx);

    const values = file.scale.map((point) => point.value).sort((a, b) => a - b);
    if (values.join(',') !== '1,2,3,4,5') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['scale'],
        message: 'the scale must carry exactly the values 1-5',
      });
    }

    const areaIds = file.areas.map((area) => area.id);
    const unknownArea = file.statements.find((statement) => !areaIds.includes(statement.area));
    if (unknownArea) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['statements'],
        message: `statement ${unknownArea.id} refers to unknown area ${JSON.stringify(unknownArea.area)}`,
      });
    }

    const ids = file.statements.map((statement) => statement.id);
    const duplicate = ids.find((id, index) => ids.indexOf(id) !== index);
    if (duplicate) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['statements'],
        message: `duplicate statement id ${JSON.stringify(duplicate)}`,
      });
    }
  });

/** `content/current-version.json` — which version new drafts start under. */
export const currentVersionFileSchema = z
  .object({
    version: z.string().min(1),
  })
  .strict();

export type Difficulty = z.infer<typeof difficultySchema>;
export type QuestionType = z.infer<typeof questionTypeSchema>;
export type ContentStatus = z.infer<typeof contentStatusSchema>;
export type Question = z.infer<typeof questionSchema>;
export type DeterministicSectionFile = z.infer<typeof deterministicSectionFileSchema>;
export type ReadingFile = z.infer<typeof readingFileSchema>;
export type WritingPromptFile = z.infer<typeof writingPromptFileSchema>;
export type WritingRubricFile = z.infer<typeof writingRubricFileSchema>;
export type StudentProblemsFile = z.infer<typeof studentProblemsFileSchema>;
export type CurrentVersionFile = z.infer<typeof currentVersionFileSchema>;
