import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AIRetryableError, AINonRetryableError } from '../ai/errors.ts';
import { REPO_ROOT } from '../config/env.ts';
import { ContentLoader } from '../content/ContentLoader.ts';
import { processingJobRepository } from '../data/ProcessingJobRepository.ts';
import { submissionRepository } from '../data/SubmissionRepository.ts';
import { JobService } from '../domain/jobs/JobService.ts';
import { JOB_TYPES } from '../domain/jobs/jobTypes.ts';
import { SubmissionService } from '../domain/submission/SubmissionService.ts';
import type { DraftAnswers } from '../shared/types/draft.ts';
import { FakeAIEvaluationService } from '../test/fakeAIEvaluationService.ts';
import { createCohort, createSubmission, prisma, useCleanTestDatabase } from '../test/fixtures.ts';
import { createWorkerLoop, type WorkerLoop } from './workerLoop.ts';

/**
 * Integration coverage for the worker loop (T6.3.1, ARCHITECTURE Section 15 — the end-to-end row:
 * *"Entry → draft (section-level autosave) → submit → report (deterministic visible immediately,
 * writing status transitions from pending to succeeded using the fake AI provider)"*, of which this
 * file is the transition).
 *
 * Against the real test database and the real `FakeAIEvaluationService`, because what is under test
 * is the whole path: claim, resolve the submission's own text and its frozen version, evaluate,
 * validate, and persist in one transaction. Every one of those steps is a place the wiring could be
 * right in isolation and wrong together.
 *
 * ## The loop is started explicitly, and stopped every time
 *
 * Nothing in this repository starts the worker as a side effect of building the app — it is started
 * from `src/server.ts` and nowhere else (Section 16). A test that inherited a running loop would be
 * sharing a mutable queue with every other test in the file, and the loop's interval would keep
 * firing against a database being truncated between tests. The `afterEach` below is not tidiness:
 * without it the vitest worker never exits.
 */

useCleanTestDatabase();

const REAL_CONTENT = path.join(REPO_ROOT, 'content');
const MINUTE = 60_000;

/** Poll fast enough that a test finishes promptly, but through the real interval. */
const TEST_SETTINGS = {
  pollIntervalMs: 25,
  staleThresholdMs: 5 * MINUTE,
  maxAttempts: 3,
  backoffMs: [5_000, 60_000, 300_000],
};

const started: WorkerLoop[] = [];

afterEach(() => {
  for (const loop of started) loop.stop();
  started.length = 0;
});

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * A loop, wired to the real repositories and content, with a fake provider — and started.
 *
 * The `onError` recorder doubles as the assertion for the failure paths: it is the only thing the
 * loop says out loud, so a test that expects a failure to be swallowed still has to see it reported.
 */
function startLoop(ai: FakeAIEvaluationService, failures: unknown[] = []) {
  const loop = createWorkerLoop({
    jobs: new JobService({ jobs: processingJobRepository, submissions: submissionRepository }),
    submissions: submissionRepository,
    content: new ContentLoader(REAL_CONTENT),
    ai,
    settings: TEST_SETTINGS,
    onError: (error) => failures.push(error),
  });

  started.push(loop);
  loop.start();

  return loop;
}

/** A loop that is built but not started, for the tests that drive `tick()` themselves. */
function manualLoop(ai: FakeAIEvaluationService, failures: unknown[] = []) {
  const loop = createWorkerLoop({
    jobs: new JobService({ jobs: processingJobRepository, submissions: submissionRepository }),
    submissions: submissionRepository,
    content: new ContentLoader(REAL_CONTENT),
    ai,
    settings: TEST_SETTINGS,
    onError: (error) => failures.push(error),
  });

  started.push(loop);

  return loop;
}

/** Waits for a condition rather than sleeping a fixed time. Fails loudly instead of hanging. */
async function until(check: () => Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(20);
  }

  throw new Error('timed out waiting for the worker loop');
}

/** Full, correct answers for the real v1 content — the shape `finalize` accepts. */
function answersFrom(): DraftAnswers {
  const content = new ContentLoader(REAL_CONTENT).getContent('v1');
  const answerKey = (questions: { id: string; correctAnswer: string }[]) =>
    Object.fromEntries(questions.map((question) => [question.id, question.correctAnswer]));

  return {
    grammar: answerKey(content.grammar.questions),
    vocabulary: answerKey(content.vocabulary.questions),
    reading: answerKey(content.reading.passages.flatMap((passage) => passage.questions)),
    writing: { essayText: 'Learning a language is a long project, but it rewards patience.' },
    studentProblems: {
      likertAnswers: Object.fromEntries(content.studentProblems.statements.map((s) => [s.id, 4])),
      openText: 'أجد صعوبة في التحدث أمام زملائي.',
    },
  };
}

