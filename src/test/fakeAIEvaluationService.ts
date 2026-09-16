import type { z } from 'zod';
import type {
  AIEvaluationService,
  StudentProblemsAnalysis,
  WritingEvaluation,
} from '../ai/AIEvaluationService.ts';
import { AIError, AIValidationError } from '../ai/errors.ts';
import { studentProblemsAnalysisSchema, writingEvaluationSchema } from '../ai/schemas.ts';

/**
 * The AI provider every test runs against (T6.1.3, ARCHITECTURE Section 15 — "Mocking Ollama: all
 * tests run against a `FakeAIEvaluationService` implementing the same `AIEvaluationService`
 * interface as `OllamaProvider` … the entire test suite, including CI, never depends on Ollama Cloud
 * being reachable or within quota").
 *
 * ## Why this is a real implementation and not a stub
 *
 * It implements the interface without qualification: it validates its own output against the same
 * `src/ai/schemas.ts` an `OllamaProvider` would, and it raises the same `AIError` subclasses. That is
 * what makes the fake worth having — a stub that returned a literal would let the worker, `JobService`,
 * and the report be tested against a boundary that does not behave like the real one, and the first
 * thing to discover the difference would be the pilot. What is swapped out is only *where the answer
 * comes from*.
 *
 * Section 17 names the seam this exercises: a second provider "could be added and selected via
 * configuration without touching `SubmissionService`, `WritingScoreCalculator`, or any route." This
 * file is the standing proof of that claim — it is a second implementation, in a different directory,
 * that none of those three files has heard of.
 *
 * ## Where it lives
 *
 * `src/test/`, with the rest of the harness, and not in `src/ai/`. Section 4's `src/ai/` listing is
 * short and exact — interface, provider, schemas, errors — and a test double added to it would read
 * as a fifth production file. Its consumers are all suites.
 */

/**
 * One configured answer for a single call.
 *
 * Three cases, because there are three distinct things a test needs to say about a provider:
 * it answered correctly, it answered with something the schema rejects, or it failed outright.
 * Section 15's test row asks for exactly this: *"Schema validation accepts well-formed responses and
 * rejects malformed ones (missing field, wrong type, out-of-range score) without ever making a real
 * network call."*
 */
export type FakeAIResponse<T> =
  /**
   * A well-formed result.
   *
   * Validated before it is returned, so a mistake in a test's own fixture is caught here rather than
   * becoming an assertion that passes for a reason the test did not intend. A failure to validate is
   * raised as a plain `Error` and not as an `AIError`: it is a broken test, not simulated provider
   * behaviour, and the two must not be confusable.
   */
  | { kind: 'result'; value: T }
  /**
   * Output that is deliberately not schema-valid, standing in for a model that answered with the
   * wrong shape — a missing field, a score out of range, prose instead of JSON.
   *
   * Raises `AIValidationError`, the same class a real provider raises, so the retry path Section 8
   * describes is exercised rather than imitated. Configuring output that turns out to be *valid* is
   * an error: the test asked for a failure and would otherwise get a passing one for the wrong reason.
   */
  | { kind: 'invalidOutput'; output: unknown }
  /** A failure to raise instead of answering — the timeout, the malformed-input, the queue-full. */
  | { kind: 'failure'; error: AIError };

/**
 * What each method should answer with.
 *
 * A single response applies to every call. An array is consumed in call order and its **last entry
 * repeats**, which is the shape the two cases that need more than one call want: "always fails" is a
 * one-entry array, and "fails twice and then succeeds" is a three-entry array read left to right.
 */
export type FakeAIResponseScript<T> = FakeAIResponse<T> | FakeAIResponse<T>[];

export type FakeAIEvaluationScript = {
  writing?: FakeAIResponseScript<WritingEvaluation>;
  problems?: FakeAIResponseScript<StudentProblemsAnalysis>;
};

/** One recorded call, so a test can assert what the provider was actually asked to do. */
export type FakeAICall =
  | { method: 'evaluateWriting'; responseText: string; rubricInstructions: string }
  | { method: 'processStudentProblemsText'; responseText: string };

/**
 * The rubric criterion scores the fake returns by default.
 *
 * All five approved criteria (FR-WRITE-009), each scoring 80. Equal scores deliberately: 80 is the
 * expected overall under *any* weighting, so a test that is not about the weighting formula cannot
 * accidentally become one, and a test that is about the formula passes its own values instead.
 */
