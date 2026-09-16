import type { ProcessingJob } from '@prisma/client';
import type { StudentProblemsAnalysis, WritingEvaluation } from '../../ai/AIEvaluationService.ts';
import { AIError, AIValidationError } from '../../ai/errors.ts';
import { processingJobRepository, type ProcessingJobRepository } from '../../data/ProcessingJobRepository.ts';
import {
  submissionRepository,
  type SubmissionRepository,
  type SubmissionTx,
} from '../../data/SubmissionRepository.ts';
import { JOB_TYPES, isJobType } from './jobTypes.ts';

/**
 * The background job lifecycle (ARCHITECTURE Section 7, Section 8, Section 18 — canonical location
 * for "Background job lifecycle").
 *
 * Section 7 gives this class its boundary: *"Owns job claiming, success/failure transitions,
 * retry-count bookkeeping, and stale-job reclamation. The background worker loop is the **only**
 * caller — there is no staff-facing manual retry path, so retry behavior has exactly one entry
 * point."* So the three methods below are the whole of it, and the worker loop (T6.3.1) is the only
 * thing that calls them.
 *
 * Nothing in this file talks to an AI provider, and nothing in it knows what a rubric is. It is
 * handed a result that has already been schema-validated at the boundary and stores it. That is
 * deliberate and load-bearing for E7: the one thing this file must *not* do yet is compute a writing
 * score, because the weighting formula lives in the versioned rubric and belongs to
 * `WritingScoreCalculator` (T7.1.1, extended into `completeJob` by T7.3.1).
 */

/**
 * How many times a job may be attempted, and how long to wait between attempts.
 *
 * Parameters rather than module constants, and not because tests want to reach them — though they
 * do. Section 8's `MAX_ATTEMPTS = 3` and its `30s / 2min / 5min` schedule are *illustrative* values
 * in an illustrative sketch, and the pilot's real numbers are an operational decision that has not
 * been made. Compiling them in would turn a placeholder into a policy, and would make every test of
 * retry behaviour into a test of those particular numbers, since the only way to observe a backoff
 * is to wait it out.
 *
 * The production values live in the worker loop, alongside Section 8's `POLL_INTERVAL_MS`.
 */
export type RetryPolicy = {
  /** Total attempts allowed, including the first. Section 8's illustrative value is 3. */
  maxAttempts: number;
  /**
   * Delay before attempt *n* becomes claimable again, indexed from the first failure.
   *
   * Section 8: *"simple linear backoff — 30s, 2min, 5min — is sufficient at this volume."* Given as
   * a schedule rather than a base-and-multiplier because that is how the document states it, and
   * because a schedule is read off directly in a test with no clock involved: the assertion is on
   * the `nextAttemptAt` that was written, not on the passage of time. The last entry repeats if
   * attempts ever exceed the schedule.
   */
  backoffMs: readonly number[];
};

/** What `completeJob` did, or why it did nothing. */
export type CompleteJobOutcome = 'completed' | 'not_found';

/**
 * What `failJob` decided — whether the job went back on the queue or ended.
 *
 * Returned rather than swallowed because it is the one thing the worker has to report: Section 8's
 * whole answer to a stalled job is that it *"either completes on retry or exhausts its attempts and
 * becomes `failed_needs_review`"*, and which of those happened is what an operator reading the logs
 * during the pilot needs to see.
 */
export type FailJobOutcome = 'retry_scheduled' | 'failed_needs_review' | 'not_found';

/**
 * A schema-validation failure gets one retry, not the full budget — Section 8: *"a schema-validation
 * failure on a well-formed-but-wrong LLM response is treated as retryable once, since a re-prompt may
 * succeed."*
 *
 * Two, expressed as a total attempt count so it composes with `maxAttempts` in one comparison: the
 * attempt that failed, plus the single retry. A model that has twice returned the wrong shape for
 * one response is not going to be talked into it by a third identical prompt, and spending the rest
 * of the budget on it only delays the `failed_needs_review` a human needs to see.
 */
const VALIDATION_ATTEMPT_BUDGET = 2;

/**
 * The longest failure description stored on a job row.
 *
 * `ProcessingJob.lastError` is a free text column that receives messages from arbitrary failures,
 * including ones this code did not author — a Prisma error, for instance, carries the failed query
 * and its bound values. `src/ai/errors.ts` already requires AI failures to describe themselves
 * without quoting the student's text; this is the backstop for everything else, so one pathological
 * error cannot copy an essay into a second column or fill the row with a stack trace. Truncation is
 * marked, so a reader can tell a long message from a complete one.
 */
const MAX_LAST_ERROR_LENGTH = 500;

export type JobServiceDeps = {
  jobs: ProcessingJobRepository;
  submissions: SubmissionRepository;
};

export class JobService {
  private readonly deps: JobServiceDeps;

  constructor(deps: JobServiceDeps) {
    this.deps = deps;
  }