/** A submitted assessment with the two pending jobs `finalize` enqueues — real work to claim. */
async function aFinalizedSubmission() {
  const cohort = await createCohort();
  const submission = await createSubmission(cohort.id, {
    contentVersion: 'v1',
    answers: answersFrom(),
  });

  await new SubmissionService({
    submissions: submissionRepository,
    content: new ContentLoader(REAL_CONTENT),
  }).finalize(submission.id);

  return submission.id;
}

function readSubmission(id: string) {
  return prisma().submission.findUniqueOrThrow({ where: { id } });
}

function readJobs(submissionId: string) {
  return prisma().processingJob.findMany({ where: { submissionId } });
}

describe('WorkerLoop — one tick, driven directly', () => {
  it('takes a pending job from claimed to succeeded in a single tick', async () => {
    // The strongest form of the task's "claimed, processed, and marked succeeded within a few poll
    // ticks": one tick does all three, so the poll interval is not what makes it work.
    const submissionId = await aFinalizedSubmission();
    const ai = new FakeAIEvaluationService();
    const loop = manualLoop(ai);

    await loop.tick();

    const writingJob = (await readJobs(submissionId)).find(
      (job) => job.jobType === JOB_TYPES.writingEvaluation,
    );
    expect(writingJob?.status).toBe('succeeded');
    expect(writingJob?.completedAt).toBeInstanceOf(Date);

    const stored = await readSubmission(submissionId);
    expect(stored.writingStatus).toBe('succeeded');
    expect(stored.writingCriteriaScores).not.toBeNull();
  });

  it('processes one job per tick, never two', async () => {
    // Section 8's single-in-flight-request constraint, stated as a property of the loop: the provider
    // is one request deep, so a tick that ran both jobs would be the concurrency the free tier does
    // not allow.
    const submissionId = await aFinalizedSubmission();
    const ai = new FakeAIEvaluationService();
    const loop = manualLoop(ai);

    await loop.tick();

    const jobs = await readJobs(submissionId);
    expect(jobs.filter((job) => job.status === 'succeeded')).toHaveLength(1);
    expect(jobs.filter((job) => job.status === 'pending')).toHaveLength(1);
    expect(ai.calls).toHaveLength(1);
  });

  it('passes the submission’s own text and the frozen rubric to the provider', async () => {
    // The wiring that Section 8's data flow describes, asserted through the fake's call log: the
    // essay comes from the submission (never the job), and the rubric instructions come from the
    // bundle for the submission's frozen `contentVersion` (never `getCurrentVersion()`).
    await aFinalizedSubmission();
    const ai = new FakeAIEvaluationService();
    const loop = manualLoop(ai);

    await loop.tick();

    expect(ai.calls).toEqual([
      {
        method: 'evaluateWriting',
        responseText: answersFrom().writing?.essayText,
        rubricInstructions: new ContentLoader(REAL_CONTENT).getContent('v1')
          .writingRubricInstructions,
      },
    ]);
  });

  it('does nothing at all when the queue is empty', async () => {
    const ai = new FakeAIEvaluationService();
    const loop = manualLoop(ai);

    await expect(loop.tick()).resolves.toBeUndefined();

    expect(ai.calls).toEqual([]);
  });

  it('does not overlap: a tick arriving while one runs is dropped, not queued', async () => {
    // Section 8's `isRunning` guard. Without it, two ticks would both claim and both be in flight at
    // the provider at once — which is the constraint, not just a waste. Fired together, so the
    // second arrives in the same turn of the event loop as the first and meets the guard.
    const submissionId = await aFinalizedSubmission();
    const ai = new FakeAIEvaluationService();
    const loop = manualLoop(ai);

    await Promise.all([loop.tick(), loop.tick()]);

    expect(ai.calls).toHaveLength(1);
    const jobs = await readJobs(submissionId);
    expect(jobs.filter((job) => job.status === 'succeeded')).toHaveLength(1);
    expect(jobs.filter((job) => job.status === 'pending')).toHaveLength(1);
  });
});

