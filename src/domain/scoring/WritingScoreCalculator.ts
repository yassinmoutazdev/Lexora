import type { WritingCriterionScore } from '../../ai/AIEvaluationService.ts';

/**
 * Computes the 0–100 overall writing score from criterion judgments and versioned rubric weights
 * (ARCHITECTURE Section 7, Section 18 — canonical location for "Writing score calculation").
 *
 * ## What this function owns, and why the boundary is drawn here
 *
 * Section 7 is explicit: *"The AI provider never computes a score, only criterion judgments."*
 * `writingOverallScore` is an `Int?` column (Section 6), so landing on a whole number is this
 * function's obligation, not the caller's. The weights come from the same versioned bundle as the
 * criteria keys (`writing-rubric.json` → `ContentLoader.writingRubricWeights`), so the pairing is
 * by construction — no second copy of the criterion list can drift.
 *
 * ## The formula
 *
 * A fixed weighted sum:
 *
 *     overall = Σ (criterionScore[key].score × weights[key] / 100)
 *
 * The division by 100 is because `writing-rubric.json` expresses weights as percentages that sum to
 * 100 (validated in `src/content/contentSchemas.ts`). The rubric's `scoreRange` is also 0–100, so
 * the overall is on the same scale.
 *
 * ## Integrality
 *
 * The column is `Int?`, so the result must be an integer. The rubric allows fractional criterion
 * scores (a model returning 78.5 is a legitimate judgment — `src/ai/schemas.ts` does not require
 * `.int()`), so the weighted sum can be fractional. The rounding rule is:
 *
 *     Math.round(weightedSum)
 *
 * This is the same column-versus-value coupling recorded for `points` in `src/content/contentSchemas.ts`:
 * whole numbers at the leaves guarantee whole numbers at the root, but when the leaves may be
 * fractional the root must round. The rule is recorded here so whoever next considers fractional
 * scores meets the constraint before they meet the failed write.
 *
 * ## Completeness
 *
 * The schema in `src/ai/schemas.ts` cannot require the five approved criterion keys without
 * restating content that belongs to `writing-rubric.json`. So `criteriaScores` is a partial record
 * on purpose — but a weight with no matching score silently shrinks the total, producing a
 * plausible but wrong number. This function **fails loudly** when a criterion the rubric weights is
 * missing from the evaluation. That obligation is recorded in `src/ai/schemas.ts` pointing at this
 * task.
 */

/** A complete set of rubric weights: criterion key → percentage (sum = 100). */
export type WritingRubricWeights = Record<string, number>;

/** The result of computing the overall score. */
export type WritingScoreResult = {
  /** The 0–100 overall score, rounded to the nearest integer. */
  overallScore: number;
  /** The unrounded weighted sum, for transparency/debugging. */
  weightedSum: number;
};

/**
 * Computes the overall writing score.
 *
 * @param criteriaScores Criterion judgments from the validated LLM output.
 * @param weights The rubric weights from the submission's frozen content version.
 *
 * @throws {Error} If any weighted criterion is missing from the evaluation, or if weights do not sum to 100.
 */
export function computeOverallScore(
  criteriaScores: Record<string, WritingCriterionScore>,
  weights: WritingRubricWeights,
): WritingScoreResult {
  // Weights are validated at content load time to sum to 100 and to match the criteria keys.
  // We re-check the sum here as a defence-in-depth: if the caller passes a partial or mutated
  // object, the formula would produce a quietly wrong number rather than an error.
  const totalWeight = Object.values(weights).reduce((sum, w) => sum + w, 0);
  if (Math.abs(totalWeight - 100) > 1e-9) {
    throw new Error(
      `Rubric weights must sum to 100 (got ${totalWeight}). This should have been caught at content load.`,
    );
  }

  // Every weighted criterion must have a score. The schema allows a partial record (it cannot
  // name the keys without duplicating content), so a missing criterion would silently reduce the
  // total — producing a plausible but incorrect overall score. Fail loudly instead.
  for (const key of Object.keys(weights)) {
    if (!(key in criteriaScores)) {
      throw new Error(
        `Missing criterion score for weighted criterion "${key}". ` +
          `The rubric weights this criterion but the evaluation did not return it. ` +
          `Available scores: ${Object.keys(criteriaScores).join(', ')}`,
      );
    }
  }

  // Compute the weighted sum. Each criterion's score is 0–100; weights are percentages summing to 100.
  let weightedSum = 0;
  for (const [key, weight] of Object.entries(weights)) {
    const criterionScore = criteriaScores[key];
    // We already verified all weighted keys exist above, so this is safe.
    const { score } = criterionScore!;
    if (score < 0 || score > 100) {
      throw new Error(
        `Criterion "${key}" has score ${score}, which is outside the 0–100 range. ` +
          `This should have been caught by the validation schema.`,
      );
    }
    weightedSum += score * (weight / 100);
  }

  // Round to the nearest integer because `Submission.writingOverallScore` is `Int?`.
  const overallScore = Math.round(weightedSum);

  // Clamp to 0–100 as a final safeguard (the math guarantees it, but the column constraint is absolute).
  if (overallScore < 0 || overallScore > 100) {
    throw new Error(`Computed overall score ${overallScore} is outside the 0–100 range.`);
  }

  return { overallScore, weightedSum };
}
