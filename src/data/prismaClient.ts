import { PrismaClient } from '@prisma/client';
import { env } from '../config/env.ts';

/**
 * The single shared Prisma client (ARCHITECTURE Section 4, Section 18 — canonical location for
 * database access). Every repository imports `getPrismaClient()`; nothing else constructs a
 * client, so the process never opens a second connection pool.
 *
 * Construction is lazy rather than a module-level `new PrismaClient()` for one concrete reason:
 * the unit suite must run on a machine with no database at all, and importing this module is not
 * the same act as using the database. Resolving the URL eagerly would make importing a fixture
 * module throw before a single skipped integration test had a chance to skip.
 */

let instance: PrismaClient | undefined;

/**
 * The connection string this process is allowed to talk to.
 *
 * Under `NODE_ENV=test` this is `DATABASE_URL_TEST` and only `DATABASE_URL_TEST`. That is a safety
 * property, not a convenience: the integration harness truncates tables between tests, so a test
 * run that fell through to the application database would destroy real data. If the test database
 * is not configured the client refuses to be created rather than defaulting to the wrong database.
 */
function resolveDatabaseUrl(): string {
  if (env.NODE_ENV !== 'test') return env.DATABASE_URL;

  if (!env.DATABASE_URL_TEST) {
    throw new Error(
      'NODE_ENV=test but DATABASE_URL_TEST is not set. Integration tests require a separate test ' +
        'database; see .env.example. Refusing to fall back to DATABASE_URL.',
    );
  }

  return env.DATABASE_URL_TEST;
}

/** Returns the process-wide Prisma client, creating it on first use. */
export function getPrismaClient(): PrismaClient {
  instance ??= new PrismaClient({ datasources: { db: { url: resolveDatabaseUrl() } } });
  return instance;
}

/**
 * Closes the shared client's connection pool.
 *
 * Only the test harness needs this — a long-lived server process holds its pool for the life of
 * the process. Without it, a suite that creates a client would leave Postgres connections open
 * until Node exited.
 */
export async function disconnectPrismaClient(): Promise<void> {
  if (!instance) return;

  await instance.$disconnect();
  instance = undefined;
}
