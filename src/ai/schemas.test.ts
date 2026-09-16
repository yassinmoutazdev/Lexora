import { describe, expect, it } from 'vitest';
import type { StudentProblemsAnalysis, WritingEvaluation } from './AIEvaluationService.ts';
import { studentProblemsAnalysisSchema, writingEvaluationSchema } from './schemas.ts';

/**
 * Unit coverage for the AI output schemas (T6.1.2, ARCHITECTURE Section 15 — "Schema validation
 * accepts well-formed responses and rejects malformed ones (missing field, wrong type, out-of-range
 * score) without ever making a real network call in CI").
 *
 * Pure and database-free: these schemas describe a JSON document, so a test of them needs nothing
 * but the document. That is also why every case below is written as a literal rather than derived
 * from a fixture file — the schemas' input is a model's response, and a model's response has no
 * versioned home in `content/` to derive from.
 *
 * Each malformed case mutates one field of a *well-formed* document, so a failure here means the
 * schema let through something a real model could plausibly produce, rather than exercising a shape
 * nothing would ever return.
 */

/** The first zod issue rendered as `path: message`, so a test can assert *which* field failed. */
function firstIssue(result: {
  success: boolean;
  error?: { issues: { path: (string | number)[]; message: string }[] };
}): string {
  const issue = result.error?.issues[0];
  if (!issue) throw new Error('expected the parse to fail, but it succeeded');
  return `${issue.path.join('.')}: ${issue.message}`;
}

/** A response a model could plausibly return for a graded essay — every required field present. */
function wellFormedWritingEvaluation(): WritingEvaluation {
  return {
    criteriaScores: {
      grammarAccuracy: { score: 72, rationale: 'Subject-verb agreement slips in two places.' },
      vocabulary: { score: 80, rationale: 'Varied and mostly precise word choice.' },
      sentenceStructure: { score: 65, rationale: 'Frequent run-on sentences in paragraph two.' },
      coherence: { score: 78, rationale: 'Clear paragraphing with effective linking devices.' },
      taskCompletion: { score: 85, rationale: 'Takes a position and supports it with examples.' },
    },
    strengths: ['A clear position is stated and maintained.'],
    weaknesses: ['Run-on sentences in the second paragraph.'],
    corrections: [
      {
        original: 'I think is important to study.',
        corrected: 'I think it is important to study.',
        explanation: 'The subject "it" is missing before the verb.',
      },
    ],
    suggestions: ['Read the response aloud to catch missing subjects.'],
  };
}

/** A response a model could plausibly return for an Arabic open-text answer. */
function wellFormedStudentProblemsAnalysis(): StudentProblemsAnalysis {
  return {
    normalizedText: 'I find it difficult to speak in front of my classmates.',
    categories: [
      {
        label: 'Speaking anxiety',
        evidence: 'difficult to speak in front of my classmates',
      },
    ],
  };
}

/** A deep copy that is safe to mutate. */
function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

