import { describe, expect, it } from 'vitest';
import { JOB_TYPES } from '../domain/jobs/jobTypes.ts';
import { createCohort, createSubmission, prisma, useCleanTestDatabase } from '../test/fixtures.ts';
import { processingJobRepository } from './ProcessingJobRepository.ts';

/**
 * Integration coverage for the job claim (T6.2.1, ARCHITECTURE Section 15 — "`JobService` | Unit +
 * integration | Claim query never double-claims (simulated concurrent claim attempts)").
 *
 * Against the real test database, because every property under test is a database property. The
 * claim's whole guarantee is `UPDATE … WHERE id = (SELECT … FOR UPDATE SKIP LOCKED)` behaving
 * atomically under concurrent transactions, and a mocked client would let this suite pass while the
 * real one handed the same job to two workers — the same class of false pass E5 recorded, where a
 * concurrency test kept passing after its mechanism was removed until it was run at real contention.
 *
 * Nothing here sleeps. The staleness cases move `claimedAt` into the past rather than waiting for a
 * clock, and the threshold is a parameter precisely so they can: a test that proved stale
 * reclamation by waiting five minutes would be deleted long before it ever failed.
 */

useCleanTestDatabase();

/** A submission to hang jobs off, since `ProcessingJob.submissionId` is a real foreign key. */
async function aSubmissionId(): Promise<string> {
  const cohort = await createCohort();
  const submission = await createSubmission(cohort.id);
  return submission.id;
}

/** Creates a job with an explicit `createdAt`, so FIFO order is a fact rather than a tiebreak. */
async function createJob(
  submissionId: string,
  overrides: {
    jobType?: string;
    createdAt?: Date;
    status?: 'pending' | 'processing';
    claimedAt?: Date | null;
    nextAttemptAt?: Date;
    attemptCount?: number;
  } = {},
) {
  return prisma().processingJob.create({
    data: {
      submissionId,
      jobType: overrides.jobType ?? JOB_TYPES.writingEvaluation,
      status: overrides.status ?? 'pending',
      createdAt: overrides.createdAt ?? new Date(),
      claimedAt: overrides.claimedAt ?? null,
      nextAttemptAt: overrides.nextAttemptAt ?? new Date(),
      attemptCount: overrides.attemptCount ?? 0,
    },
  });
}

const MINUTE = 60_000;

describe('ProcessingJobRepository.claimNextJob — what it claims', () => {
  it('claims a pending job, and reports it as the claim that was made', async () => {
    const submissionId = await aSubmissionId();
    const job = await createJob(submissionId);

    const claimed = await processingJobRepository.claimNextJob({ staleThresholdMs: 5 * MINUTE });

    expect(claimed?.id).toBe(job.id);
    // The returned row is the row as updated — a caller logging it is describing the claim it holds.
    expect(claimed?.status).toBe('processing');
    expect(claimed?.claimedAt).toBeInstanceOf(Date);
  });

  it('claims the oldest job first', async () => {
    // Section 3's claim flow orders by `created_at ASC`. At this volume the only thing FIFO changes
    // is that an early submission is not starved by later ones — but it is what the flow specifies,
    // and an unordered claim would be a different queue than the one documented.
    const submissionId = await aSubmissionId();
    const now = Date.now();
    await createJob(submissionId, { createdAt: new Date(now), jobType: 'second' });
    await createJob(submissionId, { createdAt: new Date(now - 60_000), jobType: 'first' });

    const claimed = await processingJobRepository.claimNextJob({ staleThresholdMs: 5 * MINUTE });

    expect(claimed?.jobType).toBe('first');
  });

  it('returns null when there is nothing to claim', async () => {
    // The idle tick, which Section 8 calls "the cheapest possible no-op". The worker runs this every
    // seven seconds for the life of the process, so returning null has to be an ordinary answer and
    // not an error.
    expect(await processingJobRepository.claimNextJob({ staleThresholdMs: 5 * MINUTE })).toBeNull();
  });

  it('claims the Student Problems job type as readily as the writing one', async () => {
    // `jobType` is a plain string column (Section 6) and the claim is deliberately not typed against
    // a particular value: a job whose type the worker did not recognize must still be claimable, or
    // it would sit pending forever with nothing able to see it.
    const submissionId = await aSubmissionId();
    const job = await createJob(submissionId, { jobType: JOB_TYPES.studentProblemsText });

    const claimed = await processingJobRepository.claimNextJob({ staleThresholdMs: 5 * MINUTE });

    expect(claimed?.id).toBe(job.id);
  });

  it('does not count the claim as an attempt', async () => {
    // Section 8 puts the increment in the failure path. A claim that also counted would double every
    // ordinary failure — three attempts recorded as six, and MAX_ATTEMPTS meaning half what it says.
    const submissionId = await aSubmissionId();
    const job = await createJob(submissionId);

    const claimed = await processingJobRepository.claimNextJob({ staleThresholdMs: 5 * MINUTE });

    expect(claimed?.attemptCount).toBe(0);
    const stored = await prisma().processingJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(stored.attemptCount).toBe(0);
  });
});