describe('WorkerLoop — the interval', () => {
  it('claims, processes, and completes the queued jobs on its own', async () => {
    // The task's Output condition: pending → succeeded without anything driving it. Both job types,
    // because the loop has two branches and only one of them is the writing path.
    const submissionId = await aFinalizedSubmission();
    const ai = new FakeAIEvaluationService();

    startLoop(ai);

    await until(async () => {
      const stored = await readSubmission(submissionId);
      return stored.writingStatus === 'succeeded' && stored.problemsTextStatus === 'succeeded';
    });

    const stored = await readSubmission(submissionId);
    expect(stored.writingCriteriaScores).not.toBeNull();
    expect(stored.problemsTextDerived).not.toBeNull();
    // FR-WRITE-006 / the E6 boundary: the loop persists the criterion judgments and stops there.
    expect(stored.writingOverallScore).toBeNull();
    // FR-PROB-009: the AI's write went to the derived column only.
    expect(stored.problemsOpenTextOriginal).toBe(answersFrom().studentProblems?.openText);

    const jobs = await readJobs(submissionId);
    expect(jobs.every((job) => job.status === 'succeeded')).toBe(true);
    expect(ai.calls).toHaveLength(2);
  });

  it('stops polling when stopped, and does not start a second interval if started twice', async () => {
    // Two things in one test because the second is what makes the first meaningful. `start()` twice
    // must not schedule two intervals — and if it did, the single `stop()` below would leave the
    // spare running, which is exactly what the assertion at the end would catch.
    const submissionId = await aFinalizedSubmission();
    const ai = new FakeAIEvaluationService();
    const loop = manualLoop(ai);

    loop.start();
    loop.start();
    expect(loop.isStarted).toBe(true);

    await until(async () => (await readJobs(submissionId)).some((job) => job.status === 'succeeded'));

    loop.stop();
    expect(loop.isStarted).toBe(false);

    const stranded = await prisma().processingJob.create({
      data: { submissionId, jobType: 'left_behind_by_stop' },
    });

    // Twenty poll intervals' worth of opportunity. A still-running interval claims this inside
    // 25ms; a stopped one leaves it pending indefinitely, so this cannot pass by being slow.
    await delay(500);

    expect((await prisma().processingJob.findUniqueOrThrow({ where: { id: stranded.id } })).status)
      .toBe('pending');
  });
});

describe('WorkerLoop — failures', () => {
  it('routes a provider failure to failJob and never rejects', async () => {
    // Section 8: "catches and routes to `failJob`". Two things are asserted, and both matter: the
    // job moved back to the queue with an attempt counted, and `tick()` resolved. The second is not
    // cosmetic — the caller is a `setInterval` callback, and a rejection there is an unhandled
    // rejection, which by default ends the process running the API.
    const submissionId = await aFinalizedSubmission();
    const ai = new FakeAIEvaluationService({
      writing: { kind: 'failure', error: new AIRetryableError('provider timed out') },
    });
    const failures: unknown[] = [];
    const loop = manualLoop(ai, failures);

    await expect(loop.tick()).resolves.toBeUndefined();

    const writingJob = (await readJobs(submissionId)).find(
      (job) => job.jobType === JOB_TYPES.writingEvaluation,
    );
    expect(writingJob?.status).toBe('pending');
    expect(writingJob?.attemptCount).toBe(1);
    expect(writingJob?.lastError).toBe('provider timed out');
    expect(writingJob?.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());
    expect(failures).toHaveLength(1);

    // A retry is not a failure the student can see yet: the work is still going to happen, and
    // moving the submission off `pending` would stop the report page polling (Section 5).
    expect((await readSubmission(submissionId)).writingStatus).toBe('pending');
  });

  it('ends a job whose failure cannot succeed on a retry, preserving the response', async () => {
    // FR-WRITE-011 / EDGE-004. The response is asserted as a byte comparison because the failure
    // path is allowed to change every column it owns and none of them is the one holding what the
    // student wrote.
    const submissionId = await aFinalizedSubmission();
    const before = await readSubmission(submissionId);
    const ai = new FakeAIEvaluationService({
      writing: { kind: 'failure', error: new AINonRetryableError('nothing to evaluate') },
    });
    const failures: unknown[] = [];
    const loop = manualLoop(ai, failures);

    await loop.tick();

    const writingJob = (await readJobs(submissionId)).find(
      (job) => job.jobType === JOB_TYPES.writingEvaluation,
    );
    expect(writingJob?.status).toBe('failed_needs_review');

    const stored = await readSubmission(submissionId);
    expect(stored.writingStatus).toBe('failed_needs_review');
    expect(JSON.stringify(stored.answers)).toBe(JSON.stringify(before.answers));
    expect(failures).toHaveLength(1);
  });

  it('fails the job rather than the process when the frozen content version is gone', async () => {
    // `getContent` throws for a version it does not hold rather than falling back (Section 12). That
    // refusal has to end up on the job, not escape the loop: the alternative is a background task
    // that takes the API server down with it.
    const cohort = await createCohort();
    const submission = await createSubmission(cohort.id, {
      contentVersion: 'v-does-not-exist',
      answers: answersFrom(),
    });
    await prisma().processingJob.create({
      data: { submissionId: submission.id, jobType: JOB_TYPES.writingEvaluation },
    });

    const ai = new FakeAIEvaluationService();
    const failures: unknown[] = [];
    const loop = manualLoop(ai, failures);

    await expect(loop.tick()).resolves.toBeUndefined();

    const job = (await readJobs(submission.id))[0];
    expect(job?.attemptCount).toBe(1);
    expect(job?.status).toBe('pending');
    // The provider was never reached — the version is resolved before the call, which is the whole
    // point of resolving it from the submission rather than trusting the job.
    expect(ai.calls).toEqual([]);
    expect(failures).toHaveLength(1);
  });
});
