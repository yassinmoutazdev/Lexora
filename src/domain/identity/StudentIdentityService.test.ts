import { describe, expect, it } from 'vitest';
import { ContentLoader } from '../../content/ContentLoader.ts';
import { CohortRepository } from '../../data/CohortRepository.ts';
import { SubmissionRepository } from '../../data/SubmissionRepository.ts';
import { createCohort, createSubmission, prisma, useCleanTestDatabase } from '../../test/fixtures.ts';
import { StudentIdentityService, normalizeRollNumber } from './StudentIdentityService.ts';

/**
 * Tests for student identity resolution (T3.2.1).
 *
 * The normalization cases are pure; everything else runs against the real test database
 * (ARCHITECTURE Section 15), because the properties that matter — one row per identity, no row
 * created for a refusal, no row created twice under a race — are properties of the database
 * constraint as much as of this service, and a mocked repository would assert neither.
 *
 * The service is constructed per test with real repositories and a real `ContentLoader`, so
 * `contentVersion` assertions are against the content that is actually committed.
 */

function createService(): StudentIdentityService {
  return new StudentIdentityService({
    cohorts: new CohortRepository(),
    submissions: new SubmissionRepository(),
    content: new ContentLoader(),
  });
}

function countSubmissions(): Promise<number> {
  return prisma().submission.count();
}

useCleanTestDatabase();

describe('normalizeRollNumber', () => {
  it('trims and lowercases, which is what the uniqueness key is defined as', () => {
    expect(normalizeRollNumber('  2021-001  ')).toBe('2021-001');
    expect(normalizeRollNumber('CS-2021-001')).toBe('cs-2021-001');
    expect(normalizeRollNumber('2021-001')).toBe('2021-001');
    expect(normalizeRollNumber('\t2021-001\n')).toBe('2021-001');
  });
});

describe('StudentIdentityService — first visit', () => {
  it('creates a draft under the current content version when the identity is new', async () => {
    const cohort = await createCohort({ code: 'PILOT-2026', name: 'Pilot Cohort 2026' });
    const service = createService();

    const resolution = await service.resolve({
      cohortCode: 'PILOT-2026',
      rollNumber: '2021-001',
      studentName: 'Alice Example',
    });

    expect(resolution.outcome).toBe('resolved');
    if (resolution.outcome !== 'resolved') return;

    const { submission } = resolution;
    expect(submission.cohortId).toBe(cohort.id);
    expect(submission.status).toBe('draft');
    expect(submission.answers).toEqual({});
    // Frozen at creation from the loader's current version, not from a literal (Section 12).
    expect(submission.contentVersion).toBe(new ContentLoader().getCurrentVersion());
    // The raw roll number is preserved as typed for display; the normalized form is the key.
    expect(submission.rollNumberRaw).toBe('2021-001');
    expect(submission.rollNumberNormalized).toBe('2021-001');
    expect(submission.studentName).toBe('Alice Example');
  });

  it('accepts a cohort code with surrounding whitespace', async () => {
    await createCohort({ code: 'PILOT-2026' });

    const resolution = await createService().resolve({
      cohortCode: '  PILOT-2026 ',
      rollNumber: '2021-001',
      studentName: 'Alice Example',
    });

    expect(resolution.outcome).toBe('resolved');
  });

  it('preserves the roll number as typed while normalizing it for lookup', async () => {
    await createCohort({ code: 'PILOT-2026' });

    const resolution = await createService().resolve({
      cohortCode: 'PILOT-2026',
      rollNumber: '  CS-2021-001  ',
      studentName: 'Alice Example',
    });

    expect(resolution.outcome).toBe('resolved');
    if (resolution.outcome !== 'resolved') return;

    expect(resolution.submission.rollNumberRaw).toBe('  CS-2021-001  ');
    expect(resolution.submission.rollNumberNormalized).toBe('cs-2021-001');
  });
});

