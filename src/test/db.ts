import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { REPO_ROOT } from '../config/env.ts';

/**
 * Integration-test database harness.
 *
 * Integration tests run against a real Postgres database (ARCHITECTURE Section 15) named by
 * `DATABASE_URL_TEST`, which is deliberately a different database from `DATABASE_URL`. The
 * separation is a safety property, not a convenience: this module truncates tables, so pointing
 * it at the application database would destroy working data.
 *
 * The harness is schema-agnostic on purpose — it discovers tables from the database at run time
 * rather than listing them, so it keeps working as later Epics add models and never needs a
 * second copy of the schema to drift out of sync with `prisma/schema.prisma`.
 *
 * Fixture helpers that create cohorts, staff users, and submissions are added in E2 (T2.1.1)
 * alongside the Prisma models they build, rather than being guessed at here.
 */

const PRISMA_CLI = path.join(REPO_ROOT, 'node_modules', 'prisma', 'build', 'index.js');
const PRISMA_SCHEMA = path.join(REPO_ROOT, 'prisma', 'schema.prisma');

/**
 * The subset of the Prisma client this harness uses.
 *
 * Declared structurally rather than importing `PrismaClient` so this module has no compile-time
 * dependency on the generated client — which does not exist until `prisma generate` runs against
 * the E2 schema.
 */
export type SqlExecutor = {
  $executeRawUnsafe(query: string): Promise<number>;
};

/** The test database connection string, or undefined when the suite is running without one. */
export function testDatabaseUrl(): string | undefined {
  return process.env.DATABASE_URL_TEST?.trim() || undefined;
}

/**
 * Whether integration tests should run at all.
 *
 * Synchronous by necessity — it gates `describe`. Reachability of a *configured* database is
 * verified once in globalSetup, so "configured but misconfigured" fails loudly rather than
 * silently skipping.
 */
export function hasTestDatabase(): boolean {
  return testDatabaseUrl() !== undefined;
}

/**
 * Truncates every table in the public schema except Prisma's own migration ledger.
 *
 * One statement, executed in the database, so tables are discovered and truncated atomically
 * without the harness having to know their names or dependency order (`CASCADE` handles foreign
 * keys). `_prisma_migrations` is excluded deliberately: truncating it would make Prisma believe
 * every migration still needs applying.
 *
 * This is fixed SQL with no interpolation — no value from a request or a test ever reaches the
 * string. It is the one place in the codebase that issues raw SQL; see T9.3.3's audit.
 */
export const TRUNCATE_ALL_TABLES = `
DO $$
DECLARE
  target RECORD;
BEGIN
  FOR target IN
    SELECT schemaname, tablename
    FROM pg_tables
    WHERE schemaname = 'public'
      AND tablename <> '_prisma_migrations'
  LOOP
    EXECUTE format('TRUNCATE TABLE %I.%I RESTART IDENTITY CASCADE', target.schemaname, target.tablename);
  END LOOP;
END $$;
`;

/** Clears all data between tests, leaving the schema itself intact. */
export async function resetDatabase(client: SqlExecutor): Promise<void> {
  await client.$executeRawUnsafe(TRUNCATE_ALL_TABLES);
}

/**
 * Applies migrations from `prisma/migrations` to the test database.
 *
 * Runs once per suite from globalSetup, before any test file. `migrate deploy` (rather than
 * `migrate dev`) is non-interactive and never generates new migrations or prompts to reset.
 */
export async function runMigrations(): Promise<void> {
  const databaseUrl = testDatabaseUrl();

  if (!databaseUrl) {
    throw new Error('runMigrations() called without DATABASE_URL_TEST set');
  }

  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [PRISMA_CLI, 'migrate', 'deploy'], {
      cwd: REPO_ROOT,
      // Passed explicitly so this can never fall through to the application database.
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: 'inherit',
    });

    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`prisma migrate deploy exited with code ${code}`));
    });
  });
}

/**
 * True once the E2 schema exists. Until then there is nothing to migrate and `prisma migrate
 * deploy` would fail on the missing schema file, which would make the whole suite unrunnable
 * rather than skipping the integration tests.
 */
export function schemaExists(): boolean {
  return fs.existsSync(PRISMA_SCHEMA);
}
