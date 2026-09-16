import { z } from 'zod';
import type {
  StudentProblemsAnalysis,
  WritingEvaluation,
} from './AIEvaluationService.ts';

/**
 * Zod schemas for the JSON an LLM is expected to return (ARCHITECTURE Section 2, Section 3,
 * Section 4, Section 18 — canonical location for "AI output validation").
 *
 * ## Where this sits in the flow
 *
 * Section 3 puts validation between the model answering and the domain layer accepting:
 *
 *     AIEvaluationService.evaluateWriting(…) → zod schema validates the JSON response
 *       ├─ invalid / malformed → throw AIValidationError
 *       └─ valid → criterion-level scores returned
 *
 * So these schemas are applied **inside the provider**, and what crosses the boundary is a value
 * that has already been through them. Nothing downstream re-checks it: `JobService` persists what
 * it is handed, and `WritingScoreCalculator` computes with it. That is why the schemas are strict
 * and complete rather than a best-effort read of a loosely-shaped object — there is no second line
 * of defence behind them, deliberately, because a second validator is a second opinion about what
 * the model is allowed to return.
 *
 * ## The LLM is an untrusted input boundary
 *
 * A model response is not a trusted internal value; it is text produced by a remote service, in the
 * same category as an HTTP request body. Everything that is true of `validateBody` at the API edge
 * is true here: the shape is not assumed, and a value that does not match is refused rather than
 * coerced. Section 8 takes the refusal as a normal event and gives it a place to go — an
 * `AIValidationError` is retried once, on the reasoning that a re-prompt may succeed.
 *
 * ## Why each schema is annotated with the boundary's own type
 *
 * `WritingEvaluation` and `StudentProblemsAnalysis` are declared on the interface
 * (`src/ai/AIEvaluationService.ts`), because that is what a provider promises to return. Annotating
 * each schema `z.ZodType<T>` makes the compiler check the two against each other in the direction
 * that matters: if the boundary's type gains a field, the schema that does not validate it stops
 * compiling. Without the annotation the schema would happily infer its own, narrower type, the two
 * would look identical in review, and the gap would only appear as a field that is always
 * `undefined` at runtime.
 *
 * ## These schemas do not know about content
 *
 * The five rubric criterion keys, the 0–100 range's provenance, and the cap on corrections all live
 * in `content/versions/<version>/writing-rubric.json` — versioned with the questions, and frozen per
 * submission (Section 2). None of those values are restated here. A criterion key list compiled into
 * this file would be a second copy of a content decision, and the two would drift the first time the
 * team exercised the versioning the file exists to support. What is checked here is the *shape*;
 * checking that the shape is complete against the rubric a specific submission was graded under is
 * done where that rubric is actually in hand (see the note on `criteriaScores` below).
 */

/**
 * One criterion's judgment: a 0–100 score with its rationale (FR-WRITE-005).
 *
 * The range is enforced because a score outside it is not a difference of opinion, it is a number
 * that cannot be averaged into a 0–100 overall without the result being meaningless. The rationale
 * is required and non-empty because the authored rubric states it as a requirement of the response
 * (`outputRequirements.criterionRationaleRequired`), and a criterion score with nothing behind it is
 * exactly the "arbitrary single overall number" FR-WRITE-005 rules out — at criterion granularity
 * instead of at the top.
 *
 * Deliberately **not** `.int()`. The model returning 78.5 is a legitimate rubric judgment, and
 * rejecting it would spend a retry on a rounding preference. Where integrality genuinely matters is
 * the *overall* score, because `Submission.writingOverallScore` is an `Int?` column (Section 6) —
 * so landing on a whole number is `WritingScoreCalculator`'s obligation (T7.1.1), in the one place
 * that computes it. This is the same column-versus-value coupling recorded for `points` in
 * `src/content/contentSchemas.ts`, and it is recorded in both places for the same reason: whoever
 * next considers fractional scores should meet the constraint before they meet the failed write.
 */
const writingCriterionScoreSchema = z
  .object({
    score: z.number().min(0).max(100),
    rationale: z.string().min(1),
  })
  .strict();

/** One correction: what was written, what it should be, and why (FR-WRITE-007). */
const writingCorrectionSchema = z
  .object({
    original: z.string().min(1),
    corrected: z.string().min(1),
    explanation: z.string().min(1),
  })
  .strict();