  /**
   * Claims the next job that is due, or returns null when there is none.
   *
   * A pass-through to the repository, and kept as a method rather than letting the worker reach the
   * repository directly for the reason Section 7 gives: claiming is part of the lifecycle this class
   * owns, so the only way to obtain a claim is through the only thing that can complete or fail one.
   * A second route to a claim would be a second route to a job that never gets closed out.
   */
  async claimNextJob(options: { staleThresholdMs: number }): Promise<ProcessingJob | null> {
    return this.deps.jobs.claimNextJob(options);
  }

  /**
   * Stores a succeeded AI result and marks the job done — **one** transaction (Section 6, boundary
   * #4).
   *
   * Section 6 states the invariant this method exists to hold: *"writing the AI result to `Submission`
   * and marking the `ProcessingJob` succeeded, one transaction, so a crash between 'wrote the score'
   * and 'marked the job done' cannot happen."* Both writes are below, inside one `transaction()`. The
   * state that boundary forbids — a submission carrying a finished evaluation whose job is still
   * `processing` — is not merely unlikely here, it is unrepresentable, because there is no commit
   * that contains one without the other.
   *
   * ## Why the job row is read rather than trusted from the caller
   *
   * The result alone is ambiguous: a writing evaluation and a Student Problems analysis are different
   * documents, and nothing in either says which submission it belongs to. Both facts come from the
   * row — `submissionId` and `jobType` — so the row is read here, inside the transaction, rather than
   * passed in. What the caller supplies is the evaluation and nothing about where it goes.
   *
   * ## The cast, and its single justification
   *
   * `result` is the union of the two result types, and the branch is chosen by the *stored* job type.
   * The caller is the worker, which read the same `jobType` off the same row to decide which
   * evaluation to run, so the two agree by construction — the same single-justification cast
   * `toDraftAnswers` makes about `answers`. It is narrowed here rather than taken as an argument so
   * that the row stays the one statement of what a job is.
   */
  async completeJob(
    jobId: string,
    result: WritingEvaluation | StudentProblemsAnalysis,
  ): Promise<CompleteJobOutcome> {
    return this.deps.submissions.transaction(async (tx) => {
      const job = await this.deps.jobs.findById(tx, jobId);

      if (!job) return 'not_found';

      // An unrecognized job type is not an expected case — nothing in this system writes one — so it
      // is raised rather than answered with an outcome. Silently doing nothing would leave the job
      // `processing` until it looked stalled and was reclaimed, forever; and guessing a branch would
      // write one kind of result into the other kind's columns. Thrown, it reaches the worker's
      // failure handling and ends up visible as `failed_needs_review`, which is what data this system
      // cannot interpret deserves.
      if (!isJobType(job.jobType)) {
        throw new Error(
          `Job ${jobId} has unrecognized jobType ${JSON.stringify(job.jobType)}; refusing to store a result for it.`,
        );
      }

      if (job.jobType === JOB_TYPES.writingEvaluation) {
        const evaluation = result as WritingEvaluation;

        // `writingOverallScore` is not written here, and its absence is the E6 boundary. The overall
        // score is a deterministic function of these criteria and the versioned rubric weights
        // (FR-WRITE-006, Section 7) and it is `WritingScoreCalculator`'s to compute — T7.1.1 builds
        // it, T7.3.1 calls it from this branch. Until then the column stays null rather than holding
        // a number this file made up, which is also why `writingStatus` alone is not enough to say
        // the report is complete.
        await this.deps.submissions.recordWritingEvaluation(tx, job.submissionId, {
          criteriaScores: evaluation.criteriaScores,
          feedback: {
            strengths: evaluation.strengths,
            weaknesses: evaluation.weaknesses,
            corrections: evaluation.corrections,
            suggestions: evaluation.suggestions,
          },
        });
      } else {
        const analysis = result as StudentProblemsAnalysis;

        // Only the derived column is written (Section 6, Section 12). The student's original text is
        // in `problemsOpenTextOriginal`, which this path cannot reach — FR-PROB-009 makes it the
        // record and FR-PROB-011 requires the AI's reading of it to be stored separately.
        await this.deps.submissions.recordStudentProblemsAnalysis(tx, job.submissionId, {
          normalizedText: analysis.normalizedText,
          categories: analysis.categories,
        });
      }

      await this.deps.jobs.markSucceeded(tx, jobId);

      return 'completed';
    });
  }

