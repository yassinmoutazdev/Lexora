import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../config/env.ts';
import {
  currentVersionFileSchema,
  deterministicSectionFileSchema,
  readingFileSchema,
  studentProblemsFileSchema,
  writingPromptFileSchema,
  writingRubricFileSchema,
} from './contentSchemas.ts';

/**
 * Unit coverage for the content schemas (T2.2.3).
 *
 * The real v1 files must pass — that is the check that the committed content and the schemas agree.
 * Each malformed case is then derived by mutating a real file, so a failure here means the schema
 * let through something the committed content could plausibly have got wrong, rather than
 * exercising a shape nothing will ever produce.
 */

const V1 = path.join(REPO_ROOT, 'content', 'versions', 'v1');

function readJson(fileName: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(V1, fileName), 'utf8')) as Record<string, unknown>;
}

/** A deep copy of a real content file, safe to mutate. */
function cloneJson(fileName: string): any {
  return JSON.parse(JSON.stringify(readJson(fileName)));
}

/**
 * The first zod issue rendered as `path: message`, for asserting the failure is the intended one.
 * The path matters as much as the message — "Required" alone does not say which field is missing.
 */
function firstIssue(result: {
  success: boolean;
  error?: { issues: { path: (string | number)[]; message: string }[] };
}): string {
  const issue = result.error?.issues[0];
  if (!issue) return '';

  return `${issue.path.join('.')}: ${issue.message}`;
}

describe('deterministicSectionFileSchema', () => {
  it('accepts the committed grammar and vocabulary files', () => {
    expect(deterministicSectionFileSchema.safeParse(readJson('grammar-questions.json')).success).toBe(
      true,
    );
    expect(
      deterministicSectionFileSchema.safeParse(readJson('vocabulary-questions.json')).success,
    ).toBe(true);
  });

  it('rejects a correct answer that matches no option', () => {
    const file = cloneJson('grammar-questions.json');
    file.questions[0].correctAnswer = 'z';

    const result = deterministicSectionFileSchema.safeParse(file);

    expect(result.success).toBe(false);
    expect(firstIssue(result)).toContain('does not match any option id');
  });

  it('rejects a question with no prewritten explanation (FR-DET-002)', () => {
    const file = cloneJson('grammar-questions.json');
    delete file.questions[2].explanation;

    const result = deterministicSectionFileSchema.safeParse(file);

    expect(result.success).toBe(false);
    expect(firstIssue(result)).toContain('explanation');
  });

  it('rejects a question with no scoring information (FR-DET-002)', () => {
    const file = cloneJson('grammar-questions.json');
    delete file.questions[1].points;

    const result = deterministicSectionFileSchema.safeParse(file);

    expect(result.success).toBe(false);
    expect(firstIssue(result)).toContain('points');
  });

  it('rejects fractional points, which the integer score columns could not store', () => {
    // A question worth half a mark would load cleanly and then fail at submission, when the score
    // is written to an `Int` column. Catching it here means it never reaches a student.
    const file = cloneJson('grammar-questions.json');
    file.questions[0].points = 0.5;

    const result = deterministicSectionFileSchema.safeParse(file);

    expect(result.success).toBe(false);
    expect(firstIssue(result)).toContain('points');
  });

  it('accepts whole-number points, including values above one', () => {
    // The rule is "integral", not "exactly 1" — a section may weight one question more heavily
    // than another, and that is scoring information the content is allowed to carry.
    const file = cloneJson('grammar-questions.json');
    file.questions[0].points = 3;

    expect(deterministicSectionFileSchema.safeParse(file).success).toBe(true);
  });

  it('rejects an unknown metadata key rather than silently ignoring it', () => {
    const file = cloneJson('grammar-questions.json');
    file.questions[0].difficuly = 'basic'; // typo for `difficulty`

    const result = deterministicSectionFileSchema.safeParse(file);

    expect(result.success).toBe(false);
  });

  it('rejects a difficulty level outside the three approved ones', () => {
    const file = cloneJson('grammar-questions.json');
    file.questions[0].difficulty = 'advanced';

    expect(deterministicSectionFileSchema.safeParse(file).success).toBe(false);
  });

  it('rejects duplicate question ids', () => {
    const file = cloneJson('grammar-questions.json');
    file.questions[1].id = file.questions[0].id;

    const result = deterministicSectionFileSchema.safeParse(file);

    expect(result.success).toBe(false);
    expect(firstIssue(result)).toContain('duplicate question id');
  });

  it('rejects duplicate option ids within one question', () => {
    const file = cloneJson('grammar-questions.json');
    file.questions[0].options[1].id = 'a';

    const result = deterministicSectionFileSchema.safeParse(file);

    expect(result.success).toBe(false);
    expect(firstIssue(result)).toContain('option ids must be unique');
  });

  it('rejects an empty question list', () => {
    const file = cloneJson('grammar-questions.json');
    file.questions = [];

    expect(deterministicSectionFileSchema.safeParse(file).success).toBe(false);
  });

  it('rejects a provisional file that does not say why it is provisional', () => {
    const file = cloneJson('grammar-questions.json');
    delete file.statusNote;

    const result = deterministicSectionFileSchema.safeParse(file);

    expect(result.success).toBe(false);
    expect(firstIssue(result)).toContain('Section 23.1');
  });
});