describe('ProcessingJobRepository.claimNextJob — what it leaves alone', () => {
  it('does not claim a failed job that is still in its backoff window', async () => {
    // The assertion that makes retry backoff real. Without `nextAttemptAt <= now()` in the claim, a
    // job that failed would be picked up again on the very next tick and Section 8's 30s / 2min /
    // 5min schedule would be decoration.
    const submissionId = await aSubmissionId();
    await createJob(submissionId, { nextAttemptAt: new Date(Date.now() + 30_000) });

    expect(await processingJobRepository.claimNextJob({ staleThresholdMs: 5 * MINUTE })).toBeNull();
  });

  it('claims a failed job once its backoff window has passed', async () => {
    // The other half: the same row becomes claimable when it is due, so the backoff delays a retry
    // rather than cancelling it.
    const submissionId = await aSubmissionId();
    await createJob(submissionId, { nextAttemptAt: new Date(Date.now() - 1_000) });

    const claimed = await processingJobRepository.claimNextJob({ staleThresholdMs: 5 * MINUTE });

    expect(claimed).not.toBeNull();
  });

  it('does not claim a job another worker claimed moments ago', async () => {
    const submissionId = await aSubmissionId();
    await createJob(submissionId, { status: 'processing', claimedAt: new Date() });

    expect(await processingJobRepository.claimNextJob({ staleThresholdMs: 5 * MINUTE })).toBeNull();
  });

  it('does not claim a succeeded or terminally failed job', async () => {
    // `succeeded` and `failed_needs_review` are terminal states; neither is in the claim predicate,
    // which is what makes completion final rather than something the next tick could undo.
    const submissionId = await aSubmissionId();
    await prisma().processingJob.createMany({
      data: [
        { submissionId, jobType: 'succeeded_job', status: 'succeeded' },
        { submissionId, jobType: 'failed_job', status: 'failed_needs_review' },
        { submissionId, jobType: 'inapplicable_job', status: 'not_applicable' },
      ],
    });

    expect(await processingJobRepository.claimNextJob({ staleThresholdMs: 5 * MINUTE })).toBeNull();
  });
});

describe('ProcessingJobRepository.claimNextJob — stale reclamation', () => {
  it('re-claims a stalled job once it is older than the threshold', async () => {
    // EDGE-005: the process died mid-call and never wrote a failure, so the only thing that says
    // "nobody is working on this" is the age of `claimedAt`. Without this, the job stays
    // `processing` forever and the student waits on an "in progress" that will never change.
    const submissionId = await aSubmissionId();
    const job = await createJob(submissionId, {
      status: 'processing',
      claimedAt: new Date(Date.now() - 6 * MINUTE),
    });

    const claimed = await processingJobRepository.claimNextJob({ staleThresholdMs: 5 * MINUTE });

    expect(claimed?.id).toBe(job.id);
    expect(claimed?.status).toBe('processing');
    // Moved forward, so the reclaim does not immediately look stalled to the next tick.
    expect(claimed!.claimedAt!.getTime()).toBeGreaterThan(Date.now() - 1_000);
  });

  it('honours the threshold it is given, in both directions', async () => {
    // The threshold is a parameter rather than a constant precisely so this can be asserted without
    // waiting: the same row is stalled under one threshold and freshly claimed under a larger one.
    // If the value were ignored — a hardcoded five minutes, say — one of these two would fail.
    const submissionId = await aSubmissionId();
    await createJob(submissionId, {
      status: 'processing',
      claimedAt: new Date(Date.now() - 2 * MINUTE),
    });

    expect(await processingJobRepository.claimNextJob({ staleThresholdMs: 5 * MINUTE })).toBeNull();

    const claimed = await processingJobRepository.claimNextJob({ staleThresholdMs: 1 * MINUTE });

    expect(claimed).not.toBeNull();
  });

  it('does not disturb a claim that is in flight', async () => {
    // A job claimed a second ago is being worked on. Reclaiming it would run the same essay through
    // the provider twice, spending quota the free tier does not have to spare and racing two writes
    // onto one submission.
    const submissionId = await aSubmissionId();
    await createJob(submissionId, { status: 'processing', claimedAt: new Date(Date.now() - 30_000) });

    expect(await processingJobRepository.claimNextJob({ staleThresholdMs: 5 * MINUTE })).toBeNull();
  });
});

