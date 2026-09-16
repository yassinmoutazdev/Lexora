import { describe, expect, it } from 'vitest';
import type { AIEvaluationService } from '../ai/AIEvaluationService.ts';
import { AIError, AIRetryableError, AIValidationError } from '../ai/errors.ts';
import {
  FakeAIEvaluationService,
  defaultStudentProblemsAnalysis,
  defaultWritingEvaluation,
} from './fakeAIEvaluationService.ts';

/**
 * Unit coverage for the fake provider itself (T6.1.3).
 *
 * A test double is load-bearing: every later assertion about the worker, the job lifecycle, and the
 * report is written on the assumption that this file answers when it should and fails in the way it
 * was told to. A fake that quietly stopped failing would make those suites pass for no reason — the
 * failure mode E5's review already recorded once, where a test kept passing with its mechanism
 * removed. So the fake's own contract gets asserted here, once, rather than being trusted everywhere
 * else.
 *
 * No database and no network: this file tests a promise and a queue.
 */

/** The interface conformance is a compile-time property; this makes the compiler state it. */
const asInterface: AIEvaluationService = new FakeAIEvaluationService();

describe('FakeAIEvaluationService — the default answers', () => {
  it('answers with a well-formed writing evaluation', async () => {
    const result = await asInterface.evaluateWriting('An essay.', 'rubric instructions');

    expect(result).toEqual(defaultWritingEvaluation());
    // Five criteria, because `criteriaScores` is empty in a result that validated by accident.
    expect(Object.keys(result.criteriaScores)).toHaveLength(5);
  });

  it('answers with a well-formed Student Problems analysis', async () => {
    const result = await asInterface.processStudentProblemsText('أجد صعوبة في التحدث.');

    expect(result).toEqual(defaultStudentProblemsAnalysis());
  });

  it('scores every criterion the same by default, so the default is weight-independent', () => {
    // 80 across the board is 80 under any weighting. A test that is not about the weighting formula
    // must not be able to become one by accident.
    const scores = Object.values(defaultWritingEvaluation().criteriaScores).map((c) => c.score);

    expect(new Set(scores).size).toBe(1);
  });
});

describe('FakeAIEvaluationService — what it records', () => {
  it('records the exact arguments each call was made with', async () => {
    // The worker's tests read this to prove it resolved the *frozen* version's response text and
    // rubric rather than something else — so the recording has to be the arguments, not a summary.
    const service = new FakeAIEvaluationService();

    await service.evaluateWriting('the essay text', 'the rubric instructions');
    await service.processStudentProblemsText('the open text');

    expect(service.calls).toEqual([
      {
        method: 'evaluateWriting',
        responseText: 'the essay text',
        rubricInstructions: 'the rubric instructions',
      },
      { method: 'processStudentProblemsText', responseText: 'the open text' },
    ]);
    expect(service.writingCallCount).toBe(1);
    expect(service.problemsCallCount).toBe(1);
  });
});

describe('FakeAIEvaluationService — configured failures', () => {
  it('raises the exact error it was configured with', async () => {
    const error = new AIRetryableError('timed out after 60000ms');
    const service = new FakeAIEvaluationService({ writing: { kind: 'failure', error } });

    await expect(service.evaluateWriting('text', 'rubric')).rejects.toBe(error);
  });

  it('raises AIValidationError for deliberately malformed output', async () => {
    // The path Section 8 treats as retryable once, exercised through the real error class rather
    // than imitated by a test-specific one.
    const service = new FakeAIEvaluationService({
      writing: { kind: 'invalidOutput', output: { criteriaScores: {} } },
    });

    await expect(service.evaluateWriting('text', 'rubric')).rejects.toBeInstanceOf(AIValidationError);
  });

  it('refuses to call malformed output malformed when the schema accepts it', async () => {
    // The guard on the guard: a test that configures `invalidOutput` and accidentally supplies a
    // valid document would otherwise watch its assertion pass without a failure ever occurring.
    const service = new FakeAIEvaluationService({
      writing: { kind: 'invalidOutput', output: defaultWritingEvaluation() },
    });

    await expect(service.evaluateWriting('text', 'rubric')).rejects.toThrow(/schema accepts/);
    await expect(service.evaluateWriting('text', 'rubric')).rejects.not.toBeInstanceOf(AIError);
  });

  it('reports a broken result fixture as a test error, not as provider behaviour', async () => {
    // A `result` that does not validate is the test being wrong. Raising an `AIError` would let it
    // masquerade as the model misbehaving, and the worker's failure handling would absorb it.
    const service = new FakeAIEvaluationService({
      writing: {
        kind: 'result',
        // A score outside 0-100: allowed by the type, rejected by the schema.
        value: {
          ...defaultWritingEvaluation(),
          criteriaScores: { grammarAccuracy: { score: 150, rationale: 'Too good.' } },
        },
      },
    });

    await expect(service.evaluateWriting('text', 'rubric')).rejects.toThrow(/broken test fixture/);
    await expect(service.evaluateWriting('text', 'rubric')).rejects.not.toBeInstanceOf(AIError);
  });
});

describe('FakeAIEvaluationService — a script of responses', () => {
  it('consumes the script in call order, then repeats its last entry', async () => {
    // "Fails, then succeeds on the retry" and "always fails" are the same mechanism; the repeat is
    // what lets the second be stated once rather than padded to a retry budget the test would then
    // have to keep in step with MAX_ATTEMPTS.
    const service = new FakeAIEvaluationService({
      writing: [
        { kind: 'failure', error: new AIRetryableError('first attempt failed') },
        { kind: 'result', value: defaultWritingEvaluation() },
      ],
    });

    await expect(service.evaluateWriting('text', 'rubric')).rejects.toBeInstanceOf(AIRetryableError);
    await expect(service.evaluateWriting('text', 'rubric')).resolves.toEqual(defaultWritingEvaluation());
    // Third call repeats the last entry rather than running off the end of the script.
    await expect(service.evaluateWriting('text', 'rubric')).resolves.toEqual(defaultWritingEvaluation());
    expect(service.writingCallCount).toBe(3);
  });

  it('scripts each method independently', async () => {
    // The two job types fail for different reasons and must be able to say so separately: a writing
    // failure that also blocked Student Problems processing would be a different bug from the one
    // under test.
    const service = new FakeAIEvaluationService({
      writing: { kind: 'failure', error: new AIRetryableError('writing is down') },
    });

    await expect(service.evaluateWriting('text', 'rubric')).rejects.toBeInstanceOf(AIRetryableError);
    await expect(service.processStudentProblemsText('text')).resolves.toEqual(
      defaultStudentProblemsAnalysis(),
    );
  });
});
