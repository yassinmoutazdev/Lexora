/**
 * The AI integration boundary (ARCHITECTURE Section 1, Section 4, Section 18 — canonical location
 * for the AI boundary; `OllamaProvider` is the implementation).
 *
 * ## What this seam is for
 *
 * Everything above it — the worker loop, `JobService`, the report — is written against this
 * interface and knows nothing about prompts, HTTP, or which model answers. Everything below it —
 * today one provider, later possibly another (Section 17) — knows nothing about jobs, retries, or
 * the database. The payoff is concrete and already committed to in Section 15: the entire automated
 * suite runs against a fake implementing this interface, so CI never depends on Ollama Cloud being
 * reachable or within quota.
 *
 * ## What an implementation promises
 *
 * 1. **It returns validated output, or it throws.** The zod schemas in `src/ai/schemas.ts` are
 *    applied inside the provider, before anything is returned — Section 3 puts that step between
 *    "the model answered" and "the domain layer accepts it". A caller therefore never has to
 *    re-check a result, and never has to wonder whether it got JSON or prose.
 * 2. **It throws only `AIError` subclasses** (`src/ai/errors.ts`), so the worker's failure handling
 *    can classify without guessing. Anything else escaping from here is a bug in the provider.
 * 3. **It never computes a score.** Section 7 is explicit that the overall writing score is
 *    `WritingScoreCalculator`'s, computed from the criterion judgments: *"the AI provider never
 *    computes a score, only criterion judgments."* The 0–100 overall is not a field below, and its
 *    absence is deliberate — a provider that returned one would make the weighting formula
 *    unenforceable.
 * 4. **It never renders the input into a message it throws.** See `src/ai/errors.ts`.
 */

/**
 * One criterion's judgment: the score, and why.
 *
 * The rationale is required rather than optional because FR-WRITE-005 asks for criterion-level
 * evaluations *"with supporting evidence/rationale where practical"*, and the authored rubric
 * instructions (`writing-rubric.json`, `outputRequirements.criterionRationaleRequired`) state it as a
 * hard requirement of the response. Making it optional here would let a provider drop it and still
 * type-check, which is the one way that requirement could quietly stop being met.
 *
 * The score is a plain `number` here. Its 0–100 bounds and its integrality-or-not are
 * `src/ai/schemas.ts`'s to enforce, because that is what validates the model's actual output; this
 * type describes the boundary, not the validator.
 */
export type WritingCriterionScore = {
  score: number;
  rationale: string;
};

/**
 * One high-value correction (FR-WRITE-007).
 *
 * Three fields because a correction is only actionable with all three: what was written, what it
 * should be, and why. FR-WRITE-008 caps how many of these come back — the cap belongs to the prompt
 * and the schema, not to this type.
 */
export type WritingCorrection = {
  original: string;
  corrected: string;
  explanation: string;
};

/**
 * What a writing evaluation returns: criterion judgments and feedback, and no overall score
 * (FR-WRITE-006/007).
 *
 * ## Why `criteriaScores` is keyed by criterion key rather than being five fixed fields
 *
 * The five criteria are approved and stable (FR-WRITE-009), so five fixed fields would type-check
 * perfectly well today. They are keyed instead because the *keys and the weights come from the same
 * versioned file* — `writing-rubric.json`'s `criteria[].key` and its `weights`, which
 * `ContentLoader` projects to `writingRubricWeights: Record<string, number>`. A fixed-field type
 * would have to be kept in step with that file by hand, and the failure mode of drift is silent: a
 * criterion the model returns under a name no weight mentions is a criterion that scores nothing,
 * and the overall number would still look reasonable. Keyed, the two are paired by construction in
 * `WritingScoreCalculator` (Section 7, T7.1.1).
 */
export type WritingEvaluation = {
  /** One entry per rubric criterion key. */
  criteriaScores: Record<string, WritingCriterionScore>;
  strengths: string[];
  weaknesses: string[];
  corrections: WritingCorrection[];
  suggestions: string[];
};