describe('ProcessingJobRepository.claimNextJob — concurrent claims', () => {
  /**
   * The number of claims fired at once, and the number of jobs for them to contend over.
   *
   * Deliberately larger than the tempting two: a mechanism that happens to serialize a pair can
   * still let several through, and the failure this guards against is rare enough that two
   * contenders would not reliably provoke it. Eight is comfortably more than the interesting case
   * and still finishes in well under a second, so the suite can afford to run it on every change.
   */
  const CONTENDERS = 8;

  it('never claims the same job twice under concurrent claims', async () => {
    const submissionId = await aSubmissionId();
    const now = Date.now();
    await prisma().processingJob.createMany({
      data: Array.from({ length: CONTENDERS }, (_unused, index) => ({
        submissionId,
        jobType: `job-${index}`,
        createdAt: new Date(now + index),
      })),
    });

    // All in flight before any is awaited — the interleaving a sequential test cannot produce.
    const claims = await Promise.all(
      Array.from({ length: CONTENDERS }, () =>
        processingJobRepository.claimNextJob({ staleThresholdMs: 5 * MINUTE }),
      ),
    );

    const claimedIds = claims.flatMap((job) => (job ? [job.id] : []));

    // Both halves matter, and they fail differently. A duplicate id means two workers got one job —
    // the essay is evaluated twice and the second write races the first. A missing claim means a
    // worker was told "nothing to do" while work was sitting there, which is work that silently
    // never gets done.
    expect(claimedIds).toHaveLength(CONTENDERS);
    expect(new Set(claimedIds).size).toBe(CONTENDERS);

    const stored = await prisma().processingJob.findMany({ where: { submissionId } });
    expect(stored.every((job) => job.status === 'processing')).toBe(true);
  });

  it('hands concurrent claims distinct jobs, not one job repeatedly', async () => {
    // The same guarantee stated against the database rather than against the returned rows: exactly
    // one row per claim, no row claimed by two, and no row left behind.
    const submissionId = await aSubmissionId();
    const now = Date.now();
    await prisma().processingJob.createMany({
      data: Array.from({ length: CONTENDERS }, (_unused, index) => ({
        submissionId,
        jobType: `job-${index}`,
        createdAt: new Date(now + index),
      })),
    });

    await Promise.all(
      Array.from({ length: CONTENDERS }, () =>
        processingJobRepository.claimNextJob({ staleThresholdMs: 5 * MINUTE }),
      ),
    );

    const stored = await prisma().processingJob.findMany({ where: { submissionId } });

    expect(stored).toHaveLength(CONTENDERS);
    expect(stored.filter((job) => job.status === 'processing')).toHaveLength(CONTENDERS);
    // Every claim stamped its own row, so the two workers cannot have shared one.
    expect(stored.every((job) => job.claimedAt !== null)).toBe(true);
  });

  it('skips a row another transaction is holding, rather than waiting for it', async () => {
    // The deterministic half of the proof. The three tests around this one fire genuinely
    // concurrent claims, which is what the guarantee is *for*, but which of them catches a broken
    // claim depends on how the statements happen to interleave — measured on this machine, the
    // block below fails without `SKIP LOCKED` on every run, but not through the same test twice.
    //
    // So the interleaving is fixed here instead of hoped for: a second transaction takes the row
    // lock a concurrent claim would be holding, and the claim is made while it is held. `SKIP
    // LOCKED` means exactly this — the locked row is passed over and the claim answers null
    // immediately, because a queue that made workers wait for each other would defeat the point of
    // having more than one. The `FOR UPDATE` half is covered too: without it the same statement
    // blocks on the row lock, and the race below never settles.
    const submissionId = await aSubmissionId();
    const job = await createJob(submissionId);

    let releaseHolder!: () => void;
    const holderReleased = new Promise<void>((resolve) => {
      releaseHolder = resolve;
    });
    let announceLock!: () => void;
    const lockHeld = new Promise<void>((resolve) => {
      announceLock = resolve;
    });

    const holder = prisma().$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "ProcessingJob" WHERE "id" = ${job.id} FOR UPDATE`;
        announceLock();
        await holderReleased;
      },
      // The default 5s interactive-transaction budget would abort the holder for taking too long,
      // turning a slow assertion into a database error rather than a test failure.
      { timeout: 30_000, maxWait: 30_000 },
    );

    await lockHeld;

    let timer: ReturnType<typeof setTimeout> | undefined;
    const claim = processingJobRepository.claimNextJob({ staleThresholdMs: 5 * MINUTE });
    const raced = await Promise.race([
      claim.then((claimed) => ({ settled: true as const, claimed })),
      new Promise<{ settled: false }>((resolve) => {
        timer = setTimeout(() => resolve({ settled: false }), 2_000);
      }),
    ]);
    clearTimeout(timer);

    releaseHolder();
    await holder;

    // Read the claim's own answer, so a blocked claim is awaited rather than left dangling.
    const claimed = raced.settled ? raced.claimed : await claim;

    expect(raced.settled).toBe(true);
    expect(claimed).toBeNull();
  });

  it('leaves the surplus unclaimed when there are more claims than jobs', async () => {
    // The other direction of the same mechanism: contention must not manufacture a job out of
    // nothing, and a claim that finds no work has to answer null rather than a stale row.
    const submissionId = await aSubmissionId();
    await createJob(submissionId, { jobType: 'only-job' });

    const claims = await Promise.all(
      Array.from({ length: CONTENDERS }, () =>
        processingJobRepository.claimNextJob({ staleThresholdMs: 5 * MINUTE }),
      ),
    );

    const claimedIds = claims.flatMap((job) => (job ? [job.id] : []));

    expect(claimedIds).toHaveLength(1);
  });
});
