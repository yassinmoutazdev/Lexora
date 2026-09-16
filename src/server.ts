import { createApp } from './app.ts';
import { getContentLoader } from './content/ContentLoader.ts';
import { env } from './config/env.ts';

/**
 * Process entrypoint.
 *
 * Boot order is fixed by ARCHITECTURE Section 16; steps not yet implemented are marked with the
 * task that adds them, so this stays the single readable description of startup:
 *
 *   1. connect to Postgres                          — E2 (T2.1.3, prismaClient)
 *   2. load and validate every content version      — here
 *   3. start the Express server                     — here
 *   4. start the background worker loop             — E6 (T6.3.2)
 *
 * Importing `env` validates configuration and throws before anything binds a port, so a
 * misconfigured process fails fast instead of failing on the first request that needs a variable.
 * Step 2 is deliberately ordered before step 3 for the same reason: a broken content file must
 * stop the process, not reach a student as a question with no answer key.
 */
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
}

main();
