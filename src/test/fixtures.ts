import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach } from 'vitest';
import type { Cohort, Prisma, StaffUser, Submission } from '@prisma/client';
import { resetRateLimits } from '../api/middleware/rateLimit.ts';
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
 * Truncates every table, resets the rate limiters, and closes the pool when the file finishes.
 *
 * Call once at the top level of an integration test file. Truncation runs before each test rather
 * than after, so a failing test leaves its rows in place to inspect and the suite still leaves no
 * residual data behind for the next file.
 *
 * ## Why the rate limiters are reset here too
 *
 * The name says "database", but what this fixture actually provides is *a known starting state*,
 * and in this application that state is not only the database: the rate limiters keep their counters
 * in process memory (`src/api/middleware/rateLimit.ts`), so every test in a file draws on the same
 * allowance for `POST /api/session/student-verify`. Each integration test builds its own rows and
 * therefore its own verified session, so a file grows past that allowance simply by covering more
 * behaviour — and then fails with 429s that look like an authentication problem rather than the
 * test-isolation problem they are.
 *
 * Resetting restores it to the same footing as the tables. It is deliberately not opt-in: a fixture
 * a caller has to remember to use alongside this one is one a caller will forget, and this file's
 * own experience is that the failure it prevents is confusing enough to be worth preventing
 * unconditionally.
 */
export function useCleanTestDatabase(): void {
  beforeEach(async () => {
    await resetDatabase(getPrismaClient());
    resetRateLimits();
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
    // Set by finalization, not by a student. Here because a test that starts from a *submitted* row
    // has to be able to state what the student wrote, and the original is a column of its own
    // (Section 6) rather than a field inside `answers`.
    | 'problemsOpenTextOriginal'
    // The scored and derived columns, for the same reason: the staff dashboard (E8) aggregates over
    // these rather than re-scoring `answers`, and a test of it has to be able to state them
    // directly. Also written only by finalization and by the background worker, never by a student.
    | 'grammarScore'
    | 'vocabularyScore'
    | 'readingScore'
    | 'writingStatus'
    | 'writingOverallScore'
    | 'problemsTextStatus'
    | 'submittedAt'
  >
> & {
  /**
   * The JSON columns, typed as *write* inputs rather than read from `Submission`.
   *
   * Prisma separates the two: a read value may be `null`, while a write has to spell that
   * `Prisma.JsonNull`. Taking these from the read model would make every fixture call site that
   * passes an object fail to compile against `create()`, for a distinction that is Prisma's and not
   * the test's. Tests hand these plain objects, so they are typed as what `create()` accepts.
   */
  writingCriteriaScores?: Prisma.InputJsonValue;
  writingFeedback?: Prisma.InputJsonValue;
  problemsLikertAnswers?: Prisma.InputJsonValue;
  problemsTextDerived?: Prisma.InputJsonValue;
};

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
      problemsOpenTextOriginal: overrides.problemsOpenTextOriginal ?? null,
      ...scoredColumns(overrides),
    },
  });
}

/**
 * The scored and derived columns, spread in only when the caller named them.
 *
 * Spread conditionally rather than defaulted, because the schema already carries the right default
 * for each — a draft's scores are null and its processing statuses are `not_applicable` — and
 * writing `null` over `not_applicable` would make a fixture-built draft differ from a real one in a
 * way every processing-status test would then have to know about.
 *
 * Destructured by hand rather than filtered by key, so that adding a column to the list above is a
 * compile error here until it is either handled or explicitly passed through.
 */
function scoredColumns(overrides: SubmissionOverrides) {
  const {
    rollNumberRaw: _rollNumberRaw,
    rollNumberNormalized: _rollNumberNormalized,
    studentName: _studentName,
    status: _status,
    contentVersion: _contentVersion,
    answers: _answers,
    problemsOpenTextOriginal: _problemsOpenTextOriginal,
    ...scored
  } = overrides;

  return scored;
}