/**
 * The complete writing evaluation.
 *
 * ## What is *not* here, and why its absence is the point
 *
 * There is no `overallScore` field. FR-WRITE-006 and Section 7 both reserve that number for
 * `WritingScoreCalculator`, computed from these criterion scores and the rubric weights — *"the AI
 * provider never computes a score, only criterion judgments."* A schema that accepted one would let
 * a model's own arithmetic reach the student's report, making the versioned weighting formula
 * decorative.
 *
 * ## On `criteriaScores` being a partial record
 *
 * The schema requires at least one entry and checks each entry's shape; it cannot require the five
 * approved criterion keys without restating content that belongs to `writing-rubric.json`. Pairing
 * the returned keys against the weights — and failing loudly when a weight has no score to apply to,
 * rather than silently computing a total that is short by that weight — is therefore
 * `WritingScoreCalculator`'s to do (T7.1.1), since the weights it reads come from the same file as
 * the criterion keys. It is called out here because this is where the gap would otherwise go
 * unnoticed: a missing criterion produces a *plausible* overall score, not an error.
 *
 * ## On the arrays being allowed to be empty
 *
 * FR-WRITE-007 requires the output to include strengths, weaknesses, corrections, and suggestions —
 * it does not require each to be non-empty, and it cannot sensibly: a response can be strong enough
 * that there is nothing to correct, which is a real outcome and not a malformed one. Requiring
 * `min(1)` would turn that outcome into a validation failure, then a retry, then — after the retry
 * fails the same way — a `failed_needs_review` for a student whose essay was graded perfectly well.
 * No cap is placed on how many corrections come back, either: FR-WRITE-008's "at most five" is
 * authored in the rubric's own `outputRequirements.maxCorrections`, and a second cap compiled into
 * this file would be a code copy of a content value.
 *
 * ## Why `.strict()`
 *
 * An unrecognised key means the field the model wrote is not the field the code reads, which is the
 * failure this file exists to catch — the same reasoning `src/content/contentSchemas.ts` gives. The
 * cost is real and worth stating: a model that adds an extra key to an otherwise-correct response
 * fails validation and spends its one retry on a cosmetic difference. The rubric instructions
 * already ask for "a single JSON object and nothing else", so the strict reading is the one the
 * prompt states; if the pilot shows models routinely adding keys, relaxing this to strip them is a
 * one-line change with a test to match.
 */
export const writingEvaluationSchema: z.ZodType<WritingEvaluation> = z
  .object({
    criteriaScores: z.record(z.string().min(1), writingCriterionScoreSchema).refine(
      (scores) => Object.keys(scores).length > 0,
      { message: 'at least one criterion score is required' },
    ),
    strengths: z.array(z.string()),
    weaknesses: z.array(z.string()),
    corrections: z.array(writingCorrectionSchema),
    suggestions: z.array(z.string()),
  })
  .strict();

/**
 * One derived difficulty category (FR-PROB-011).
 *
 * `label` is the model's own short wording rather than one of the statement set's area ids: Section
 * 4 and Section 8 both fix the calling signature as `processStudentProblemsText(text)`, so this
 * boundary is never given the content bundle's `areas` vocabulary to choose from. See
 * `StudentProblemsCategory` for why the quote is carried alongside the label.
 */
const studentProblemsCategorySchema = z
  .object({
    label: z.string().min(1),
    evidence: z.string().min(1),
  })
  .strict();

/**
 * The complete Student Problems analysis (FR-PROB-010/011).
 *
 * `normalizedText` must be non-empty: the provider is only asked to process a response the student
 * actually wrote (an empty one is refused before the call, and again as an `AINonRetryableError`),
 * so an empty normalization is a failed one. Accepting it would store an empty derived
 * representation beside a non-empty original and let the failure look like a success.
 *
 * `categories` may be empty, and that is not a defect: a response can describe a difficulty that
 * matches none of the model's categories, or decline to describe one at all. This is the AI's
 * interpretation of free text, and "nothing to categorize" is an honest answer to it — the same
 * reasoning that lets the strengths and corrections arrays above be empty.
 */
export const studentProblemsAnalysisSchema: z.ZodType<StudentProblemsAnalysis> = z
  .object({
    normalizedText: z.string().min(1),
    categories: z.array(studentProblemsCategorySchema),
  })
  .strict();