describe('readingFileSchema', () => {
  it('accepts the committed reading file', () => {
    expect(readingFileSchema.safeParse(readJson('reading-questions.json')).success).toBe(true);
  });

  it('requires at least one passage', () => {
    const file = cloneJson('reading-questions.json');
    file.passages = [];

    expect(readingFileSchema.safeParse(file).success).toBe(false);
  });

  it('rejects a true_false question that does not have exactly two options', () => {
    const file = cloneJson('reading-questions.json');
    const trueFalse = file.passages[1].questions.find((q: any) => q.type === 'true_false');
    trueFalse.options.push({ id: 'c', text: 'Not given' });

    const result = readingFileSchema.safeParse(file);

    expect(result.success).toBe(false);
    expect(firstIssue(result)).toContain('exactly two options');
  });

  it('rejects a passage with no questions', () => {
    const file = cloneJson('reading-questions.json');
    file.passages[0].questions = [];

    expect(readingFileSchema.safeParse(file).success).toBe(false);
  });
});

describe('writingPromptFileSchema', () => {
  it('accepts the committed writing prompt', () => {
    expect(writingPromptFileSchema.safeParse(readJson('writing-prompt.json')).success).toBe(true);
  });

  it('requires the task prompt itself', () => {
    const file = cloneJson('writing-prompt.json');
    delete file.task.prompt;

    expect(writingPromptFileSchema.safeParse(file).success).toBe(false);
  });
});

describe('writingRubricFileSchema', () => {
  it('accepts the committed rubric and its weights sum to 100', () => {
    const result = writingRubricFileSchema.safeParse(readJson('writing-rubric.json'));

    expect(result.success).toBe(true);
    expect(Object.values(result.data!.weights).reduce((sum, weight) => sum + weight, 0)).toBe(100);
  });

  it('rejects weights that do not sum to 100', () => {
    const file = cloneJson('writing-rubric.json');
    file.weights.grammarAccuracy = 30; // total becomes 110

    const result = writingRubricFileSchema.safeParse(file);

    expect(result.success).toBe(false);
    expect(firstIssue(result)).toContain('weights must sum to 100');
  });

  it('rejects a criterion with no weight', () => {
    const file = cloneJson('writing-rubric.json');
    delete file.weights.coherence;

    const result = writingRubricFileSchema.safeParse(file);

    expect(result.success).toBe(false);
    expect(result.error?.issues.some((issue) => issue.message.includes('no weight given'))).toBe(
      true,
    );
  });

  it('rejects a weight for a criterion that does not exist', () => {
    const file = cloneJson('writing-rubric.json');
    file.weights.spelling = 0; // also keeps the sum unchanged, isolating the unknown-key check
    file.weights.grammarAccuracy = 20;

    const result = writingRubricFileSchema.safeParse(file);

    expect(result.success).toBe(false);
    expect(result.error?.issues.some((issue) => issue.message.includes('unknown criterion'))).toBe(
      true,
    );
  });

  it('rejects a non-positive weight', () => {
    const file = cloneJson('writing-rubric.json');
    file.weights.grammarAccuracy = 0;

    expect(writingRubricFileSchema.safeParse(file).success).toBe(false);
  });

  it('requires the LLM instructions (FR-WRITE-004)', () => {
    const file = cloneJson('writing-rubric.json');
    delete file.instructions;

    expect(writingRubricFileSchema.safeParse(file).success).toBe(false);
  });
});

describe('studentProblemsFileSchema', () => {
  it('accepts the committed statements file', () => {
    expect(studentProblemsFileSchema.safeParse(readJson('student-problems-statements.json')).success).toBe(
      true,
    );
  });

  it('requires the approved five-point scale and nothing else', () => {
    const file = cloneJson('student-problems-statements.json');
    file.scale.pop();

    const result = studentProblemsFileSchema.safeParse(file);

    expect(result.success).toBe(false);
    expect(firstIssue(result)).toContain('exactly 5');
  });

  it('rejects a scale whose values are not exactly 1-5', () => {
    const file = cloneJson('student-problems-statements.json');
    file.scale[4].value = 6;

    const result = studentProblemsFileSchema.safeParse(file);

    expect(result.success).toBe(false);
    expect(result.error?.issues.some((issue) => issue.message.includes('values 1-5'))).toBe(true);
  });

  it('rejects a statement assigned to an area that does not exist', () => {
    const file = cloneJson('student-problems-statements.json');
    file.statements[0].area = 'pronunciation';

    const result = studentProblemsFileSchema.safeParse(file);

    expect(result.success).toBe(false);
    expect(firstIssue(result)).toContain('unknown area');
  });

  it('requires the privacy notice (FR-PROB-014)', () => {
    const file = cloneJson('student-problems-statements.json');
    delete file.openTextQuestion.privacyNotice;

    expect(studentProblemsFileSchema.safeParse(file).success).toBe(false);
  });

  it('refuses an open-text question that is marked required (FR-ASSESS-007 / EDGE-007)', () => {
    const file = cloneJson('student-problems-statements.json');
    file.openTextQuestion.required = true;

    expect(studentProblemsFileSchema.safeParse(file).success).toBe(false);
  });

  it('allows only the supported languages (NFR-GEN-004)', () => {
    const file = cloneJson('student-problems-statements.json');
    file.openTextQuestion.languages = ['en', 'fr'];

    expect(studentProblemsFileSchema.safeParse(file).success).toBe(false);
  });
});

describe('currentVersionFileSchema', () => {
  it('accepts the committed pointer and rejects an empty version', () => {
    const file = JSON.parse(
      fs.readFileSync(path.join(REPO_ROOT, 'content', 'current-version.json'), 'utf8'),
    );

    expect(currentVersionFileSchema.safeParse(file).success).toBe(true);
    expect(currentVersionFileSchema.safeParse({ version: '' }).success).toBe(false);
  });
});
