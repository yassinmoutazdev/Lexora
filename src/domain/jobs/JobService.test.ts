import { describe, expect, it } from 'vitest';
import type { ProcessingJob } from '@prisma/client';
import {
  AIRetryableError,
  AINonRetryableError,
  AIValidationError,
} from '../../ai/errors.ts';
import { defaultStudentProblemsAnalysis, defaultWritingEvaluation } from '../../test/fakeAIEvaluationService.ts';
import { ContentLoader } from '../../content/ContentLoader.ts';
import { REPO_ROOT } from '../../config/env.ts';
import path from 'node:path';
import { processingJobRepository } from '../../data/ProcessingJobRepository.ts';
import { submissionRepository } from '../../data/SubmissionRepository.ts';
import type { DraftAnswers } from '../../shared/types/draft.ts';
import { createCohort, createSubmission, prisma, useCleanTestDatabase } from '../../test/fixtures.ts';
import { SubmissionService } from '../submission/SubmissionService.ts';
import { JOB_TYPES } from './jobTypes.ts';
import { JobService, type RetryPolicy } from './JobService.ts';

/**
 * Integration coverage for the job lifecycle (T6.2.2, ARCHITECTURE Section 15 — "`JobService` | Unit
 * + integration | Claim query never double-claims (simulated concurrent claim attempts); retry/backoff
 * transitions; stale job re-claim after the threshold; exhausted-retries → `failed_needs_review`").
 *
 * Against the real test database, because every transition under test is a write, and the two
 * properties this suite cares most about are properties of *statements*: that boundary #4's two
 * writes are one transaction, and that no failure path names the column holding the student's own
 * words. Both would be trivially satisfiable against a mock and meaningless there.
 *
 * The backoff is asserted by reading the `nextAttemptAt` that was written, never by waiting — the
 * schedule is a parameter precisely so this file needs no clock.
 */

useCleanTestDatabase();

const REAL_CONTENT = path.join(REPO_ROOT, 'content');

/** Section 8's illustrative schedule, restated here so the test is about the mechanism, not the values. */
const POLICY: RetryPolicy = { maxAttempts: 3, backoffMs: [5_000, 60_000, 300_000] };

const MINUTE = 60_000;
const STALE = 5 * MINUTE;

/**
 * The frozen content version every fixture submission is created under, as `completeJob` takes it.
 *
 * A literal rather than a read of `getCurrentVersion()`, deliberately: the weight-computation tests
 * depend on *which* rubric applies, and resolving "current" here would make them pass or fail
 * according to what `content/current-version.json` happens to say (Section 12).
 */
const V1 = { contentVersion: 'v1' };

