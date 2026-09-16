import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach } from 'vitest';
import type { Cohort, StaffUser, Submission } from '@prisma/client';
import { disconnectPrismaClient, getPrismaClient } from '../data/prismaClient.ts';
import { resetDatabase } from './db.ts';

/**
 * Shared fixtures for integration tests (T1.2.2).
 *
 * Every integration test in every later Epic builds its rows through these helpers, so that the
 * shape of a valid `Cohort` / `StaffUser` / `Submission` is stated once. They are deliberately
 * thin wrappers over Prisma rather than an in-memory factory library: the point is to create real
 * rows in the real test database (ARCHITECTURE Section 15), not to simulate one.
 *
 * Defaults are unique per call — a code, email, or roll number derived from a fresh UUID — so
 * creating two cohorts in one test does not trip a unique constraint by accident. Any field can
 * be overridden when a test is specifically about that field.
 */

/** The shared client, pointed at the test database (see `src/data/prismaClient.ts`). */
export function prisma() {
  return getPrismaClient();
}

/**
 * Truncates every table and closes the pool when the file finishes.
 *
 * Call once at the top level of an integration test file. Truncation runs before each test rather
 * than after, so a failing test leaves its rows in place to inspect and the suite still leaves no
 * residual data behind for the next file.
 */
export function useCleanTestDatabase(): void {
  beforeEach(async () => {
    await resetDatabase(getPrismaClient());
  });

  afterAll(async () => {
    await disconnectPrismaClient();
  });
}

export type CohortOverrides = Partial<Pick<Cohort, 'code' | 'name'>>;

export async function createCohort(overrides: CohortOverrides = {}): Promise<Cohort> {
  const suffix = randomUUID().slice(0, 8);

  return prisma().cohort.create({
    data: {
      code: overrides.code ?? `COHORT-${suffix}`,
      name: overrides.name ?? `Test Cohort ${suffix}`,
    },
  });
}

export type StaffUserOverrides = Partial<Pick<StaffUser, 'email' | 'passwordHash'>>;

/**
 * Creates a staff row.
 *
 * `passwordHash` defaults to an obviously-invalid string on purpose: the fixture's job is to
 * produce a row, and tests that exercise credential verification supply a real hash. Hashing with
 * bcrypt here would add ~250ms to every test that only needed an authenticated session.
 */
export async function createStaffUser(overrides: StaffUserOverrides = {}): Promise<StaffUser> {
  const suffix = randomUUID().slice(0, 8);

  return prisma().staffUser.create({
    data: {
      email: overrides.email ?? `staff-${suffix}@example.test`,
      passwordHash: overrides.passwordHash ?? 'not-a-real-bcrypt-hash',
    },
  });
}

export type SubmissionOverrides = Partial<
  Pick<
    Submission,
    | 'rollNumberRaw'
    | 'rollNumberNormalized'
    | 'studentName'
    | 'status'
    | 'contentVersion'
    | 'answers'
  >
>;

/**
 * Creates a draft submission for a cohort.
 *
 * The defaults produce a valid draft with no answers yet, which is exactly the row
 * `StudentIdentityService` creates when a student first verifies (T3.2.1).
 */
export async function createSubmission(
  cohortId: string,
  overrides: SubmissionOverrides = {},
): Promise<Submission> {
  const rollNumberRaw = overrides.rollNumberRaw ?? `ROLL-${randomUUID().slice(0, 8)}`;

  return prisma().submission.create({
    data: {
      cohortId,
      rollNumberRaw,
      rollNumberNormalized: overrides.rollNumberNormalized ?? rollNumberRaw.trim().toLowerCase(),
      studentName: overrides.studentName ?? 'Test Student',
      status: overrides.status ?? 'draft',
      // A literal rather than ContentLoader.getCurrentVersion(): this fixture must not depend on
      // the content bundle, or a content change would break unrelated integration tests.
      contentVersion: overrides.contentVersion ?? 'v1',
      answers: overrides.answers ?? {},
    },
  });
}
