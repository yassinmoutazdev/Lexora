import { describe, expect, it } from 'vitest';
import { hasTestDatabase } from '../test/db.ts';
import { createCohort, createSubmission, prisma, useCleanTestDatabase } from '../test/fixtures.ts';
import { SubmissionRepository } from './SubmissionRepository.ts';

/**
 * Integration coverage for the submission repository, against the real test database
 * (ARCHITECTURE Section 15).
 *
 * This is also the harness's own proof of life (T1.2.2): it creates rows through the shared
 * fixtures, reads them back, and confirms the suite leaves nothing behind. When no test database
 * is configured the whole file skips rather than failing, so the unit suite still passes on a
 * machine with no Postgres.
 */
describe.skipIf(!hasTestDatabase())('SubmissionRepository (integration)', () => {
  useCleanTestDatabase();

  const repository = new SubmissionRepository();

  it('creates a draft and reads it back by cohort + normalized roll number', async () => {
    const cohort = await createCohort();

    const created = await repository.createDraft({
      cohortId: cohort.id,
      rollNumberRaw: '  BSCS-2024-01  ',
      rollNumberNormalized: 'bscs-2024-01',
      studentName: 'Ayesha Khan',
      contentVersion: 'v1',
    });

    const found = await repository.findByCohortAndRollNumber(cohort.id, 'bscs-2024-01');

    expect(found).not.toBeNull();
    expect(found?.id).toBe(created.id);
    // The raw value is preserved exactly as typed, normalization is a lookup concern only.
    expect(found?.rollNumberRaw).toBe('  BSCS-2024-01  ');
    expect(found?.rollNumberNormalized).toBe('bscs-2024-01');
    expect(found?.studentName).toBe('Ayesha Khan');
    expect(found?.status).toBe('draft');
    expect(found?.contentVersion).toBe('v1');
    expect(found?.answers).toEqual({});
    // Nothing has been scored or evaluated yet — a fresh draft is empty, not half-populated.
    expect(found?.submittedAt).toBeNull();
    expect(found?.writingOverallScore).toBeNull();
    expect(found?.problemsOpenTextOriginal).toBeNull();
  });

  it('reads the same row back by id', async () => {
    const cohort = await createCohort();
    const created = await createSubmission(cohort.id);

    expect((await repository.findById(created.id))?.id).toBe(created.id);
  });

  it('returns null for an unknown roll number and for an unknown id', async () => {
    const cohort = await createCohort();

    expect(await repository.findByCohortAndRollNumber(cohort.id, 'nobody')).toBeNull();
    expect(await repository.findById('00000000-0000-0000-0000-000000000000')).toBeNull();
  });

  it('scopes identity to the cohort: one roll number in two cohorts is two submissions', async () => {
    const autumn = await createCohort({ name: 'Autumn intake' });
    const spring = await createCohort({ name: 'Spring intake' });

    const input = {
      rollNumberRaw: 'BSCS-01',
      rollNumberNormalized: 'bscs-01',
      studentName: 'Same Student',
      contentVersion: 'v1',
    };

    const first = await repository.createDraft({ ...input, cohortId: autumn.id });
    const second = await repository.createDraft({ ...input, cohortId: spring.id });

    expect(first.id).not.toBe(second.id);
    expect((await repository.findByCohortAndRollNumber(autumn.id, 'bscs-01'))?.id).toBe(first.id);
    expect((await repository.findByCohortAndRollNumber(spring.id, 'bscs-01'))?.id).toBe(second.id);
  });

  it('leaves no residual data between tests', async () => {
    // Runs last on purpose. The tests above each created a cohort and a submission; if the
    // harness's per-test truncation did not run, those rows would still be here. An empty
    // database at this point is the evidence that resetDatabase() is wired up correctly.
    expect(await prisma().cohort.count()).toBe(0);
    expect(await prisma().submission.count()).toBe(0);
  });
});