function service(): JobService {
  return new JobService({
    jobs: processingJobRepository,
    submissions: submissionRepository,
    // The real content tree, because T7.3.1 makes `completeJob` read the weights from it. A fixture
    // bundle would let this suite pass while the real rubric was unreadable.
    content: new ContentLoader(REAL_CONTENT),
  });
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

/**
 * A finalized submission with the two pending jobs `finalize` creates — the state the worker actually
 * meets in production, rather than a hand-built approximation of it.
 *
 * `only` keeps a single job type and removes the other, for the tests that are about what happens to
 * *one* job. Without it, "the failed job is not claimable" would be asked of a queue that also holds
 * a perfectly claimable second job, and the honest answer would be that something was claimed.
 */
async function aFinalizedSubmission(options: { only?: string } = {}) {
  const cohort = await createCohort();
  const submission = await createSubmission(cohort.id, {
    contentVersion: 'v1',
    answers: answersFrom(),
  });

  await new SubmissionService({
    submissions: submissionRepository,
    content: new ContentLoader(REAL_CONTENT),
  }).finalize(submission.id);

  if (options.only) {
    await prisma().processingJob.deleteMany({
      where: { submissionId: submission.id, jobType: { not: options.only } },
    });
  }

  const jobs = await prisma().processingJob.findMany({
    where: { submissionId: submission.id },
    orderBy: { createdAt: 'asc' },
  });

  return { submissionId: submission.id, jobs };
}

/** The one job of a given type for a submission. */
function jobOfType(jobs: ProcessingJob[], jobType: string): ProcessingJob {
  const job = jobs.find((candidate) => candidate.jobType === jobType);
  if (!job) throw new Error(`no ${jobType} job was created`);
  return job;
}

function readJob(id: string) {
  return prisma().processingJob.findUniqueOrThrow({ where: { id } });
}

function readSubmission(id: string) {
  return prisma().submission.findUniqueOrThrow({ where: { id } });
}

describe('JobService.claimNextJob', () => {
  it('claims a job the finalize step enqueued', async () => {
    // The seam between E5 and E6: `finalize` inserts `pending` rows with the schema's defaults and
    // nothing else, and the worker claims one without anything having to prepare it first.
    const { submissionId } = await aFinalizedSubmission();

    const claimed = await service().claimNextJob({ staleThresholdMs: STALE });

    expect(claimed).not.toBeNull();
    expect(claimed?.submissionId).toBe(submissionId);
    expect(claimed?.attemptCount).toBe(0);
  });

  it('returns null on an idle tick, which is the common case', async () => {
    expect(await service().claimNextJob({ staleThresholdMs: STALE })).toBeNull();
  });
});

describe('JobService.completeJob — a succeeded writing evaluation', () => {
  it('stores the criterion judgments and feedback, and marks the job succeeded', async () => {
    const { submissionId, jobs } = await aFinalizedSubmission();
    const job = jobOfType(jobs, JOB_TYPES.writingEvaluation);
    const evaluation = defaultWritingEvaluation();

    const outcome = await service().completeJob(job.id, evaluation, V1);

    expect(outcome).toBe('completed');

    const stored = await readSubmission(submissionId);
    expect(stored.writingStatus).toBe('succeeded');
    expect(stored.writingCriteriaScores).toEqual(evaluation.criteriaScores);
    expect(stored.writingFeedback).toEqual({
      strengths: evaluation.strengths,
      weaknesses: evaluation.weaknesses,
      corrections: evaluation.corrections,
      suggestions: evaluation.suggestions,
    });

    const updated = await readJob(job.id);
    expect(updated.status).toBe('succeeded');
    expect(updated.completedAt).toBeInstanceOf(Date);
  });

  /**
   * FR-WRITE-008 requires feedback to be lightweight, and the rubric authors the number as
   * `outputRequirements.maxCorrections`. The prompt states it, but a prompt is an instruction
   * rather than an enforcement, so an overage is trimmed here — the one place holding both the
   * result and the submission's frozen rubric.
   */
  it("caps the stored corrections at the rubric's own limit", async () => {
    const { submissionId, jobs } = await aFinalizedSubmission();
    const cap = new ContentLoader(REAL_CONTENT).getContent('v1').writingRubric.outputRequirements
      .maxCorrections;

    const evaluation = {
      ...defaultWritingEvaluation(),
      corrections: Array.from({ length: cap + 3 }, (_unused, index) => ({
        original: `wrong ${index}`,
        corrected: `right ${index}`,
        explanation: `reason ${index}`,
      })),
    };

    await service().completeJob(jobOfType(jobs, JOB_TYPES.writingEvaluation).id, evaluation, V1);

    const stored = await readSubmission(submissionId);
    const { corrections } = stored.writingFeedback as { corrections: { original: string }[] };

    expect(corrections).toHaveLength(cap);
    // The model's own order survives, because the rubric asks it for the *most valuable*
    // corrections — the earliest are the ones it judged to matter most.
    expect(corrections.map((correction) => correction.original)).toEqual(
      Array.from({ length: cap }, (_unused, index) => `wrong ${index}`),
    );
  });

  it('leaves a correction list already within the cap untouched', async () => {
    const { submissionId, jobs } = await aFinalizedSubmission();
    const evaluation = defaultWritingEvaluation();

    await service().completeJob(jobOfType(jobs, JOB_TYPES.writingEvaluation).id, evaluation, V1);

    const stored = await readSubmission(submissionId);
    const { corrections } = stored.writingFeedback as { corrections: unknown[] };

    expect(corrections).toEqual(evaluation.corrections);
  });

  it('computes the overall score from the frozen rubric weights', async () => {
    // FR-WRITE-006: the overall is a deterministic function of the criterion judgments and the
    // versioned weights (Section 7). The fake returns 80 for all five criteria, and the v1 rubric
    // weights are equal, so the expected result is exact under any equal weighting — but it is
    // *read* from the bundle rather than restated, so this test is about the wiring and not about
    // the provisional numbers.
    const { submissionId, jobs } = await aFinalizedSubmission();
    const evaluation = defaultWritingEvaluation();
    const weights = new ContentLoader(REAL_CONTENT).getContent('v1').writingRubricWeights;

    await service().completeJob(
      jobOfType(jobs, JOB_TYPES.writingEvaluation).id,
      evaluation,
      V1,
    );

    const expected = Object.entries(weights).reduce(
      (sum, [key, weight]) => sum + (evaluation.criteriaScores[key]?.score ?? 0) * (weight / 100),
      0,
    );

    expect((await readSubmission(submissionId)).writingOverallScore).toBe(Math.round(expected));
  });

  it('scores against the version it was given, not whatever is current', async () => {
    // Section 2, Section 12: a submission is scored against the rubric it was written for. Asserted
    // by giving `completeJob` a version that does not exist — a "current"-resolving implementation
    // would quietly succeed here, and this one must not.
    const { submissionId, jobs } = await aFinalizedSubmission();

    await expect(
      service().completeJob(
        jobOfType(jobs, JOB_TYPES.writingEvaluation).id,
        defaultWritingEvaluation(),
        { contentVersion: 'does-not-exist' },
      ),
    ).rejects.toThrow(/Unknown content version/);

    const stored = await readSubmission(submissionId);
    expect(stored.writingOverallScore).toBeNull();
    expect(stored.writingStatus).toBe('pending');
  });

  it('writes nothing when the evaluation omits a criterion the rubric weights', async () => {
    // `WritingScoreCalculator` refuses a partial evaluation rather than shrinking the weighted sum
    // silently. The refusal has to leave the row untouched — a `succeeded` writing status with no
    // score is a report that can never be completed.
    const { submissionId, jobs } = await aFinalizedSubmission();
    const incomplete = defaultWritingEvaluation();
    delete (incomplete.criteriaScores as Record<string, unknown>).coherence;

    await expect(
      service().completeJob(jobOfType(jobs, JOB_TYPES.writingEvaluation).id, incomplete, V1),
    ).rejects.toThrow(/coherence/);

    const stored = await readSubmission(submissionId);
    expect(stored.writingStatus).toBe('pending');
    expect(stored.writingOverallScore).toBeNull();
  });

  it('does not touch the Student Problems side of the submission', async () => {
    // The two jobs fail independently (Section 6); they must also succeed independently, or a
    // writing result would claim a Student Problems analysis that was never run.
    const { submissionId, jobs } = await aFinalizedSubmission();
    const before = await readSubmission(submissionId);

    await service().completeJob(
      jobOfType(jobs, JOB_TYPES.writingEvaluation).id,
      defaultWritingEvaluation(),
      V1,
    );

    const after = await readSubmission(submissionId);
    expect(after.problemsTextStatus).toBe(before.problemsTextStatus);
    expect(after.problemsTextDerived).toEqual(before.problemsTextDerived);
    expect(after.problemsOpenTextOriginal).toBe(before.problemsOpenTextOriginal);
  });

  it('counts no attempt of its own', async () => {
    // Attempts are counted when they fail (Section 8). A success that incremented would make the
    // count mean "times touched" rather than "times it went wrong", and a job that succeeded on its
    // third try would look identical to one that has just failed twice.
    const { jobs } = await aFinalizedSubmission();
    const job = jobOfType(jobs, JOB_TYPES.writingEvaluation);

    await service().completeJob(job.id, defaultWritingEvaluation(), V1);

    expect((await readJob(job.id)).attemptCount).toBe(0);
  });

  it('answers not_found for a job that does not exist', async () => {
    const outcome = await service().completeJob(
      '00000000-0000-0000-0000-000000000000',
      defaultWritingEvaluation(),
      V1,
    );

    expect(outcome).toBe('not_found');
  });
});

describe('JobService.completeJob — a succeeded Student Problems analysis', () => {
  it('writes the derived column and leaves the original exactly as submitted', async () => {
    // FR-PROB-009/011 in one assertion pair. The derived column is where the AI's reading goes; the
    // original is the record of what the student wrote, and the difference between "equal to the
    // fixture" and "byte-identical to what finalize stored" is the difference between a test that
    // checks a value and one that checks the column was not rewritten.
    const { submissionId, jobs } = await aFinalizedSubmission();
    const before = await readSubmission(submissionId);
    const analysis = defaultStudentProblemsAnalysis();

    await service().completeJob(
      jobOfType(jobs, JOB_TYPES.studentProblemsText).id,
      analysis,
      V1,
    );

    const after = await readSubmission(submissionId);
    expect(after.problemsTextStatus).toBe('succeeded');
    // Exactly the two derived fields and nothing else — a stored analysis that carried a copy of
    // the original would make `problemsTextDerived` a second, competing record of what was written.
    expect(after.problemsTextDerived).toEqual({
      normalizedText: analysis.normalizedText,
      categories: analysis.categories,
    });
    expect(after.problemsOpenTextOriginal).toBe(before.problemsOpenTextOriginal);
    expect(JSON.stringify(after.problemsOpenTextOriginal)).toBe(
      JSON.stringify(before.problemsOpenTextOriginal),
    );
    // "Only the derived column" is a claim about every *other* column too, including the Likert
    // responses sitting beside the open text in the same section (Section 12).
    expect(after.problemsLikertAnswers).toEqual(before.problemsLikertAnswers);
    expect(after.answers).toEqual(before.answers);
  });

  it('does not touch the writing side of the submission', async () => {
    const { submissionId, jobs } = await aFinalizedSubmission();
    const before = await readSubmission(submissionId);

    await service().completeJob(
      jobOfType(jobs, JOB_TYPES.studentProblemsText).id,
      defaultStudentProblemsAnalysis(),
      V1,
    );

    const after = await readSubmission(submissionId);
    expect(after.writingStatus).toBe(before.writingStatus);
    expect(after.writingCriteriaScores).toEqual(before.writingCriteriaScores);
    expect(after.writingFeedback).toEqual(before.writingFeedback);
  });

  it('refuses to store a result for a job type it does not recognize', async () => {
    // Such a job is data this system cannot interpret. Guessing a branch would write one kind of
    // result into the other kind's columns; doing nothing would leave the job `processing` until it
    // looked stalled, forever. Thrown, it reaches the worker's failure handling and ends up visible.
    const { submissionId } = await aFinalizedSubmission();
    const rogue = await prisma().processingJob.create({
      data: { submissionId, jobType: 'not_a_job_type' },
    });

    await expect(service().completeJob(rogue.id, defaultWritingEvaluation(), V1)).rejects.toThrow(
      /not_a_job_type/,
    );

    expect((await readJob(rogue.id)).status).toBe('pending');
  });
});

describe('JobService.completeJob — transaction boundary #4', () => {
  it('writes no part of a result whose job row it could not mark', async () => {
    // Section 6 boundary #4: the result write and the job transition are one transaction, "so a
    // crash between 'wrote the score' and 'marked the job done' cannot happen". Provoked rather than
    // argued: a result carrying a circular reference makes Prisma raise from the *first* statement
    // of the pair (measured: `RangeError: Maximum call stack size exceeded`, from inside the
    // transaction), so the second statement never runs.
    //
    // What is being asserted is that the pair is atomic in the direction that matters. The job was
    // claimed and the transaction was entered, so a two-transaction implementation would have left
    // the job marked succeeded — or the columns written — depending on the order. Neither is
    // permitted: boundary #4 says there is no commit containing one without the other, and the two
    // assertions below are the two halves of that.
    const { submissionId, jobs } = await aFinalizedSubmission();
    const job = jobOfType(jobs, JOB_TYPES.writingEvaluation);

    // Claimed first, so the state the failure must not advance past is the real one a worker holds.
    await service().claimNextJob({ staleThresholdMs: STALE });

    const unserializable: WritingEvaluationWithCircularJson = defaultWritingEvaluation();
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    unserializable.criteriaScores.grammarAccuracy = {
      score: 80,
      rationale: 'Circular.',
      ...circular,
    };

    await expect(service().completeJob(job.id, unserializable, V1)).rejects.toThrow();

    const stored = await readSubmission(submissionId);
    expect(stored.writingStatus).toBe('pending');
    expect(stored.writingCriteriaScores).toBeNull();
    expect(stored.writingFeedback).toBeNull();
    expect((await readJob(job.id)).status).toBe('processing');
  });
});

/** A writing evaluation, widened so a test can put a value Prisma cannot serialize inside it. */
type WritingEvaluationWithCircularJson = ReturnType<typeof defaultWritingEvaluation> & {
  criteriaScores: Record<string, unknown>;
};

describe('JobService.failJob — retries and backoff', () => {
  it('returns a retryable failure to the queue with the first delay in the schedule', async () => {
    // Section 8: "retryable failures increment attemptCount and set nextAttemptAt = now() +
    // backoff(attemptCount)". Asserted against the timestamp that was written, so the proof is about
    // the mechanism and costs no wall-clock time.
    const { jobs } = await aFinalizedSubmission();
    const job = jobOfType(jobs, JOB_TYPES.writingEvaluation);
    const before = Date.now();

    const outcome = await service().failJob(job.id, new AIRetryableError('timed out'), POLICY);

    expect(outcome).toBe('retry_scheduled');

    const updated = await readJob(job.id);
    expect(updated.status).toBe('pending');
    expect(updated.attemptCount).toBe(1);
    expect(updated.lastError).toBe('timed out');
    // Cleared, because the row is no longer claimed — a timestamp here would say a worker holds a
    // job the claim predicate now treats as free.
    expect(updated.claimedAt).toBeNull();
    expect(updated.completedAt).toBeNull();

    const delay = updated.nextAttemptAt.getTime() - before;
    expect(delay).toBeGreaterThanOrEqual(POLICY.backoffMs[0] ?? 0);
    expect(delay).toBeLessThan((POLICY.backoffMs[0] ?? 0) + 2_000);
  });

  it('waits longer on the second failure than on the first', async () => {
    // The schedule is indexed by attempt, not a fixed delay: a job that has failed twice is further
    // from being retried than one that has failed once, which is the whole of "backoff".
    const { jobs } = await aFinalizedSubmission();
    const job = jobOfType(jobs, JOB_TYPES.writingEvaluation);

    await service().failJob(job.id, new AIRetryableError('timed out'), POLICY);
    const first = await readJob(job.id);

    await service().failJob(job.id, new AIRetryableError('timed out'), POLICY);
    const second = await readJob(job.id);

    expect(second.attemptCount).toBe(2);
    expect(second.nextAttemptAt.getTime() - first.nextAttemptAt.getTime()).toBeGreaterThan(
      (POLICY.backoffMs[1] ?? 0) - (POLICY.backoffMs[0] ?? 0) - 2_000,
    );
  });

  it('keeps the submission claimable while a retry is pending', async () => {
    // FR-FEEDBACK-007 forbids leaving the student on an indefinite "in progress", and a retry is not
    // that state — the work is still going to happen. Moving the submission to `processing` here
    // would also stop the report page polling (Section 5), so it stays `pending` until the job
    // actually ends.
    const { submissionId, jobs } = await aFinalizedSubmission();

    await service().failJob(
      jobOfType(jobs, JOB_TYPES.writingEvaluation).id,
      new AIRetryableError('timed out'),
      POLICY,
    );

    expect((await readSubmission(submissionId)).writingStatus).toBe('pending');
  });

  it('does not reclaim a job that is waiting out its backoff', async () => {
    const { jobs } = await aFinalizedSubmission({ only: JOB_TYPES.writingEvaluation });
    const job = jobOfType(jobs, JOB_TYPES.writingEvaluation);

    await service().failJob(job.id, new AIRetryableError('timed out'), POLICY);

    expect(await service().claimNextJob({ staleThresholdMs: STALE })).toBeNull();
  });

  it('reclaims the failed job once its backoff has passed', async () => {
    const { jobs } = await aFinalizedSubmission({ only: JOB_TYPES.writingEvaluation });
    const job = jobOfType(jobs, JOB_TYPES.writingEvaluation);

    await service().failJob(job.id, new AIRetryableError('timed out'), POLICY);
    // Move the due time into the past rather than sleeping through it — the same substitution the
    // staleness tests make, and the reason the schedule is a parameter.
    await prisma().processingJob.update({
      where: { id: job.id },
      data: { nextAttemptAt: new Date(Date.now() - 1_000) },
    });

    const claimed = await service().claimNextJob({ staleThresholdMs: STALE });

    expect(claimed?.id).toBe(job.id);
    // The claim does not reset the count, so the job still knows how many attempts it has had.
    expect(claimed?.attemptCount).toBe(1);
  });
});

describe('JobService.failJob — terminal outcomes', () => {
  it('gives up after maxAttempts and marks both the job and the submission', async () => {
    // FR-WRITE-011 / EDGE-004: the student sees "processing failed" rather than an indefinite
    // "in progress", and the job stops consuming attempts against a provider that keeps refusing.
    const { submissionId, jobs } = await aFinalizedSubmission();
    const job = jobOfType(jobs, JOB_TYPES.writingEvaluation);

    const outcomes = [];
    for (let attempt = 0; attempt < POLICY.maxAttempts; attempt += 1) {
      await prisma().processingJob.update({
        where: { id: job.id },
        data: { nextAttemptAt: new Date(Date.now() - 1_000) },
      });
      outcomes.push(await service().failJob(job.id, new AIRetryableError('still down'), POLICY));
    }

    expect(outcomes).toEqual(['retry_scheduled', 'retry_scheduled', 'failed_needs_review']);

    const updated = await readJob(job.id);
    expect(updated.status).toBe('failed_needs_review');
    expect(updated.attemptCount).toBe(POLICY.maxAttempts);
    expect(updated.lastError).toBe('still down');

    const stored = await readSubmission(submissionId);
    expect(stored.writingStatus).toBe('failed_needs_review');
  });

  it('preserves the student’s writing response exactly through every failure', async () => {
    // FR-WRITE-011 and Section 12, and the reason this is asserted as a byte comparison rather than
    // "the job ended up in the right state": the failure path is allowed to change every column it
    // owns, and none of them is the one holding what the student wrote. A retry, a backoff, and an
    // exhausted budget must leave it untouched.
    const { submissionId, jobs } = await aFinalizedSubmission();
    const job = jobOfType(jobs, JOB_TYPES.writingEvaluation);
    const before = await readSubmission(submissionId);
    const essayBefore = JSON.stringify((before.answers as DraftAnswers).writing?.essayText);

    for (let attempt = 0; attempt < POLICY.maxAttempts; attempt += 1) {
      await prisma().processingJob.update({
        where: { id: job.id },
        data: { nextAttemptAt: new Date(Date.now() - 1_000) },
      });
      await service().failJob(job.id, new AIRetryableError('still down'), POLICY);
    }

    const after = await readSubmission(submissionId);
    expect(JSON.stringify((after.answers as DraftAnswers).writing?.essayText)).toBe(essayBefore);
    expect(JSON.stringify(after.answers)).toBe(JSON.stringify(before.answers));
  });

  it('preserves the Student Problems original through an exhausted retry budget', async () => {
    // FR-PROB-013 / EDGE-008, the same guarantee for the other job type — and the one where the
    // original lives in a *column* the AI also writes near, so "the AI only writes the derived one"
    // is worth asserting rather than assuming.
    const { submissionId, jobs } = await aFinalizedSubmission();
    const job = jobOfType(jobs, JOB_TYPES.studentProblemsText);
    const before = await readSubmission(submissionId);

    for (let attempt = 0; attempt < POLICY.maxAttempts; attempt += 1) {
      await prisma().processingJob.update({
        where: { id: job.id },
        data: { nextAttemptAt: new Date(Date.now() - 1_000) },
      });
      await service().failJob(job.id, new AIRetryableError('still down'), POLICY);
    }

    const after = await readSubmission(submissionId);
    expect(after.problemsTextStatus).toBe('failed_needs_review');
    expect(after.problemsOpenTextOriginal).toBe(before.problemsOpenTextOriginal);
    expect(after.problemsTextDerived).toBeNull();
  });

  it('does not retry a failure that says it cannot succeed', async () => {
    // Section 8: malformed input is non-retryable. Retrying it would burn the budget and delay the
    // visible outcome by the whole schedule for a certainty.
    const { submissionId, jobs } = await aFinalizedSubmission();
    const job = jobOfType(jobs, JOB_TYPES.writingEvaluation);

    const outcome = await service().failJob(
      job.id,
      new AINonRetryableError('response text is blank'),
      POLICY,
    );

    expect(outcome).toBe('failed_needs_review');
    expect((await readJob(job.id)).attemptCount).toBe(1);
    expect((await readSubmission(submissionId)).writingStatus).toBe('failed_needs_review');
  });

  it('gives a schema-validation failure exactly one retry', async () => {
    // Section 8: "a schema-validation failure on a well-formed-but-wrong LLM response is treated as
    // retryable once, since a re-prompt may succeed." One retry, not the whole budget — the same
    // wrong shape twice is not going to become right on a third identical prompt.
    const { jobs } = await aFinalizedSubmission();
    const job = jobOfType(jobs, JOB_TYPES.writingEvaluation);

    const first = await service().failJob(job.id, new AIValidationError('bad shape'), POLICY);
    expect(first).toBe('retry_scheduled');
    expect((await readJob(job.id)).attemptCount).toBe(1);

    await prisma().processingJob.update({
      where: { id: job.id },
      data: { nextAttemptAt: new Date(Date.now() - 1_000) },
    });

    const second = await service().failJob(job.id, new AIValidationError('bad shape'), POLICY);
    expect(second).toBe('failed_needs_review');
  });

  it('fails one job type without touching the other', async () => {
    // FR-WRITE-011 and FR-PROB-013 are separate failure modes (Section 6). A writing failure that
    // also marked Student Problems processing failed would report a problem that does not exist and
    // hide the one that does.
    const { submissionId, jobs } = await aFinalizedSubmission();
    const job = jobOfType(jobs, JOB_TYPES.writingEvaluation);

    for (let attempt = 0; attempt < POLICY.maxAttempts; attempt += 1) {
      await prisma().processingJob.update({
        where: { id: job.id },
        data: { nextAttemptAt: new Date(Date.now() - 1_000) },
      });
      await service().failJob(job.id, new AIRetryableError('still down'), POLICY);
    }

    const stored = await readSubmission(submissionId);
    expect(stored.writingStatus).toBe('failed_needs_review');
    expect(stored.problemsTextStatus).toBe('pending');
    const otherJob = jobOfType(jobs, JOB_TYPES.studentProblemsText);
    expect((await readJob(otherJob.id)).status).toBe('pending');
  });

  it('records a bounded description of a failure that carries no message', async () => {
    // The job row is read by staff, so what lands in it is bounded and never a stringified value
    // that came from the request or the model.
    const { jobs } = await aFinalizedSubmission();
    const job = jobOfType(jobs, JOB_TYPES.writingEvaluation);

    await service().failJob(job.id, { not: 'an error' }, POLICY);

    expect((await readJob(job.id)).lastError).toBe('Non-Error thrown: object');
  });

  it('answers not_found for a job that does not exist', async () => {
    const outcome = await service().failJob(
      '00000000-0000-0000-0000-000000000000',
      new AIRetryableError('timed out'),
      POLICY,
    );

    expect(outcome).toBe('not_found');
  });
});
