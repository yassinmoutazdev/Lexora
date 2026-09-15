import { hasTestDatabase, runMigrations, schemaExists } from './db.ts';

/**
 * Vitest globalSetup — runs once per suite, before any test file.
 *
 * Applies migrations to the test database so every integration test starts from a known schema.
 * Data is cleared per test by `resetDatabase()`, not here.
 *
 * Both early returns are deliberate rather than failures: the unit suite must pass on a machine
 * with no database at all, and until E2 creates the schema there is genuinely nothing to apply.
 */
export default async function setup(): Promise<void> {
  if (!hasTestDatabase()) {
    console.warn('[test] DATABASE_URL_TEST is not set — integration tests will be skipped.');
    return;
  }

  if (!schemaExists()) {
    console.warn(
      '[test] DATABASE_URL_TEST is set but prisma/schema.prisma does not exist yet ' +
        '(E2 / T2.1.1) — skipping migrations.',
    );
    return;
  }

  await runMigrations();
}
