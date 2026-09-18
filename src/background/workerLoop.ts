import type { ProcessingJob } from '@prisma/client';
import type { AIEvaluationService } from '../ai/AIEvaluationService.ts';
import type { ContentLoader } from '../content/ContentLoader.ts';
import type { SubmissionRepository } from '../data/SubmissionRepository.ts';
import { JOB_TYPES } from '../domain/jobs/jobTypes.ts';
import type { JobService } from '../domain/jobs/JobService.ts';

/**
 * The in-process background worker (ARCHITECTURE Section 8, Section 18 — canonical location for
 * "background job lifecycle").
 *
 * One poll loop, in the same process as the API, started at boot and running for the process's
 * lifetime. Section 8 gives the reason it is one loop and not a queue library, and the reason is not
 * thrift: *"Ollama Cloud's free tier permits exactly one in-flight cloud request. A single loop,
 * processing one job at a time, is not a simplification made despite the requirements — it is the
 * design that matches the provider's actual concurrency ceiling."*
 *
 * ## Where this file lives, and where it must not
 *
 * `src/background/`, started from `src/server.ts` (Section 16, step 4). It is deliberately **not**
 * reachable from `createApp()`. Every integration test in this repository builds an app; a
 * `setInterval` started there would fire against a database being truncated between tests, and would
 * hold vitest's worker open after the last assertion. The test suite starts this loop explicitly and
 * stops it in cleanup, which is also the only honest way to test a loop: drive it, don't inherit it.
 *
 * ## What one tick does
 *
 * Section 3's data flow, in its order: claim a job, resolve the submission's own response text and
 * its **frozen** content version, resolve that version's bundle, ask the provider to evaluate, and
 * persist the result. Every input is resolved fresh from the `Submission` row through
 * `getEvaluationContext` — never from a field on the job, because Section 6 keeps the job table thin
 * precisely so it cannot hold a stale copy of the response or the rubric.
 */

/**
 * The loop's timing and retry policy, as parameters.
 *
 * These are Section 8's **illustrative** numbers, kept as defaults rather than compiled in as
 * facts, and kept replaceable for a reason that is more than convenience: a test that proved stale
 * reclamation by waiting five minutes, or a backoff by waiting thirty seconds, is a test that would
 * be deleted long before it ever failed. Everything below is set by the caller, so a test states the
 * behaviour it wants in milliseconds and asserts on the `nextAttemptAt` that was written.
 *
 * The values themselves are an operational decision the pilot has not made yet, and Section 8
 * presents them as a sketch ("simple linear backoff … is sufficient at this volume").
 */
export type WorkerLoopSettings = {
  /** How often to look for work. Section 8's illustrative value is 7 seconds. */
  pollIntervalMs: number;
  /** How long a claimed job may sit unfinished before it counts as stalled. Illustratively 5 min. */
  staleThresholdMs: number;
  /** Total attempts before a job becomes `failed_needs_review`. Illustratively 3. */
  maxAttempts: number;
  /** Delay before each retry, indexed from the first failure. Illustratively 30s / 2min / 5min. */
  backoffMs: readonly number[];
};

/** Section 8's illustrative settings — see `WorkerLoopSettings` for what "illustrative" means here. */
export const DEFAULT_WORKER_SETTINGS: WorkerLoopSettings = {
  pollIntervalMs: 7_000,
  staleThresholdMs: 5 * 60_000,
  maxAttempts: 3,
  backoffMs: [30_000, 2 * 60_000, 5 * 60_000],
};

export type WorkerLoopDeps = {
  jobs: JobService;
  submissions: SubmissionRepository;
  content: ContentLoader;
  ai: AIEvaluationService;
  /**
   * Where a failure goes once it has been recorded on the job.
   *
   * Required rather than defaulted to `console.error`, because this is the only thing the loop says
   * out loud and a caller that has not thought about where it goes should not get silence by
   * accident. `src/server.ts` supplies the process logger (the structured `pino` instance configured
   * in `src/config/logger.ts`, T9.2.1); tests supply a recorder.
   */
  onError: (error: unknown, jobId: string | null) => void;
  /** Overrides for `DEFAULT_WORKER_SETTINGS`; a test sets these small. */
  settings?: Partial<WorkerLoopSettings>;
};

