import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  TRUNCATE_ALL_TABLES,
  hasTestDatabase,
  resetDatabase,
  runMigrations,
  schemaExists,
  testDatabaseUrl,
  type SqlExecutor,
} from './db.ts';

/**
 * Unit coverage for the integration harness itself.
 *
 * These run with no database present — they exercise the harness's decision-making and the SQL
 * it emits. The end-to-end round trip against a real test database (and the cohort / staff /
 * submission fixtures) lands in E2 alongside the Prisma schema it needs.
 */
describe('integration test harness', () => {
  const originalUrl = process.env.DATABASE_URL_TEST;

  beforeEach(() => {
    delete process.env.DATABASE_URL_TEST;
  });

  afterEach(() => {
    if (originalUrl === undefined) delete process.env.DATABASE_URL_TEST;
    else process.env.DATABASE_URL_TEST = originalUrl;
  });

  describe('testDatabaseUrl', () => {
    it('is undefined when unset, so integration tests skip rather than fail', () => {
      expect(testDatabaseUrl()).toBeUndefined();
      expect(hasTestDatabase()).toBe(false);
    });

    it('treats a blank or whitespace-only value as unset', () => {
      process.env.DATABASE_URL_TEST = '   ';
      expect(testDatabaseUrl()).toBeUndefined();
      expect(hasTestDatabase()).toBe(false);
    });

    it('returns the configured value, trimmed', () => {
      process.env.DATABASE_URL_TEST = '  postgresql://u:p@localhost:5432/lexora_test  ';
      expect(testDatabaseUrl()).toBe('postgresql://u:p@localhost:5432/lexora_test');
      expect(hasTestDatabase()).toBe(true);
    });
  });

  describe('truncation', () => {
    it('covers the public schema and cascades to dependent tables', () => {
      expect(TRUNCATE_ALL_TABLES).toContain("schemaname = 'public'");
      expect(TRUNCATE_ALL_TABLES).toContain('CASCADE');
    });

    it('never truncates the Prisma migration ledger', () => {
      // Truncating _prisma_migrations would make Prisma believe every migration is unapplied.
      expect(TRUNCATE_ALL_TABLES).toContain("tablename <> '_prisma_migrations'");
    });

    it('discovers tables at run time rather than naming them', () => {
      // The harness must keep working as later Epics add models, so it reads pg_tables instead
      // of hard-coding table names that would drift from prisma/schema.prisma.
      expect(TRUNCATE_ALL_TABLES).toContain('FROM pg_tables');
    });

    it('resetDatabase issues exactly one statement through the client', async () => {
      const executor: SqlExecutor = { $executeRawUnsafe: vi.fn().mockResolvedValue(0) };

      await resetDatabase(executor);

      expect(executor.$executeRawUnsafe).toHaveBeenCalledTimes(1);
      expect(executor.$executeRawUnsafe).toHaveBeenCalledWith(TRUNCATE_ALL_TABLES);
    });
  });

  describe('runMigrations', () => {
    it('refuses to run without a test database configured', async () => {
      // Guards against a misconfigured run silently applying migrations to whatever
      // DATABASE_URL happens to point at.
      await expect(runMigrations()).rejects.toThrow('DATABASE_URL_TEST');
    });
  });

  describe('schemaExists', () => {
    it('is false until E2 creates prisma/schema.prisma', () => {
      expect(schemaExists()).toBe(false);
    });
  });
});
