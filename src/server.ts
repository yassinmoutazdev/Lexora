import type { AIEvaluationService } from './ai/AIEvaluationService.ts';
import { createApp } from './app.ts';
import { DEFAULT_WORKER_SETTINGS, createWorkerLoop } from './background/workerLoop.ts';
import { getContentLoader } from './content/ContentLoader.ts';
import { env } from './config/env.ts';
import { processingJobRepository } from './data/ProcessingJobRepository.ts';
import { submissionRepository } from './data/SubmissionRepository.ts';
import { JobService } from './domain/jobs/JobService.ts';

/**
 * Process entrypoint.
 *
 * Boot order is fixed by ARCHITECTURE Section 16, and every step is now implemented:
 *
 *   1. connect to Postgres                          — E2 (T2.1.3, prismaClient)
 *   2. load and validate every content version      — here (E2, T2.2.5)
 *   3. start the Express server                     — here
 *   4. start the background worker loop             — here (E6, T6.3.2)
 *
 * Importing `env` validates configuration and throws before anything binds a port, so a
 * misconfigured process fails fast instead of failing on the first request that needs a variable.
 * Step 2 is deliberately ordered before step 3 for the same reason: a broken content file must
 * stop the process, not reach a student as a question with no answer key.
 */

/**
 * The AI provider this process evaluates with — or null when none is configured.
 *
 * ## What this currently returns, and why that is the whole answer
 *
 * **It returns null. There is no production AI provider in this build.** `OllamaProvider` is
 * ARCHITECTURE Section 17's extension point and is not written until E7 (T7.2.1–T7.2.3); T7.2.3 is
 * the task that replaces this function's body with the real selection, reading `OLLAMA_API_KEY` and
 * `OLLAMA_BASE_URL` from the environment (Section 16).
 *
 * Until then this returns null rather than a stand-in, and deliberately rather than reluctantly.
 * The alternative — booting the loop against a provider that answers every call with an error —
 * would write `failed_needs_review` onto real submissions, which says *"processing failed, a human
 * should look at this"* when the truth is *"processing was never attempted"*. Those two are not the
 * same claim, and only one of them is recoverable by doing nothing. A build with no provider has a
 * truthful state available — the jobs stay `pending`, exactly as `finalize` left them — and this
 * function is what lets the process take it.
 *
 * This is the seam Section 17 describes: *"a second provider implementation could be added and
 * selected via configuration without touching `SubmissionService`, `WritingScoreCalculator`, or any
 * route."* The function is the selection; everything downstream of it takes an
 * `AIEvaluationService`, which is why filling this in is a one-line change to one file.
 */
function selectAIEvaluationService(): AIEvaluationService | null {
  return null;
}

/**
 * The background worker loop, wired to the process's real services.
 *
 * Constructed here rather than inside `createApp()` — see the comment at its call site.
 */
function startWorkerLoop(ai: AIEvaluationService): void {
  // Section 8's timing and retry values. Named here rather than left to the loop's own default so
  // that a deployment which needs different ones has an obvious place to say so — and so the log
  // line below describes the settings the loop was actually given.
  const settings = DEFAULT_WORKER_SETTINGS;

  const loop = createWorkerLoop({
    jobs: new JobService({ jobs: processingJobRepository, submissions: submissionRepository }),
    submissions: submissionRepository,
    content: getContentLoader(),
    ai,
    settings,
    // Structured `pino` logging replaces this console call in T9.2.1. What matters now is that the
    // hook is supplied rather than defaulted: it is the only thing the loop says out loud, and a
    // silently failing background job is the one failure mode Section 16 says staff must be able to
    // see.
    onError: (error, jobId) => {
      const detail = error instanceof Error ? error.message : String(error);
      console.error(`[worker] job ${jobId ?? '(no job claimed)'} failed: ${detail}`);
    },
  });

  loop.start();

  console.log(
    `[server] background worker started (polling every ${settings.pollIntervalMs}ms, ` +
      `up to ${settings.maxAttempts} attempts per job)`,
  );
}

function main(): void {
  // Step 1 is implicit: the Prisma client connects lazily on its first query, so there is no
  // explicit connect call to make here.

  // Step 2 — every version under content/versions/* is loaded and schema-validated, and the
  // process refuses to start if any of them is malformed. This resolves the process-wide loader
  // the domain services use, so what is validated here is exactly what they will read from.
  try {
    getContentLoader();
  } catch (error) {
    console.error(
      `[server] Content validation failed — refusing to start.\n${(error as Error).message}`,
    );
    // Setting the exit code rather than calling process.exit() lets the message above flush.
    process.exitCode = 1;
    return;
  }

  // Step 3.
  const app = createApp();

  app.listen(env.PORT, () => {
    // Structured pino logging replaces the console calls in T9.2.1.
    const contentLoader = getContentLoader();
    console.log(
      `[server] content versions loaded: ${contentLoader.getLoadedVersions().join(', ')} ` +
        `(current: ${contentLoader.getCurrentVersion()})`,
    );
    console.log(`[server] listening on http://localhost:${env.PORT} (${env.NODE_ENV})`);
  });

  // Step 4 — the background worker loop, started once, here, and deliberately not from `app.ts`.
  // `createApp()` is what every integration test builds; a `setInterval` started there would fire
  // against a database being truncated between tests and would hold vitest's worker open after the
  // last assertion. Section 16 puts the loop in this file for that reason.
  const ai = selectAIEvaluationService();

  if (ai === null) {
    console.warn(
      '[server] No AI evaluation provider is configured, so the background worker loop was NOT ' +
        'started. Writing evaluation and Student Problems processing are unavailable: their jobs ' +
        'stay `pending` and student reports say the feedback is still being prepared, which is the ' +
        'truth. The assessment flow, sessions, and deterministic scoring are unaffected. ' +
        'ARCHITECTURE Section 17; the production provider arrives in E7 (T7.2.3).',
    );
    return;
  }

  startWorkerLoop(ai);
}

main();