/**
 * The poll loop.
 *
 * `tick()` is public and idempotent-by-guard, which is what makes this testable without waiting on
 * a timer: a test can drive one tick at a time and assert exactly what it did, and can start the
 * interval when it wants the real scheduling behaviour.
 */
export class WorkerLoop {
  private readonly deps: WorkerLoopDeps;
  private readonly settings: WorkerLoopSettings;

  /** The interval handle while started, or null. Both `start` and `stop` key off this. */
  private interval: ReturnType<typeof setInterval> | null = null;

  /**
   * Whether a tick is in progress — Section 8's guard *"against overlapping ticks"*.
   *
   * `setInterval` does not wait for an async callback to finish, so a tick that outlives the poll
   * interval would overlap the next one. With one worker that is not merely wasteful: two ticks
   * would each claim a job, which is fine, but the second would run *while* the first is waiting on
   * the provider — the one thing Section 8's single-in-flight-request constraint forbids.
   *
   * Set synchronously before the first `await` in `tick`, so a second call arriving in the same
   * turn of the event loop sees it. That is what makes the guard a guard rather than a race.
   */
  private ticking = false;

  constructor(deps: WorkerLoopDeps) {
    this.deps = deps;
    this.settings = { ...DEFAULT_WORKER_SETTINGS, ...deps.settings };
  }

  /** Whether a tick is currently running. */
  get isRunning(): boolean {
    return this.ticking;
  }

  /** Whether the poll interval is currently scheduled. */
  get isStarted(): boolean {
    return this.interval !== null;
  }

  /**
   * Starts polling (ARCHITECTURE Section 16, step 4).
   *
   * Idempotent: a second call while already started is a no-op rather than a second interval. Two
   * intervals would mean two ticks firing per period, and `isRunning` would mask it only as long as
   * the ticks happened to collide.
   */
  start(): void {
    if (this.interval !== null) return;

    this.interval = setInterval(() => {
      // Deliberately not `void this.tick()` and done: an exception escaping a `setInterval`
      // callback is an unhandled rejection, which in Node's default configuration is fatal to the
      // process — and this process is the API server. `tick` is written never to reject (see below);
      // this is the second line, because the failure mode is the whole service going down.
      this.tick().catch((error: unknown) => this.deps.onError(error, null));
    }, this.settings.pollIntervalMs);
  }

  /** Stops polling. Safe to call when not started, and safe to call twice. */
  stop(): void {
    if (this.interval === null) return;

    clearInterval(this.interval);
    this.interval = null;
  }

  /**
   * One poll: claim at most one job and see it through (Section 8's `tick`).
   *
   * **This method never rejects.** That is a contract, not an accident, and it is the reason the
   * guard and the error handling are both here rather than at the call sites: the caller is a
   * `setInterval` callback, and an unhandled rejection there ends the process. Everything that can
   * fail is caught, routed to `failJob` where there is a job to route it to, and reported through
   * `onError`. A test may therefore `await loop.tick()` and assert on the database afterwards
   * without wrapping it.
   *
   * The claim itself is outside the inner `try`'s job handling on purpose: if claiming throws there
   * is no job to fail, so the error is reported and the tick ends. Treating it as a job failure
   * would be inventing a job id.
   */
  async tick(): Promise<void> {
    if (this.ticking) return;

    this.ticking = true;

    try {
      let job: ProcessingJob | null = null;

      try {
        job = await this.deps.jobs.claimNextJob({
          staleThresholdMs: this.settings.staleThresholdMs,
        });

        // The idle tick, which Section 8 calls "the cheapest possible no-op": every seven seconds,
        // for the life of the process, most ticks find nothing and should cost one query.
        if (!job) return;

        await this.process(job);
      } catch (error) {
        // Section 8: "catches and routes to `failJob`". Everything after the claim is retryable
        // bookkeeping as far as this loop is concerned — deciding *whether* it is retryable, and how
        // long to wait, is `JobService`'s, from the error's own classification.
        if (job) {
          await this.failJob(job, error);
        } else {
          this.deps.onError(error, null);
        }
      } finally {
        this.ticking = false;
      }
    } catch (error) {
      // Unreachable in practice — the block above catches everything — but `tick` promises not to
      // reject, and a promise is only as good as its least-guarded path.
      this.ticking = false;
      this.deps.onError(error, null);
    }
  }