/**
 * One difficulty category the model identified in a Student Problems response (FR-PROB-011).
 *
 * ## Why this carries `evidence`
 *
 * FR-PROB-011 requires AI-generated interpretations to be *"clearly labeled as derived data — not
 * presented as the student's original words or as guaranteed fact."* A category that cannot point
 * at the wording it came from is an assertion with nothing behind it, and staff reading it in the
 * dashboard (E8) would have no way to tell a supported reading from a plausible-sounding invention.
 * The quote is what makes "derived" checkable rather than a label the UI is trusted to apply.
 *
 * ## Why `label` is the model's own wording, not a content area id
 *
 * Section 4 and Section 8 both fix this method's signature as `processStudentProblemsText(text)` —
 * the response text and nothing else — even though `content` is in scope at the call site (Section 8
 * shows `content` resolved for the writing branch and not passed to this one). So the content
 * bundle's `areas` vocabulary is deliberately not available here, and a category cannot be keyed to
 * one of those ids without either inventing a taxonomy or changing the signature. It is the model's
 * short description of the difficulty, and grouping it against the statement set's areas is a
 * question for whatever reads the derived data (E8), not a claim made at this boundary.
 */
export type StudentProblemsCategory = {
  label: string;
  evidence: string;
};

/**
 * What Student Problems processing returns — the derived column and nothing else (FR-PROB-010/011).
 *
 * `normalizedText` is an English-normalized or translated representation of the student's response:
 * the Arabic case FR-PROB-010 names, and for an English response a cleaned-up rendering of it. It is
 * *derived*, and Section 6 keeps it in `problemsTextDerived` precisely so it can never be mistaken
 * for the response itself — the original is `problemsOpenTextOriginal`, written once at submission
 * and never overwritten.
 *
 * There is no field here for the original, and its absence is the point: an implementation has
 * nowhere to put the student's text even if it wanted to, and the only column the worker writes is
 * the derived one (Section 12, T7.4.1).
 */
export type StudentProblemsAnalysis = {
  normalizedText: string;
  categories: StudentProblemsCategory[];
};

/**
 * The interface every AI provider implements, and every consumer of AI output depends on.
 *
 * Deliberately two methods and no more. There is no "evaluate anything" method and no options bag:
 * the two background job types (Section 6) are the two pieces of work this system has, and a
 * signature that could express a third would invite one before the architecture has approved it.
 */
export interface AIEvaluationService {
  /**
   * Scores one free-writing response against the rubric.
   *
   * @param responseText The student's writing, resolved from the Submission row — never from the
   *   job (Section 8), and never anything the client sent on this request.
   * @param rubricInstructions The evaluation prompt from the submission's **frozen**
   *   `contentVersion` (`ContentLoader.writingRubricInstructions`). Passed in rather than read by the
   *   provider, so the provider cannot resolve "current" content and grade a response against a
   *   rubric its student was never given (Section 2, Section 12).
   *
   *   The parameter keeps its name, but what arrives is a composed projection of that version's
   *   `writing-rubric.json` **and** `writing-prompt.json`: the authored rubric instructions, the task
   *   the response answers, and the output contract its JSON must satisfy. The task is included
   *   because `taskCompletion` is defined in terms of it — *"addresses the prompt … meets the
   *   expected length"* — and a provider cannot judge that criterion without the prompt and the
   *   length target. The output contract is included because `src/ai/schemas.ts` is `.strict()`, so a
   *   response that guesses a top-level key name fails validation outright. Composition lives in
   *   `ContentLoader` rather than here so that the signature stays the two arguments Section 4 and
   *   Section 8 fix, and so a second provider (Section 17) inherits it without re-deriving it.
   *
   * @throws {AIValidationError} the model's output did not match `src/ai/schemas.ts`.
   * @throws {AIRetryableError} the call failed in a way a retry may resolve (Section 8).
   * @throws {AINonRetryableError} there is nothing here to evaluate.
   */
  evaluateWriting(responseText: string, rubricInstructions: string): Promise<WritingEvaluation>;

  /**
   * Normalizes one Student Problems open-text response and extracts its difficulty categories.
   *
   * @param responseText The student's original open-text response, in English or Arabic
   *   (FR-PROB-004). Read from `Submission.problemsOpenTextOriginal`.
   *
   * @throws {AIValidationError} the model's output did not match `src/ai/schemas.ts`.
   * @throws {AIRetryableError} the call failed in a way a retry may resolve (Section 8).
   * @throws {AINonRetryableError} there is nothing here to evaluate.
   */
  processStudentProblemsText(responseText: string): Promise<StudentProblemsAnalysis>;
}