describe('writingEvaluationSchema — well-formed responses', () => {
  it('accepts a complete evaluation', () => {
    const result = writingEvaluationSchema.safeParse(wellFormedWritingEvaluation());

    expect(result.success).toBe(true);
  });

  it('accepts the 0 and 100 bounds of the score range', () => {
    // FR-WRITE-009 puts the rubric on a 100-point scale; the ends of it are legitimate scores, not
    // edge cases to reject. An off-by-one here would only ever surface on the best and worst
    // responses in the cohort — the two a pilot most wants to look at.
    const evaluation = wellFormedWritingEvaluation();
    evaluation.criteriaScores.grammarAccuracy = { score: 0, rationale: 'Nothing grammatical.' };
    evaluation.criteriaScores.vocabulary = { score: 100, rationale: 'Faultless throughout.' };

    expect(writingEvaluationSchema.safeParse(evaluation).success).toBe(true);
  });

  it('accepts a fractional criterion score', () => {
    // Not a rounding preference the schema gets to have: 78.5 is a legitimate rubric judgment, and
    // rejecting it would spend the job's single validation retry on it. Integrality is the overall
    // score's problem, because that one is an `Int?` column — see `WritingScoreCalculator` (T7.1.1).
    const evaluation = wellFormedWritingEvaluation();
    evaluation.criteriaScores.coherence = { score: 78.5, rationale: 'Strong, with a weak close.' };

    expect(writingEvaluationSchema.safeParse(evaluation).success).toBe(true);
  });

  it('accepts empty feedback lists', () => {
    // FR-WRITE-007 requires the output to *include* these, not to have something in each. A response
    // with nothing to correct is a real outcome; refusing it would fail a perfectly good evaluation
    // and, after the retry, land the submission in `failed_needs_review`.
    const evaluation = wellFormedWritingEvaluation();
    evaluation.strengths = [];
    evaluation.weaknesses = [];
    evaluation.corrections = [];
    evaluation.suggestions = [];

    expect(writingEvaluationSchema.safeParse(evaluation).success).toBe(true);
  });
});

describe('writingEvaluationSchema — malformed responses', () => {
  it('rejects a missing field rather than treating it as absent feedback', () => {
    const evaluation = clone(wellFormedWritingEvaluation()) as Record<string, unknown>;
    delete evaluation.suggestions;

    const result = writingEvaluationSchema.safeParse(evaluation);

    expect(result.success).toBe(false);
    expect(firstIssue(result)).toContain('suggestions');
  });

  it('rejects an out-of-range criterion score', () => {
    const evaluation = wellFormedWritingEvaluation();
    evaluation.criteriaScores.taskCompletion = { score: 101, rationale: 'Excellent.' };

    const result = writingEvaluationSchema.safeParse(evaluation);

    expect(result.success).toBe(false);
    expect(firstIssue(result)).toContain('criteriaScores.taskCompletion.score');
  });

  it('rejects a negative criterion score', () => {
    const evaluation = wellFormedWritingEvaluation();
    evaluation.criteriaScores.vocabulary = { score: -1, rationale: 'Nothing to say.' };

    const result = writingEvaluationSchema.safeParse(evaluation);

    expect(result.success).toBe(false);
    expect(firstIssue(result)).toContain('criteriaScores.vocabulary.score');
  });

  it('rejects a score sent as a string', () => {
    // The shape a model actually returns when it "helpfully" quotes its numbers. Coercion would
    // accept it, and coercion is how a boundary stops being one.
    const evaluation = clone(wellFormedWritingEvaluation()) as any;
    evaluation.criteriaScores.grammarAccuracy.score = '72';

    const result = writingEvaluationSchema.safeParse(evaluation);

    expect(result.success).toBe(false);
    expect(firstIssue(result)).toContain('criteriaScores.grammarAccuracy.score');
  });

  it('rejects a criterion with no rationale', () => {
    // FR-WRITE-005 asks for criterion-level evaluations with supporting evidence; a bare number is
    // the "arbitrary single overall number" it rules out, one criterion at a time.
    const evaluation = clone(wellFormedWritingEvaluation()) as any;
    delete evaluation.criteriaScores.coherence.rationale;

    const result = writingEvaluationSchema.safeParse(evaluation);

    expect(result.success).toBe(false);
    expect(firstIssue(result)).toContain('criteriaScores.coherence.rationale');
  });

  it('rejects a response carrying no criterion scores at all', () => {
    // Valid JSON, correct types, and completely useless: the overall score is computed from these,
    // so an empty set is a report with no writing result behind it.
    const evaluation = wellFormedWritingEvaluation();
    evaluation.criteriaScores = {};

    const result = writingEvaluationSchema.safeParse(evaluation);

    expect(result.success).toBe(false);
    expect(firstIssue(result)).toContain('criteriaScores');
  });

  it('rejects an unknown key at the top level', () => {
    const evaluation = clone(wellFormedWritingEvaluation()) as Record<string, unknown>;
    evaluation.overallScore = 76; // FR-WRITE-006 — the model does not compute this

    const result = writingEvaluationSchema.safeParse(evaluation);

    expect(result.success).toBe(false);
    expect(firstIssue(result)).toContain('overallScore');
  });

  it('rejects an unknown key inside a criterion', () => {
    const evaluation = clone(wellFormedWritingEvaluation()) as any;
    evaluation.criteriaScores.vocabulary.confidence = 0.9;

    const result = writingEvaluationSchema.safeParse(evaluation);

    expect(result.success).toBe(false);
    expect(firstIssue(result)).toContain('criteriaScores.vocabulary');
  });

  it('rejects a response that is not an object at all', () => {
    // The prose case: a model that ignores "a single JSON object and nothing else" and returns a
    // sentence, or JSON wrapped in a markdown fence, must fail here rather than at the caller.
    for (const input of ['The essay is quite good.', null, [1, 2, 3], 42]) {
      expect(writingEvaluationSchema.safeParse(input).success).toBe(false);
    }
  });
});