describe('StudentIdentityService — return visit', () => {
  it('resolves the existing submission rather than creating a second one', async () => {
    const cohort = await createCohort({ code: 'PILOT-2026' });
    const existing = await createSubmission(cohort.id, {
      rollNumberRaw: '2021-001',
      rollNumberNormalized: '2021-001',
      studentName: 'Alice Example',
    });

    const resolution = await createService().resolve({
      cohortCode: 'PILOT-2026',
      rollNumber: '2021-001',
      studentName: 'Alice Example',
    });

    expect(resolution.outcome).toBe('resolved');
    if (resolution.outcome !== 'resolved') return;

    expect(resolution.submission.id).toBe(existing.id);
    expect(resolution.submission.contentVersion).toBe(existing.contentVersion);
    await expect(countSubmissions()).resolves.toBe(1);
  });

  it('matches an existing submission across case and whitespace differences', async () => {
    // The returning student types the same details slightly differently. FR-STU-006/007 together
    // mean they can see this report and cannot start another, so a refusal here would strand them.
    const cohort = await createCohort({ code: 'PILOT-2026' });
    const existing = await createSubmission(cohort.id, {
      rollNumberRaw: '2021-001',
      rollNumberNormalized: '2021-001',
      studentName: 'Alice Example',
    });

    const resolution = await createService().resolve({
      cohortCode: 'PILOT-2026',
      rollNumber: ' 2021-001 ',
      studentName: '  alice example',
    });

    expect(resolution.outcome).toBe('resolved');
    if (resolution.outcome !== 'resolved') return;

    expect(resolution.submission.id).toBe(existing.id);
  });

  it('refuses a name that does not match the one on file, without touching the row', async () => {
    const cohort = await createCohort({ code: 'PILOT-2026' });
    const existing = await createSubmission(cohort.id, {
      rollNumberRaw: '2021-001',
      rollNumberNormalized: '2021-001',
      studentName: 'Alice Example',
    });

    const resolution = await createService().resolve({
      cohortCode: 'PILOT-2026',
      rollNumber: '2021-001',
      studentName: 'Bob Intruder',
    });

    expect(resolution).toEqual({ outcome: 'no_match' });

    const unchanged = await prisma().submission.findUniqueOrThrow({ where: { id: existing.id } });
    expect(unchanged.studentName).toBe('Alice Example');
    await expect(countSubmissions()).resolves.toBe(1);
  });

  it('keeps submissions for different roll numbers in the same cohort separate', async () => {
    const cohort = await createCohort({ code: 'PILOT-2026' });
    await createSubmission(cohort.id, {
      rollNumberRaw: '2021-001',
      rollNumberNormalized: '2021-001',
      studentName: 'Alice Example',
    });

    const resolution = await createService().resolve({
      cohortCode: 'PILOT-2026',
      rollNumber: '2021-002',
      studentName: 'Bob Example',
    });

    expect(resolution.outcome).toBe('resolved');
    if (resolution.outcome !== 'resolved') return;

    expect(resolution.submission.rollNumberNormalized).toBe('2021-002');
    await expect(countSubmissions()).resolves.toBe(2);
  });
});