  /**
   * Records a failed attempt: either back on the queue after a delay, or terminally
   * `failed_needs_review` (Section 8).
   *
   * ## What decides the outcome
   *
   * Three things, in this order: whether the failure is retryable at all (the `retryable` flag the
   * AI boundary's error classes carry — a blank response will be blank on the next attempt too),
   * whether its particular budget allows another attempt (a validation failure gets one), and
   * whether `attemptCount` has reached that budget. Everything the decision needs comes from the
   * error and the policy; none of it is inferred from the job.
   *
   * ## Why the submission's status is written here and not by the caller
   *
   * A job ending in `failed_needs_review` and its submission's `writingStatus` saying the same are
   * one fact, so they are written in one transaction. FR-WRITE-011 and FR-PROB-013 both require the
   * status to be recorded *instead of* losing the response, and FR-FEEDBACK-007 requires the student
   * to see it rather than an indefinite "in progress" — a job that had given up while its submission
   * still said `pending` would be exactly that indefinite state.
   *
   * ## What every path leaves alone
   *
   * The retry path writes only job bookkeeping, and the terminal path writes one status column.
   * `answers.writing.essayText` and `problemsOpenTextOriginal` are not named by any statement this
   * method makes — "the original response is preserved" is a property of the write being this
   * narrow, not of a caller remembering not to overwrite it (FR-WRITE-011, FR-PROB-013, Section 12).
   */
  async failJob(jobId: string, error: unknown, policy: RetryPolicy): Promise<FailJobOutcome> {
    return this.deps.submissions.transaction(async (tx) => {
      const job = await this.deps.jobs.findById(tx, jobId);

      if (!job) return 'not_found';

      // Section 8 puts the increment here rather than in the claim: an attempt is counted when it
      // *fails*, so `maxAttempts` counts attempts rather than claims.
      const attemptCount = job.attemptCount + 1;
      const lastError = describeError(error);

      if (shouldRetry(error, attemptCount, policy)) {
        await this.deps.jobs.markForRetry(tx, jobId, {
          attemptCount,
          nextAttemptAt: new Date(Date.now() + backoffFor(attemptCount, policy.backoffMs)),
          lastError,
        });

        return 'retry_scheduled';
      }

      await this.deps.jobs.markFailedNeedsReview(tx, jobId, { attemptCount, lastError });
      await this.markSubmissionNeedsReview(tx, job);

      return 'failed_needs_review';
    });
  }

  /**
   * Points the submission's matching status column at the outcome.
   *
   * The `switch` writes only the column belonging to *this* job's type, which is what makes the two
   * job types independently failable — FR-WRITE-011 and FR-PROB-013 are separate failure modes
   * (Section 6), and a writing failure that also marked Student Problems processing failed would
   * report a problem that does not exist and hide the one that does.
   *
   * An unrecognized job type reaches no branch: there is no column it could honestly describe, and
   * the job row itself is already ended by the caller.
   */
  private async markSubmissionNeedsReview(tx: SubmissionTx, job: ProcessingJob): Promise<void> {
    if (job.jobType === JOB_TYPES.writingEvaluation) {
      await this.deps.submissions.markWritingEvaluationNeedsReview(tx, job.submissionId);
      return;
    }

    if (job.jobType === JOB_TYPES.studentProblemsText) {
      await this.deps.submissions.markProblemsTextNeedsReview(tx, job.submissionId);
    }
  }
}

/**
 * Whether this failure earns another attempt.
 *
 * ## Errors from outside the AI boundary
 *
 * `error` is `unknown` because that is what a `catch` gives you, and not every failure that reaches
 * `failJob` came from the provider: `completeJob` raises for an unrecognized job type, and a
 * database write can fail. Those are treated as **retryable**, which is the safer of the two wrong
 * answers available. A transient database failure that was marked terminal would abandon a student's
 * evaluation over a blip; a deterministic bug that is retried three times still ends at
 * `failed_needs_review`, just later, and the delay is bounded by the schedule. Errors that are
 * genuinely permanent arrive as `AINonRetryableError`, which says so.
 */
function shouldRetry(error: unknown, attemptCount: number, policy: RetryPolicy): boolean {
  if (error instanceof AIError && !error.retryable) return false;

  const budget =
    error instanceof AIValidationError ? VALIDATION_ATTEMPT_BUDGET : policy.maxAttempts;

  return attemptCount < budget;
}

/** The delay before the given attempt, from Section 8's schedule. The last entry repeats. */
function backoffFor(attemptCount: number, schedule: readonly number[]): number {
  if (schedule.length === 0) return 0;

  const index = Math.min(attemptCount, schedule.length) - 1;

  return schedule[index] ?? 0;
}

/**
 * A message for the job row, bounded and never a bare object dump.
 *
 * Prefers `Error.message` because that is where every failure this system raises puts its
 * description. A thrown non-`Error` — which happens — is described by its type rather than by
 * stringifying it, since stringifying a value that came from the request or the model is how
 * unvetted text ends up in a column nothing sanitizes.
 */
function describeError(error: unknown): string {
  const message =
    error instanceof Error ? error.message : `Non-Error thrown: ${typeof error}`;

  if (message.length <= MAX_LAST_ERROR_LENGTH) return message;

  return `${message.slice(0, MAX_LAST_ERROR_LENGTH)}… [truncated]`;
}

let instance: JobService | undefined;

/**
 * The process-wide service, wired to the shared repositories.
 *
 * Lazy, like `getSubmissionService()`: importing this module for its *type* must not open a database
 * connection.
 */
export function getJobService(): JobService {
  instance ??= new JobService({
    jobs: processingJobRepository,
    submissions: submissionRepository,
  });

  return instance;
}