describe('studentProblemsAnalysisSchema — well-formed responses', () => {
  it('accepts a complete analysis', () => {
    expect(studentProblemsAnalysisSchema.safeParse(wellFormedStudentProblemsAnalysis()).success).toBe(
      true,
    );
  });

  it('accepts a response with no categories', () => {
    // "Nothing here matches a difficulty category" is an honest reading of some answers, and the
    // derived column records it as one rather than as a failure.
    const analysis = wellFormedStudentProblemsAnalysis();
    analysis.categories = [];

    expect(studentProblemsAnalysisSchema.safeParse(analysis).success).toBe(true);
  });
});

describe('studentProblemsAnalysisSchema — malformed responses', () => {
  it('rejects a missing normalized text', () => {
    const analysis = clone(wellFormedStudentProblemsAnalysis()) as Record<string, unknown>;
    delete analysis.normalizedText;

    const result = studentProblemsAnalysisSchema.safeParse(analysis);

    expect(result.success).toBe(false);
    expect(firstIssue(result)).toContain('normalizedText');
  });

  it('rejects an empty normalized text', () => {
    // FR-PROB-010/011: the derived column is the AI's English representation of the response. Storing
    // an empty one beside a non-empty original would record a failed normalization as a success.
    const analysis = wellFormedStudentProblemsAnalysis();
    analysis.normalizedText = '';

    const result = studentProblemsAnalysisSchema.safeParse(analysis);

    expect(result.success).toBe(false);
    expect(firstIssue(result)).toContain('normalizedText');
  });

  it('rejects a category with no supporting evidence', () => {
    // FR-PROB-011 requires derived interpretations to be labelled as such rather than presented as
    // fact. A category that cannot point at the wording it came from has nothing behind it.
    const analysis = clone(wellFormedStudentProblemsAnalysis()) as any;
    delete analysis.categories[0].evidence;

    const result = studentProblemsAnalysisSchema.safeParse(analysis);

    expect(result.success).toBe(false);
    expect(firstIssue(result)).toContain('categories.0.evidence');
  });

  it('rejects a category sent as a bare string', () => {
    const analysis = clone(wellFormedStudentProblemsAnalysis()) as any;
    analysis.categories = ['Speaking anxiety'];

    const result = studentProblemsAnalysisSchema.safeParse(analysis);

    expect(result.success).toBe(false);
    expect(firstIssue(result)).toContain('categories.0');
  });

  it('rejects an unknown key on a category', () => {
    const analysis = clone(wellFormedStudentProblemsAnalysis()) as any;
    analysis.categories[0].severity = 'high';

    const result = studentProblemsAnalysisSchema.safeParse(analysis);

    expect(result.success).toBe(false);
    expect(firstIssue(result)).toContain('categories.0');
  });
});