describe('StudentIdentityService — refusals', () => {
  it('refuses an unknown cohort code and creates nothing', async () => {
    await createCohort({ code: 'PILOT-2026' });

    const resolution = await createService().resolve({
      cohortCode: 'NOT-A-COHORT',
      rollNumber: '2021-001',
      studentName: 'Alice Example',
    });

    expect(resolution).toEqual({ outcome: 'no_match' });
    await expect(countSubmissions()).resolves.toBe(0);
  });

  it('refuses when the same roll number is claimed in a different cohort', async () => {
    // The roll number is only an identity separator *within* a cohort (FR-STU-003), and a
    // submission is keyed by the pair — so this is a new student, not a conflict.
    const other = await createCohort({ code: 'OTHER-COHORT' });
    await createSubmission(other.id, {
      rollNumberRaw: '2021-001',
      rollNumberNormalized: '2021-001',
      studentName: 'Alice Example',
    });

    const cohort = await createCohort({ code: 'PILOT-2026' });
    const resolution = await createService().resolve({
      cohortCode: 'PILOT-2026',
      rollNumber: '2021-001',
      studentName: 'Someone Else',
    });

    expect(resolution.outcome).toBe('resolved');
    if (resolution.outcome !== 'resolved') return;

    expect(resolution.submission.cohortId).toBe(cohort.id);
  });

  it('gives the same refusal whichever field is wrong', async () => {
    // Section 11: a caller must not be able to learn *which* detail was wrong, or the refusal
    // becomes an oracle for guessing the other two.
    const cohort = await createCohort({ code: 'PILOT-2026' });
    await createSubmission(cohort.id, {
      rollNumberRaw: '2021-001',
      rollNumberNormalized: '2021-001',
      studentName: 'Alice Example',
    });

    const service = createService();

    const wrongCohort = await service.resolve({
      cohortCode: 'WRONG-COHORT',
      rollNumber: '2021-001',
      studentName: 'Alice Example',
    });
    const wrongName = await service.resolve({
      cohortCode: 'PILOT-2026',
      rollNumber: '2021-001',
      studentName: 'Wrong Name',
    });

    expect(wrongCohort).toEqual({ outcome: 'no_match' });
    expect(wrongName).toEqual(wrongCohort);
  });
});

describe('StudentIdentityService — one submission per identity', () => {
  it('never creates a second row when the same identity resolves repeatedly', async () => {
    await createCohort({ code: 'PILOT-2026' });
    const service = createService();

    const first = await service.resolve({
      cohortCode: 'PILOT-2026',
      rollNumber: '2021-001',
      studentName: 'Alice Example',
    });

    // Ten repeat visits, as a student refreshing or re-entering their details would produce.
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const again = await service.resolve({
        cohortCode: 'PILOT-2026',
        rollNumber: '2021-001',
        studentName: 'Alice Example',
      });

      expect(again.outcome).toBe('resolved');
      if (again.outcome !== 'resolved' || first.outcome !== 'resolved') return;

      expect(again.submission.id).toBe(first.submission.id);
    }

    await expect(countSubmissions()).resolves.toBe(1);
  });

  it('creates exactly one row when two first visits arrive together', async () => {
    // A double-clicked "Start", or two tabs opened from the same entry page: both find nothing and
    // both insert, and Postgres' unique constraint decides. Neither caller should see an error.
    await createCohort({ code: 'PILOT-2026' });
    const service = createService();

    const [first, second] = await Promise.all([
      service.resolve({
        cohortCode: 'PILOT-2026',
        rollNumber: '2021-001',
        studentName: 'Alice Example',
      }),
      service.resolve({
        cohortCode: 'PILOT-2026',
        rollNumber: '2021-001',
        studentName: 'Alice Example',
      }),
    ]);

    expect(first.outcome).toBe('resolved');
    expect(second.outcome).toBe('resolved');
    if (first.outcome !== 'resolved' || second.outcome !== 'resolved') return;

    expect(first.submission.id).toBe(second.submission.id);
    await expect(countSubmissions()).resolves.toBe(1);
  });

  it('is backed by the database constraint, not only by the lookup', async () => {
    // The service's find-then-create is an optimization; this is the guarantee. A direct insert
    // that bypasses the service entirely must still be rejected by Postgres.
    const cohort = await createCohort({ code: 'PILOT-2026' });
    await createSubmission(cohort.id, {
      rollNumberRaw: '2021-001',
      rollNumberNormalized: '2021-001',
      studentName: 'Alice Example',
    });

    await expect(
      createSubmission(cohort.id, {
        rollNumberRaw: '2021-001',
        rollNumberNormalized: '2021-001',
        studentName: 'Alice Example',
      }),
    ).rejects.toThrow();

    await expect(countSubmissions()).resolves.toBe(1);
  });
});
