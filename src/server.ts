import { createApp } from './app.ts';
import { env } from './config/env.ts';

/**
 * Process entrypoint.
 *
 * Boot order is fixed by ARCHITECTURE Section 16; steps not yet implemented are marked with the
 * task that adds them, so this stays the single readable description of startup:
 *
 *   1. connect to Postgres                          — E2 (T2.1.3, prismaClient)
 *   2. load and validate every content version      — E2 (T2.2.5)
 *   3. start the Express server                     — here
 *   4. start the background worker loop             — E6 (T6.3.2)
 *
 * Importing `env` validates configuration and throws before anything binds a port, so a
 * misconfigured process fails fast instead of failing on the first request that needs a variable.
 */
function main(): void {
  const app = createApp();

  app.listen(env.PORT, () => {
    // Structured pino logging replaces this in T9.2.1.
    console.log(`[server] listening on http://localhost:${env.PORT} (${env.NODE_ENV})`);
  });
}

main();
