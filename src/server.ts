import type { AIEvaluationService } from './ai/AIEvaluationService.ts';
import { OllamaProvider } from './ai/OllamaProvider.ts';
import { createApp } from './app.ts';
import { DEFAULT_WORKER_SETTINGS, createWorkerLoop } from './background/workerLoop.ts';
import { getContentLoader } from './content/ContentLoader.ts';
import { env } from './config/env.ts';
import { logger } from './config/logger.ts';
import { submissionRepository } from './data/SubmissionRepository.ts';
import { getJobService } from './domain/jobs/JobService.ts';

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
 * In every non-test environment this returns an `OllamaProvider`. In test mode it returns null, so
 * the suite injects `FakeAIEvaluationService` through the worker loop's constructor. That is the
 * extent of the selection; ARCHITECTURE Section 17's "selected via configuration" is realized by
 * `env.ts` refusing to load without the two variables, not by a choice made here.
 *
 * ## Where "a production boot without a provider is fatal" is actually enforced
 *
 * In `env.ts`, at import, before this function is reached. `loadEnv` requires `OLLAMA_API_KEY` and
 * `OLLAMA_BASE_URL` for every `NODE_ENV` other than `test`, and throws a configuration error naming
 * the missing variable. Measured, not inferred: with `NODE_ENV=production` and a blank key,
 * `import('./dist/config/env.js')` fails with *"Invalid environment configuration: OLLAMA_API_KEY:
 * Required"* and `main()` never runs.
 *
 * That placement is the right one, and it is why the guard below is a backstop rather than the
 * mechanism. A process with no provider cannot evaluate anything: the jobs `finalize` enqueued stay
 * `pending` forever, because nothing ever claims them in order to fail them, and the student reads
 * "your writing feedback is still being prepared" — the indefinite in-progress state EDGE-005
 * forbids. Failing at import means a deployment in that condition never binds a port, which is the
 * same posture Section 16 takes for malformed content.
 *
 * The guard therefore cannot fire today; it is not dead in the sense of being wrong, but it is
 * unreachable, and it is kept only so that the answer to "what if `env.ts` stopped requiring these"
 * is a warning and no worker loop rather than a crash inside a constructor. Nothing else should be
 * hung on it.
 */
function selectAIEvaluationService(): AIEvaluationService | null {
  if (env.NODE_ENV === 'test') {
    return null;
  }

  if (!env.OLLAMA_API_KEY || !env.OLLAMA_BASE_URL) {
    logger.warn(
      { event: 'ai_provider_absent' },
      'No AI provider configured (OLLAMA_API_KEY/OLLAMA_BASE_URL unset). Writing and Student ' +
        'Problems jobs will stay pending until one is.',
    );

    return null;
  }

  return new OllamaProvider();
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

  const content = getContentLoader();

  const loop = createWorkerLoop({
    jobs: getJobService(),
    submissions: submissionRepository,
    content,
    ai,
    settings,
    // The loop's only spoken line, and the one thing that makes a silently failing background job
    // visible (Section 16). `err` is pino's error key, so the serialized line carries the type, the
    // message, and the stack — the same "full detail server-side" `errorHandler` keeps for request
    // failures, and the reason the loop's failure is diagnosable from Render's log viewer alone.
    onError: (error, jobId) => {
      logger.error(
        { event: 'worker_job_failed', jobId: jobId ?? null, err: error },
        'background job failed',
      );
    },
  });

  loop.start();

  logger.info(
    {
      event: 'worker_started',
      pollIntervalMs: settings.pollIntervalMs,
      maxAttempts: settings.maxAttempts,
    },
    'background worker started',
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
    logger.error(
      { event: 'content_validation_failed', err: error },
      'Content validation failed — refusing to start',
    );
    // Setting the exit code rather than calling process.exit() lets the line above flush.
    process.exitCode = 1;
    return;
  }

  // Step 3.
  const app = createApp();

  app.listen(env.PORT, () => {
    const contentLoader = getContentLoader();
    logger.info(
      {
        event: 'content_versions_loaded',
        versions: contentLoader.getLoadedVersions(),
        currentVersion: contentLoader.getCurrentVersion(),
      },
      'content versions loaded',
    );
    logger.info(
      { event: 'server_listening', port: env.PORT, nodeEnv: env.NODE_ENV },
      'server listening',
    );
  });

  // Step 4 — the background worker loop, started once, here, and deliberately not from `app.ts`.
  // `createApp()` is what every integration test builds; a `setInterval` started there would fire
  // against a database being truncated between tests and would hold vitest's worker open after the
  // last assertion. Section 16 puts the loop in this file for that reason.
  const ai = selectAIEvaluationService();

  if (ai === null) {
    logger.warn(
      { event: 'worker_not_started' },
      'No AI evaluation provider is configured, so the background worker loop was NOT started. ' +
        'Writing evaluation and Student Problems processing are unavailable: their jobs stay ' +
        '`pending` and student reports say the feedback is still being prepared, which is the ' +
        'truth. The assessment flow, sessions, and deterministic scoring are unaffected. ' +
        'ARCHITECTURE Section 17; the production provider arrives in E7 (T7.2.3).',
    );
    return;
  }

  startWorkerLoop(ai);
}

main();
