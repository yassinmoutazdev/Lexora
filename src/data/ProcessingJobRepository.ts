import type { Prisma, ProcessingJob } from '@prisma/client';
import { getPrismaClient } from './prismaClient.ts';

/**
 * Data access for `ProcessingJob` (ARCHITECTURE Section 8, Section 18 — "Database access:
 * `src/data/*Repository.ts`").
 *
 * Like `SubmissionRepository`, this layer holds queries and not rules: it does not decide how many
 * attempts a job is allowed, how long to wait between them, or what a failure means. Those are
 * `JobService`'s (Section 7), and the values that parameterize them are the caller's — see
 * `ClaimOptions` below.
 */

/**
 * What a claim is told, rather than what it assumes.
 *
 * A parameter and not a module constant, because both values are operational policy that a test has
 * to be able to set: Section 8's `STALE_THRESHOLD_MS = 5 * 60_000` is illustrative, and a test that
 * proves stale reclamation by sleeping five minutes is not a test anyone will keep. The production
 * values live where Section 8's own sketch puts them — the worker loop (T6.3.1).
 */
export type ClaimOptions = {
  /**
   * How long a job may sit in `processing` before it is treated as stalled.
   *
   * The condition an abandoned claim is recognized by: a process that died mid-call never wrote a
   * failure, so nothing about the row says "this is not being worked on" except the age of
   * `claimedAt`. Section 8 names the two ways it happens — a restart, or Render putting the service
   * to sleep mid-job.
   */
  staleThresholdMs: number;
};

export class ProcessingJobRepository {
  /**
   * Claims the oldest claimable job, or returns null when there is none (ARCHITECTURE Section 8).
   *
   * ## The one statement, and why it is one
   *
   *     UPDATE "ProcessingJob" SET "status" = 'processing', "claimedAt" = now()
   *      WHERE "id" = (SELECT "id" FROM "ProcessingJob"
   *                     WHERE … ORDER BY "createdAt" ASC LIMIT 1 FOR UPDATE SKIP LOCKED)
   *     RETURNING *
   *
   * Section 6 makes claiming transaction boundary #3, and this is that boundary expressed as a
   * single statement: the row is selected, locked, and updated without any window in between. A
   * read-then-write — select a candidate in one query, update it in the next — has a window, and
   * what happens in that window is the second worker claiming the row the first one just chose.
   *
   * `SKIP LOCKED` is what makes the lock cooperative rather than merely exclusive. With a plain
   * `FOR UPDATE`, a second claim would *block* on the row the first is holding, and blocking is not
   * the property wanted here: the queue's whole purpose is that another worker takes the next job
   * instead of waiting for this one. Skipping means contending claims fan out across the available
   * jobs rather than serializing behind each other.
   *
   * Prisma has no operator for either clause, so this is parameterized raw SQL, as in
   * `SubmissionRepository.mergeSectionAnswers` and `.lockById`. Every value below is a bound
   * parameter — nothing is interpolated into the statement text.
   *
   * ## What is claimable
   *
   * Two disjoint cases, by `status`:
   *
   * - **`pending` and due.** `nextAttemptAt <= now()`, which is what makes the retry backoff real
   *   (Section 8). Without it a failed job would be re-claimed on the very next tick and the 30s /
   *   2min / 5min schedule would mean nothing. This is also why Section 6's index is on
   *   `[status, nextAttemptAt]` — the pair is the predicate.
   * - **`processing` and stalled.** Claimed long enough ago that whatever claimed it is not coming
   *   back. This is the reclamation that answers EDGE-005: a job stalled by a restart is picked up
   *   again rather than leaving a student on "in progress" forever.
   *
   * `ORDER BY "createdAt" ASC` is FIFO, which Section 3's claim flow specifies. At this volume the
   * only thing it changes is that an early submission is not starved by later ones.
   *
   * ## What the claim deliberately does not do
   *
   * It does not touch `attemptCount`. Section 8 puts the increment in the failure path
   * (*"retryable failures increment `attemptCount` and set `nextAttemptAt`"*), and a claim that also
   * counted would double every ordinary failure — three attempts would be recorded as six, and
   * `MAX_ATTEMPTS` would mean half of what it says. Claiming is a state transition, not an attempt
   * outcome.
   *
   * The returned row is the row as updated — `status = 'processing'` and `claimedAt = now()` — so a
   * caller that logs it or passes it on is describing the claim it actually holds.
   */
  async claimNextJob(options: ClaimOptions): Promise<ProcessingJob | null> {
    // Resolved here rather than as SQL interval arithmetic: the threshold arrives in milliseconds,
    // and a `Date` is a bound parameter like any other — no string building, no type coercion in the
    // statement, and the comparison is timestamptz against timestamptz.
    const stalledBefore = new Date(Date.now() - options.staleThresholdMs);

    const claimed = await getPrismaClient().$queryRaw<ProcessingJob[]>`
      UPDATE "ProcessingJob"
         SET "status" = 'processing', "claimedAt" = now()
       WHERE "id" = (
         SELECT "id" FROM "ProcessingJob"
          WHERE ("status" = 'pending' AND "nextAttemptAt" <= now())
             OR ("status" = 'processing' AND "claimedAt" < ${stalledBefore})
          ORDER BY "createdAt" ASC
          LIMIT 1
          FOR UPDATE SKIP LOCKED
       )
      RETURNING *
    `;

    return claimed[0] ?? null;
  }