export function defaultWritingEvaluation(): WritingEvaluation {
  const score = { score: 80, rationale: 'Even competence across the response.' };

  return {
    criteriaScores: {
      grammarAccuracy: { ...score },
      vocabulary: { ...score },
      sentenceStructure: { ...score },
      coherence: { ...score },
      taskCompletion: { ...score },
    },
    strengths: ['The position is stated clearly and held throughout.'],
    weaknesses: ['Paragraphing could separate the two main reasons.'],
    corrections: [
      {
        original: 'I think is important.',
        corrected: 'I think it is important.',
        explanation: 'The subject "it" is missing before the verb.',
      },
    ],
    suggestions: ['Read the response aloud before finishing.'],
  };
}

/** The Student Problems analysis the fake returns by default. */
export function defaultStudentProblemsAnalysis(): StudentProblemsAnalysis {
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

/** Normalizes the constructor's shorthand into the queue the fake consumes. */
function toQueue<T>(script: FakeAIResponseScript<T> | undefined): FakeAIResponse<T>[] {
  if (script === undefined) return [];
  return Array.isArray(script) ? script : [script];
}

/**
 * The response for one call, given how many calls have already been made.
 *
 * Throws rather than returns for the two failure cases, which is what lets each method below read as
 * "return the answer" with the failure vocabulary handled in one place.
 */
function answerFor<T>(
  queue: FakeAIResponse<T>[],
  callIndex: number,
  validate: z.ZodType<T>,
  fallback: T,
): T {
  // The last configured response repeats, so "this always fails" is stated once rather than repeated
  // to the length of a retry budget the test would then have to keep in step with `MAX_ATTEMPTS`.
  const response: FakeAIResponse<T> =
    queue.length === 0
      ? { kind: 'result', value: fallback }
      : (queue[Math.min(callIndex, queue.length - 1)] as FakeAIResponse<T>);

  if (response.kind === 'failure') throw response.error;

  if (response.kind === 'invalidOutput') {
    const parsed = validate.safeParse(response.output);

    if (parsed.success) {
      throw new Error(
        'FakeAIEvaluationService: invalidOutput was configured with output that the schema accepts. ' +
          'The test asked for a validation failure and would not have got one.',
      );
    }

    // The message stays structural: `src/ai/errors.ts` keeps response text out of messages, and a
    // fake that relaxed that rule would let a test pass while the real provider leaked.
    throw new AIValidationError(
      `Simulated malformed model output: ${parsed.error.issues
        .map((issue) => issue.path.join('.') || '(root)')
        .join(', ')}`,
    );
  }

  const parsed = validate.safeParse(response.value);

  if (!parsed.success) {
    throw new Error(
      `FakeAIEvaluationService: configured result is not schema-valid (${parsed.error.issues
        .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
        .join('; ')}). This is a broken test fixture, not simulated provider behaviour.`,
    );
  }

  return parsed.data;
}

/**
 * A scripted `AIEvaluationService` (T6.1.3).
 *
 * ```ts
 * new FakeAIEvaluationService()                              // answers well-formed results
 * new FakeAIEvaluationService({ writing: { kind: 'failure', error: new AIRetryableError('timeout') } })
 * new FakeAIEvaluationService({ writing: [failOnce, succeed] })  // fail, then succeed on the retry
 * ```
 */
export class FakeAIEvaluationService implements AIEvaluationService {
  /** Every call this fake received, oldest first — what the caller passed it, and how often. */
  readonly calls: FakeAICall[] = [];

  private readonly writingQueue: FakeAIResponse<WritingEvaluation>[];
  private readonly problemsQueue: FakeAIResponse<StudentProblemsAnalysis>[];

  constructor(script: FakeAIEvaluationScript = {}) {
    this.writingQueue = toQueue(script.writing);
    this.problemsQueue = toQueue(script.problems);
  }

  /** How many times `evaluateWriting` has been called — the retry assertions read this. */
  get writingCallCount(): number {
    return this.calls.filter((call) => call.method === 'evaluateWriting').length;
  }

  /** How many times `processStudentProblemsText` has been called. */
  get problemsCallCount(): number {
    return this.calls.filter((call) => call.method === 'processStudentProblemsText').length;
  }

  async evaluateWriting(
    responseText: string,
    rubricInstructions: string,
  ): Promise<WritingEvaluation> {
    const callIndex = this.writingCallCount;
    this.calls.push({ method: 'evaluateWriting', responseText, rubricInstructions });

    return answerFor(
      this.writingQueue,
      callIndex,
      writingEvaluationSchema,
      defaultWritingEvaluation(),
    );
  }

  async processStudentProblemsText(responseText: string): Promise<StudentProblemsAnalysis> {
    const callIndex = this.problemsCallCount;
    this.calls.push({ method: 'processStudentProblemsText', responseText });

    return answerFor(
      this.problemsQueue,
      callIndex,
      studentProblemsAnalysisSchema,
      defaultStudentProblemsAnalysis(),
    );
  }
}