  /**
   * The work of one claimed job: resolve, evaluate, persist.
   *
   * The content bundle is resolved once, before the branch, from the version frozen on the
   * submission. That is not incidental to the writing branch — it is what makes Section 12's
   * historical interpretability hold — and it applies to the Student Problems branch too, where the
   * bundle is not read: resolving it there means a submission whose content version has gone missing
   * fails loudly instead of being processed against nothing.
   */
  private async process(job: ProcessingJob): Promise<void> {
    const context = await this.deps.submissions.getEvaluationContext(job.submissionId, job.jobType);
    const content = this.deps.content.getContent(context.contentVersion);

    // The frozen version travels with the result, because both writes that follow are derived from
    // it: the rubric the model was graded against, and the weights its criterion judgments are
    // scored by. Passing the version rather than a resolved number keeps `contentVersion` the one
    // statement of which rubric applies (Section 12).
    const evaluationTarget = { contentVersion: context.contentVersion };

    if (context.jobType === JOB_TYPES.writingEvaluation) {
      // The prompt comes from the *frozen* version's bundle, passed in rather than resolved by the
      // provider, so the provider has no way to grade against "current" content. It carries the
      // rubric, the task the response was written in answer to, and the output contract — composed
      // from that version's own two writing files by `ContentLoader.loadVersion`.
      const evaluation = await this.deps.ai.evaluateWriting(
        context.responseText,
        content.writingRubricInstructions,
      );

      await this.deps.jobs.completeJob(job.id, evaluation, evaluationTarget);
      return;
    }

    const analysis = await this.deps.ai.processStudentProblemsText(context.responseText);

    // The bundle is resolved above for this branch too, though nothing here reads it: a submission
    // whose content version has gone missing should fail loudly rather than be processed against
    // nothing. The version still travels with the result for the same reason — one code path, one
    // statement of what the job was evaluated under.
    await this.deps.jobs.completeJob(job.id, analysis, evaluationTarget);
  }

  /**
   * Records a failed attempt, and reports it.
   *
   * `failJob` opens its own transaction and can itself fail — a database that just refused a write
   * is a plausible reason the tick got here. That failure is reported rather than allowed to
   * propagate, for the same reason as everything else in `tick`: the caller is a timer.
   */
  private async failJob(job: ProcessingJob, error: unknown): Promise<void> {
    try {
      await this.deps.jobs.failJob(job.id, error, {
        maxAttempts: this.settings.maxAttempts,
        backoffMs: this.settings.backoffMs,
      });
    } catch (failureToRecordFailure) {
      this.deps.onError(failureToRecordFailure, job.id);
    }

    this.deps.onError(error, job.id);
  }
}

/**
 * Builds the process-wide loop.
 *
 * A factory rather than a module-level singleton with a lazy getter, which is the pattern the other
 * services use. The difference is `stop()`: a lazily-created singleton would be shared between a
 * running server and any test that happened to construct one, and a test stopping "the" loop would
 * be stopping the server's. `src/server.ts` calls this once at boot and holds the result.
 */
export function createWorkerLoop(deps: WorkerLoopDeps): WorkerLoop {
  return new WorkerLoop(deps);
}