  /**
   * Reads a job by primary key inside a transaction.
   *
   * Exists because the two lifecycle transitions below need to know *which submission* and *which
   * kind of work* a job id refers to before they can write anything — and reading that from the row
   * rather than taking it from the caller keeps the row the single statement of what the job is.
   * Returns null rather than throwing when the row is gone, so a caller can answer "that job no
   * longer exists" instead of failing.
   */
  async findById(tx: JobTx, id: string): Promise<ProcessingJob | null> {
    return tx.processingJob.findUnique({ where: { id } });
  }

  /**
   * Marks a job succeeded, completing the claim.
   *
   * No `status = 'processing'` predicate here, for the reason `SubmissionRepository.markSubmitted`
   * gives: this is called only by the worker that holds the claim, and a second guard inside the
   * repository would be the version that looks authoritative while the caller's remains the real one.
   */
  async markSucceeded(tx: JobTx, id: string): Promise<void> {
    await tx.processingJob.update({
      where: { id },
      data: { status: 'succeeded', completedAt: new Date(), lastError: null },
    });
  }

  /**
   * Returns a job to the queue for a later attempt (ARCHITECTURE Section 8 — retries and backoff).
   *
   * `nextAttemptAt` is what makes the delay real: the claim only takes `pending` jobs whose
   * `nextAttemptAt` has passed, so the row is invisible to the worker until it is due. Without this
   * write a failed job would be picked up again on the very next tick and the backoff schedule would
   * mean nothing.
   *
   * `claimedAt` is cleared, because the row is no longer claimed. Leaving a timestamp there would
   * say a worker is holding a job that the claim predicate now treats as free.
   */
  async markForRetry(
    tx: JobTx,
    id: string,
    write: { attemptCount: number; nextAttemptAt: Date; lastError: string | null },
  ): Promise<void> {
    await tx.processingJob.update({
      where: { id },
      data: {
        status: 'pending',
        claimedAt: null,
        completedAt: null,
        attemptCount: write.attemptCount,
        nextAttemptAt: write.nextAttemptAt,
        lastError: write.lastError,
      },
    });
  }

  /**
   * Ends a job's attempts permanently (Section 8 — `failed_needs_review` after `MAX_ATTEMPTS`).
   *
   * A terminal state, and deliberately not an error state the queue keeps retrying: Section 8 makes
   * it *"a known, visible, terminal-for-now state, not a silent failure"*, surfaced to staff through
   * the dashboard rather than retried forever against a provider that has already refused it
   * repeatedly. Setting the submission's matching status column is `JobService`'s, in the same
   * transaction — the two are one fact and must not be able to disagree.
   */
  async markFailedNeedsReview(
    tx: JobTx,
    id: string,
    write: { attemptCount: number; lastError: string | null },
  ): Promise<void> {
    await tx.processingJob.update({
      where: { id },
      data: {
        status: 'failed_needs_review',
        completedAt: new Date(),
        attemptCount: write.attemptCount,
        lastError: write.lastError,
      },
    });
  }
}

/**
 * A handle for a transaction the caller owns.
 *
 * Deliberately the same type `SubmissionRepository.SubmissionTx` names, because it is the same
 * thing: Section 6's transaction boundary #4 writes the AI result to `Submission` **and** marks the
 * `ProcessingJob` succeeded in one transaction, so the two repositories are written against one
 * transaction rather than two. A transaction opened by either works with both.
 */
export type JobTx = Prisma.TransactionClient;

/** The process-wide repository instance, like `submissionRepository`. */
export const processingJobRepository = new ProcessingJobRepository();
