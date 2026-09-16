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

  describe('mergeSectionAnswers', () => {
    it('writes one section and leaves every other section exactly as it was', async () => {
      // Section 12's central claim: the `jsonb ||` merge is a genuine partial update, not a
      // read-modify-write the application orchestrates. The untouched sections below are the
      // evidence — nothing in this method ever read them.
      const cohort = await createCohort();
      const submission = await createSubmission(cohort.id, {
        answers: {
          grammar: { 'gr-01': 'a', 'gr-02': 'b' },
          reading: { 'rd-01': 'c' },
        },
      });

      const result = await repository.mergeSectionAnswers(submission.id, 'vocabulary', {
        'vo-01': 'd',
      });

      expect(result).toEqual({ outcome: 'merged' });

      const stored = await repository.findById(submission.id);
      expect(stored?.answers).toEqual({
        grammar: { 'gr-01': 'a', 'gr-02': 'b' },
        reading: { 'rd-01': 'c' },
        vocabulary: { 'vo-01': 'd' },
      });
    });

    it('replaces the named section wholesale rather than merging inside it', async () => {
      // The unit of the merge is the section, so a second save of the same section is that
      // section's new value — not a union with its old one. Otherwise a student could never
      // correct an answer, and a removed answer would keep coming back.
      const cohort = await createCohort();
      const submission = await createSubmission(cohort.id, {
        answers: { grammar: { 'gr-01': 'a', 'gr-02': 'b' } },
      });

      await repository.mergeSectionAnswers(submission.id, 'grammar', { 'gr-01': 'c' });

      const stored = await repository.findById(submission.id);
      expect(stored?.answers).toEqual({ grammar: { 'gr-01': 'c' } });
    });

    it('creates the section key on a draft that has never been saved into', async () => {
      const cohort = await createCohort();
      const submission = await createSubmission(cohort.id, { answers: {} });

      await repository.mergeSectionAnswers(submission.id, 'writing', {
        essayText: 'One paragraph.',
      });

      const stored = await repository.findById(submission.id);
      expect(stored?.answers).toEqual({ writing: { essayText: 'One paragraph.' } });
    });

    it('refuses a submitted record and does not write to it', async () => {
      const cohort = await createCohort();
      const original = { grammar: { 'gr-01': 'a' } };
      const submission = await createSubmission(cohort.id, {
        status: 'submitted',
        answers: original,
      });

      const result = await repository.mergeSectionAnswers(submission.id, 'grammar', {
        'gr-01': 'z',
      });

      expect(result).toEqual({ outcome: 'not_draft', status: 'submitted' });
      // The distinction that matters: the statement targeted no row, so the answers are untouched
      // rather than written and then rejected.
      expect((await repository.findById(submission.id))?.answers).toEqual(original);
    });

    it('reports an unknown submission id rather than creating anything', async () => {
      const result = await repository.mergeSectionAnswers(
        '00000000-0000-0000-0000-000000000000',
        'grammar',
        { 'gr-01': 'a' },
      );

      expect(result).toEqual({ outcome: 'not_found' });
      expect(await prisma().submission.count()).toBe(0);
    });

    it('stores section values as data, so a key that looks like SQL is stored literally', async () => {
      // The merge is raw SQL, so this is the test that says the values are bound parameters rather
      // than interpolated text: a section name that is also SQL syntax must round-trip as a string.
      const cohort = await createCohort();
      const submission = await createSubmission(cohort.id, { answers: {} });

      const hostileQuestionId = `gr-01'); DROP TABLE "Submission"; --`;
      const result = await repository.mergeSectionAnswers(submission.id, 'grammar', {
        [hostileQuestionId]: 'a',
      });

      expect(result).toEqual({ outcome: 'merged' });

      const stored = await repository.findById(submission.id);
      expect(stored?.answers).toEqual({ grammar: { [hostileQuestionId]: 'a' } });
      expect(await prisma().submission.count()).toBe(1);
    });
  });

  it('leaves no residual data between tests', async () => {
    // Runs last on purpose. The tests above each created a cohort and a submission; if the
    // harness's per-test truncation did not run, those rows would still be here. An empty
    // database at this point is the evidence that resetDatabase() is wired up correctly.
    expect(await prisma().cohort.count()).toBe(0);
    expect(await prisma().submission.count()).toBe(0);
  });
});
