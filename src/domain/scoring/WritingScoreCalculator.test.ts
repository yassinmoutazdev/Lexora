import { describe, expect, it } from 'vitest';
import { computeOverallScore, type WritingRubricWeights } from './WritingScoreCalculator.ts';
import type { WritingCriterionScore } from '../../ai/AIEvaluationService.ts';

/**
 * Unit coverage for `WritingScoreCalculator` (T7.1.1, ARCHITECTURE Section 15 — "Weighted formula
 * correctness against fixture weights; boundary values (0, 100)").
 *
 * The calculator is a pure function with no database or content-loader dependency. The tests pass
 * fixture weights and criteria scores and assert the formula's behavior. The real (provisional)
 * weights from `writing-rubric.json` are not compiled in; the formula is tested against
 * controlled fixtures so a weight change in content does not make a test fail for the wrong reason.
 */

const FIXTURE_WEIGHTS: WritingRubricWeights = {
  grammarAccuracy: 25,
  vocabulary: 20,
  sentenceStructure: 20,
  coherence: 20,
  taskCompletion: 15,
};

function criterion(score: number, rationale = 'Fixture rationale.'): WritingCriterionScore {
  return { score, rationale };
}

function allFive(scores: Partial<Record<keyof typeof FIXTURE_WEIGHTS, number>>): Record<string, WritingCriterionScore> {
  const keys = Object.keys(FIXTURE_WEIGHTS) as (keyof typeof FIXTURE_WEIGHTS)[];
  const result: Record<string, WritingCriterionScore> = {};
  for (const key of keys) {
    result[key] = criterion(scores[key] ?? 80);
  }
  return result;
}

describe('computeOverallScore — formula correctness', () => {
  it('computes the weighted sum correctly against fixture weights', () => {
    // 80 * 0.25 + 70 * 0.20 + 90 * 0.20 + 60 * 0.20 + 50 * 0.15
    // = 20 + 14 + 18 + 12 + 7.5 = 71.5 → rounds to 72
    const scores = allFive({
      grammarAccuracy: 80,
      vocabulary: 70,
      sentenceStructure: 90,
      coherence: 60,
      taskCompletion: 50,
    });

    const result = computeOverallScore(scores, FIXTURE_WEIGHTS);

    expect(result.weightedSum).toBe(71.5);
    expect(result.overallScore).toBe(72);
  });

  it('returns 100 when every criterion is 100', () => {
    const scores = allFive({
      grammarAccuracy: 100,
      vocabulary: 100,
      sentenceStructure: 100,
      coherence: 100,
      taskCompletion: 100,
    });

    const result = computeOverallScore(scores, FIXTURE_WEIGHTS);

    expect(result.weightedSum).toBe(100);
    expect(result.overallScore).toBe(100);
  });

  it('returns 0 when every criterion is 0', () => {
    const scores = allFive({
      grammarAccuracy: 0,
      vocabulary: 0,
      sentenceStructure: 0,
      coherence: 0,
      taskCompletion: 0,
    });

    const result = computeOverallScore(scores, FIXTURE_WEIGHTS);

    expect(result.weightedSum).toBe(0);
    expect(result.overallScore).toBe(0);
  });

  it('handles fractional criterion scores correctly', () => {
    // Fractional scores are allowed by the validation schema (no .int()).
    // 78.5 * 0.25 + 82.3 * 0.20 + 75.0 * 0.20 + 88.7 * 0.20 + 90.1 * 0.15
    // = 19.625 + 16.46 + 15.0 + 17.74 + 13.515 = 82.34 → rounds to 82
    const scores = allFive({
      grammarAccuracy: 78.5,
      vocabulary: 82.3,
      sentenceStructure: 75.0,
      coherence: 88.7,
      taskCompletion: 90.1,
    });

    const result = computeOverallScore(scores, FIXTURE_WEIGHTS);

    expect(result.weightedSum).toBeCloseTo(82.34, 1);
    expect(result.overallScore).toBe(82);
  });

  it('rounds .5 up (standard Math.round behavior)', () => {
    // To get weightedSum = 71.5 with grammarAccuracy weight = 25%:
    // grammarAccuracy score * 0.25 = 71.5 → grammarAccuracy score = 71.5 / 0.25 = 286
    // But scores must be 0-100. So instead, use multiple criteria to produce .5
    // 80 * 0.25 + 70 * 0.20 + 90 * 0.20 + 60 * 0.20 + 50 * 0.15 = 71.5
    const scores = allFive({
      grammarAccuracy: 80,
      vocabulary: 70,
      sentenceStructure: 90,
      coherence: 60,
      taskCompletion: 50,
    });

    const result = computeOverallScore(scores, FIXTURE_WEIGHTS);

    expect(result.weightedSum).toBe(71.5);
    expect(result.overallScore).toBe(72);
  });
});

