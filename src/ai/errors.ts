/**
 * The failure vocabulary of the AI boundary (ARCHITECTURE Section 4, Section 18 — canonical
 * location for the AI integration boundary).
 *
 * ## Why failures get named types instead of being plain `Error`s
 *
 * Section 8 splits every AI failure into two kinds, and the split is not cosmetic: it decides
 * whether the job goes back on the queue or becomes `failed_needs_review` — the state a student
 * sees as "processing failed" and staff see as work to look at. Only the code that talked to the
 * provider knows which kind happened, because the difference is in *how* the call failed (a socket
 * that timed out versus a model that answered with the wrong shape). So the classification travels
 * with the error, and the policy that acts on it stays where Section 7 puts it — `JobService`, which
 * owns retry bookkeeping and is the only caller of these types.
 *
 * ## What these messages may contain
 *
 * Nothing that came from the student. `JobService.failJob` records the message on the job row
 * (`ProcessingJob.lastError`, Section 6), and that row is read by the staff dashboard — so a message
 * carrying the essay text would copy student writing into a second place, outside the column that
 * FR-PROB-009/FR-WRITE-011 make the record of it. Describe the failure ("timed out after 60000ms"),
 * never the input it failed on.
 */

/**
 * Base class for every failure raised across the AI boundary.
 *
 * Exists so a caller can ask one question — "did this come from the AI boundary?" — without
 * enumerating the subclasses. `JobService.failJob` is the caller that needs it.
 */
export abstract class AIError extends Error {
  /**
   * Whether running the same work again could plausibly produce a different outcome.
   *
   * Declared abstract rather than defaulted, so a new subclass cannot arrive without stating its
   * classification: a missing answer here would silently inherit "retryable", and a permanently
   * broken job would be retried forever instead of surfacing to staff.
   *
   * This is a statement about the *failure*, not a decision to act. Attempt budgets and backoff
   * live in `JobService` (Section 7).
   */
  abstract readonly retryable: boolean;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
  }
}

/**
 * The provider answered, but not in the shape `src/ai/schemas.ts` requires.
 *
 * Retryable, with a caveat Section 8 states in its own words: *"a schema-validation failure on a
 * well-formed-but-wrong LLM response is treated as retryable once, since a re-prompt may succeed."*
 * One retry, not an open budget — a model that has twice returned the wrong shape for one response
 * is not going to be talked into it by a third identical prompt.
 *
 * That "once" is a budget, so it is `JobService`'s to enforce, and it is the reason this is a
 * distinct class rather than an `AIRetryableError`: both are `retryable`, and they differ in how
 * many attempts that buys.
 */
export class AIValidationError extends AIError {
  override readonly name = 'AIValidationError';
  override readonly retryable = true;
}

/**
 * The call itself failed in a way that says nothing about the input — a request that timed out, a
 * dropped connection, or a provider rejecting the call because its own queue is full (Section 8
 * names all three).
 *
 * The ordinary retryable case: the same request, sent again, is expected to succeed.
 */
export class AIRetryableError extends AIError {
  override readonly name = 'AIRetryableError';
  override readonly retryable = true;
}

/**
 * The input cannot be evaluated, so no retry can help.
 *
 * Section 8 gives the example: an empty response. The provider raises this rather than sending a
 * blank essay to be scored, because a model asked to grade nothing will still answer — with a score,
 * and with feedback about a text that does not exist. A wrong number that looks real is worse than a
 * refusal, since a refusal is a status the student and staff can both see (FR-WRITE-011).
 *
 * Note that the same category of input is also refused *before* a job is created, where that is
 * possible (Section 8: incomplete sections never reach submission). This class covers the case where
 * something empty nevertheless reached the AI boundary — the worker passes no opinion, and the
 * provider is the last place a blank input can still be stopped.
 */
export class AINonRetryableError extends AIError {
  override readonly name = 'AINonRetryableError';
  override readonly retryable = false;
}

/**
 * The provider does not serve the model this deployment asked for.
 *
 * A subclass of the non-retryable case rather than a retryable one, because the classification is
 * not in doubt: a model tag that does not exist will not exist on the next attempt either, and
 * `JobService` already routes any non-retryable `AIError` straight to `failed_needs_review` without
 * spending an attempt.
 *
 * ## Why it is named separately
 *
 * `OllamaProvider.chatEndpoint` records the trap this shares with a malformed `OLLAMA_BASE_URL`: a
 * 404 becomes a non-retryable failure, so *"a misconfiguration … looks from the dashboard exactly
 * like a provider refusing to grade."* Reusing `AINonRetryableError` for this leaves that symptom
 * unchanged — every job in the queue fails at once, and the only way to tell a wrong model tag from
 * a genuinely broken provider is to read a truncated JSON error body out of `ProcessingJob.lastError`
 * and parse it by eye.
 *
 * Naming the case is what makes the misconfiguration diagnosable, and at the pilot's scale it is the
 * *likely* failure: `MODEL_NAME` is a single constant the deployment has already had to change once,
 * and getting it wrong is a one-line mistake whose only symptom is that nothing grades.
 *
 * The message names the model and the two settings that produce it. Neither is a secret — the model
 * tag appears in no credential, and `OLLAMA_BASE_URL`'s value is not the API key — so this does not
 * weaken the rule in the file header above. The API key is still never in a message.
 */
export class AIModelNotFoundError extends AIError {
  override readonly name = 'AIModelNotFoundError';
  override readonly retryable = false;
}