describe('computeOverallScore — completeness check', () => {
  it('throws when a weighted criterion is missing from the evaluation', () => {
    const scores = allFive({});
    delete scores.grammarAccuracy; // Missing a weighted criterion

    expect(() => computeOverallScore(scores, FIXTURE_WEIGHTS)).toThrow(
      /Missing criterion score for weighted criterion "grammarAccuracy"/,
    );
  });

  it('throws with a helpful message listing available scores', () => {
    const scores = allFive({});
    delete scores.vocabulary;

    expect(() => computeOverallScore(scores, FIXTURE_WEIGHTS)).toThrow(
      /Available scores: grammarAccuracy, sentenceStructure, coherence, taskCompletion/,
    );
  });

  it('does not throw when extra criteria are present beyond the weighted ones', () => {
    // The schema is strict, so this shouldn't happen in practice, but the formula should be
    // robust: extra keys are simply ignored because they have no weight.
    const scores = { ...allFive({}), extraCriterion: criterion(50) };

    const result = computeOverallScore(scores, FIXTURE_WEIGHTS);

    expect(result.overallScore).toBe(80); // All 80s with equal-ish weights ≈ 80
  });
});

describe('computeOverallScore — weight validation', () => {
  it('throws when weights do not sum to 100', () => {
    const badWeights: WritingRubricWeights = {
      grammarAccuracy: 30,
      vocabulary: 20,
      sentenceStructure: 20,
      coherence: 20,
      taskCompletion: 15, // Total = 105
    };

    expect(() => computeOverallScore(allFive({}), badWeights)).toThrow(
      /Rubric weights must sum to 100 \(got 105\)/,
    );
  });

  it('throws when weights sum to less than 100', () => {
    const badWeights: WritingRubricWeights = {
      grammarAccuracy: 20,
      vocabulary: 20,
      sentenceStructure: 20,
      coherence: 20,
      taskCompletion: 10, // Total = 90
    };

    expect(() => computeOverallScore(allFive({}), badWeights)).toThrow(
      /Rubric weights must sum to 100 \(got 90\)/,
    );
  });
});

describe('computeOverallScore — score range validation', () => {
  it('throws when a criterion score is below 0', () => {
    const scores = allFive({ grammarAccuracy: -1 });

    expect(() => computeOverallScore(scores, FIXTURE_WEIGHTS)).toThrow(
      /Criterion "grammarAccuracy" has score -1, which is outside the 0–100 range/,
    );
  });

  it('throws when a criterion score is above 100', () => {
    const scores = allFive({ vocabulary: 101 });

    expect(() => computeOverallScore(scores, FIXTURE_WEIGHTS)).toThrow(
      /Criterion "vocabulary" has score 101, which is outside the 0–100 range/,
    );
  });
});

describe('computeOverallScore — Student Problems never reaches the writing score', () => {
  /**
   * FR-PROB-008/FR-PROB-012 and T7.4.3. The calculator's two arguments are criterion judgments and
   * rubric weights; there is no Student Problems data in either and none in scope, which is why
   * this is a structural guard rather than a comparison.
   *
   * Stated with its limits, because a test that overclaims is worse than no test: this catches a
   * dependency added as a *third parameter* — the shape it would most plausibly take, since the
   * worker has the submission in hand when it calls this. It does not catch one smuggled in through
   * the two existing arguments, and it could not: a criterion score is a number, so nothing about
   * its provenance is visible here. What rules that out is that only `JobService.completeJob` calls
   * this function, with `result.criteriaScores` straight from the validated AI output.
   */
  it('takes exactly the two arguments a score is a function of', () => {
    expect(computeOverallScore.length).toBe(2);
  });

  it('scores purely from its arguments, with no ambient state to read', () => {
    // The complementary claim: two calls with the same arguments agree *and* the result is unchanged
    // by anything else having happened in the process between them.
    const scores = allFive({ grammarAccuracy: 60, vocabulary: 70 });

    const first = computeOverallScore(scores, FIXTURE_WEIGHTS);
    const second = computeOverallScore({ ...scores }, FIXTURE_WEIGHTS);

    expect(second).toEqual(first);
  });
});

describe('computeOverallScore — determinism', () => {
  it('produces the same result for the same inputs', () => {
    const scores = allFive({
      grammarAccuracy: 78.5,
      vocabulary: 82.3,
      sentenceStructure: 75.0,
      coherence: 88.7,
      taskCompletion: 90.1,
    });

    const r1 = computeOverallScore(scores, FIXTURE_WEIGHTS);
    const r2 = computeOverallScore(scores, FIXTURE_WEIGHTS);

    expect(r1).toEqual(r2);
  });
});