import { describe, expect, it } from 'vitest';
import { JOB_TYPES } from '../domain/jobs/jobTypes.ts';
import { hasTestDatabase } from '../test/db.ts';
import {
  createCohort,
  createSubmission,
  prisma,
  useCleanTestDatabase,
  type SubmissionOverrides,
} from '../test/fixtures.ts';
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

  describe('the one-submission-per-identity constraint (T5.2.3)', () => {
    /**
     * Inserts a submission with raw SQL, bypassing Prisma's model layer entirely.
     *
     * This is the whole point of the test. `prisma.submission.create` would prove that *Prisma*
     * rejects the second row — which is not the guarantee. Section 6 asks for the guarantee that
     * survives a race: "Postgres rejects a second `INSERT` even under a race condition, which is the
     * guarantee application code alone cannot provide." Only a statement that goes straight to the
     * database can show where the rejection actually comes from.
     *
     * Every value is a bind parameter, as everywhere else raw SQL appears in this codebase.
     */
    async function insertRawSubmission(input: {
      cohortId: string;
      rollNumberRaw: string;
      rollNumberNormalized: string;
      studentName?: string;
    }): Promise<void> {
      await prisma().$executeRawUnsafe(
        `INSERT INTO "Submission"
           ("id","cohortId","rollNumberRaw","rollNumberNormalized","studentName","status","contentVersion","answers","createdAt","updatedAt")
         VALUES (gen_random_uuid(), $1, $2, $3, $4, 'draft', 'v1', '{}'::jsonb, now(), now())`,
        input.cohortId,
        input.rollNumberRaw,
        input.rollNumberNormalized,
        input.studentName ?? 'Raw Insert Student',
      );
    }

    /** The Postgres SQLSTATE a rejection carries, whatever Prisma wraps it in. */
    function sqlStateOf(error: unknown): unknown {
      return (error as { meta?: { code?: unknown } }).meta?.code;
    }

    it('is rejected by Postgres itself when a duplicate (cohortId, rollNumberNormalized) is inserted', async () => {
      const cohort = await createCohort();
      await createSubmission(cohort.id, {
        rollNumberRaw: 'BSCS-01',
        rollNumberNormalized: 'bscs-01',
      });

      let thrown: unknown;
      try {
        await insertRawSubmission({
          cohortId: cohort.id,
          rollNumberRaw: 'BSCS-01',
          rollNumberNormalized: 'bscs-01',
        });
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeDefined();

      // 23505 is Postgres' own `unique_violation`. Its presence is the assertion that matters: the
      // statement never reached application code, so nothing but the database could have refused it.
      expect(sqlStateOf(thrown)).toBe('23505');

      // And the refusal names this constraint, not some other one that happens to be nearby.
      const message = JSON.stringify((thrown as { meta?: unknown }).meta);
      expect(message).toContain('cohortId');
      expect(message).toContain('rollNumberNormalized');

      // The rejected row is not half-written.
      expect(await prisma().submission.count()).toBe(1);
    });

    it('keys on the normalized value, so differing raw spellings still collide', async () => {
      // The constraint is on `rollNumberNormalized`, which is what makes "2021-001" and " 2021-001 "
      // one identity rather than two (Section 6). A constraint on the raw column would let the same
      // student start a second attempt by adding a space.
      const cohort = await createCohort();
      await createSubmission(cohort.id, {
        rollNumberRaw: '2021-001',
        rollNumberNormalized: '2021-001',
      });

      let thrown: unknown;
      try {
        await insertRawSubmission({
          cohortId: cohort.id,
          rollNumberRaw: '  2021-001  ',
          rollNumberNormalized: '2021-001',
        });
      } catch (error) {
        thrown = error;
      }

      expect(sqlStateOf(thrown)).toBe('23505');
      expect(await prisma().submission.count()).toBe(1);
    });

    it('still allows the same roll number in a different cohort', async () => {
      // The constraint is composite, not a global ban on roll numbers: identity is scoped to a
      // cohort (FR-STU-005), so the same student in two intakes is two submissions by design.
      const autumn = await createCohort({ name: 'Autumn intake' });
      const spring = await createCohort({ name: 'Spring intake' });

      await insertRawSubmission({
        cohortId: autumn.id,
        rollNumberRaw: 'BSCS-01',
        rollNumberNormalized: 'bscs-01',
      });
      await insertRawSubmission({
        cohortId: spring.id,
        rollNumberRaw: 'BSCS-01',
        rollNumberNormalized: 'bscs-01',
      });

      expect(await prisma().submission.count()).toBe(2);
    });

    it('surfaces to Prisma as the unique-constraint error createDraftIfAbsent recovers from', async () => {
      // The link between the constraint and the code that leans on it. `createDraftIfAbsent` catches
      // a unique violation to turn a raced first visit into a find-or-create; if the client ever
      // stopped reporting this as P2002, that recovery would silently stop running and two
      // simultaneous first visits would 500.
      const cohort = await createCohort();
      const input = {
        cohortId: cohort.id,
        rollNumberRaw: 'BSCS-01',
        rollNumberNormalized: 'bscs-01',
        studentName: 'Ayesha Khan',
        contentVersion: 'v1',
      };

      await repository.createDraft(input);

      await expect(repository.createDraft(input)).rejects.toMatchObject({ code: 'P2002' });

      // And the method built on that error returns the existing row instead of raising.
      const orCreate = await repository.createDraftIfAbsent(input);
      expect(await prisma().submission.count()).toBe(1);
      expect(
        (await repository.findByCohortAndRollNumber(cohort.id, 'bscs-01'))?.id,
      ).toBe(orCreate.id);
    });

    it('cannot be defeated by two inserts racing', async () => {
      // The race the application-level check loses: both statements are in flight before either is
      // awaited. One succeeds, one is refused by the database — never two rows.
      const cohort = await createCohort();
      const input = {
        cohortId: cohort.id,
        rollNumberRaw: 'BSCS-01',
        rollNumberNormalized: 'bscs-01',
      };

      const outcomes = await Promise.allSettled([
        insertRawSubmission(input),
        insertRawSubmission(input),
      ]);

      expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
      expect(await prisma().submission.count()).toBe(1);
    });
  });

  describe('getEvaluationContext', () => {
    /**
     * A submitted row carrying both a writing response and both Student Problems parts — the shape
     * `finalize` produces, built directly here so each test can break exactly one thing.
     */
    async function aSubmittedRow(overrides: SubmissionOverrides = {}) {
      const cohort = await createCohort();

      return createSubmission(cohort.id, {
        status: 'submitted',
        contentVersion: 'v1',
        answers: { writing: { essayText: 'Learning a language rewards patience.' } },
        ...overrides,
      });
    }

    it('resolves the writing response and the frozen content version', async () => {
      // ARCHITECTURE Section 15: "Returns the correct response text and contentVersion for both job
      // types". The version comes off the Submission row — never `getCurrentVersion()` — which is
      // what makes the caller's next step resolve the rubric the student was actually graded under.
      const submission = await aSubmittedRow({ contentVersion: 'v1' });

      const context = await repository.getEvaluationContext(
        submission.id,
        JOB_TYPES.writingEvaluation,
      );

      expect(context).toEqual({
        jobType: JOB_TYPES.writingEvaluation,
        responseText: 'Learning a language rewards patience.',
        contentVersion: 'v1',
      });
    });

    it('resolves the Student Problems text from its own column', async () => {
      // FR-PROB-009: the original is the record. It is a column of its own (Section 6), not a field
      // inside `answers`, so this is the only place the worker can be handed it from.
      const original = 'أجد صعوبة في التحدث أمام زملائي.';
      const submission = await aSubmittedRow({ problemsOpenTextOriginal: original });

      const context = await repository.getEvaluationContext(
        submission.id,
        JOB_TYPES.studentProblemsText,
      );

      expect(context.responseText).toBe(original);
      expect(context.contentVersion).toBe('v1');
    });

    it('returns the text untrimmed, exactly as it was stored', async () => {
      // FR-PROB-009 makes the original the record. Whitespace is checked to decide emptiness and
      // then left alone — handing back a trimmed version would quietly alter what the student wrote
      // before the model ever saw it.
      const padded = '  I translate from Arabic in my head.  ';
      const submission = await aSubmittedRow({ problemsOpenTextOriginal: padded });

      const context = await repository.getEvaluationContext(
        submission.id,
        JOB_TYPES.studentProblemsText,
      );

      expect(context.responseText).toBe(padded);
    });

    it('throws rather than returning an empty string for a writing job with no writing answer', async () => {
      // Section 15 names this case. An empty string would be sent to the model, which would return
      // criterion judgments about a text that does not exist — a plausible-looking score, and no
      // error anywhere. A refusal lands the job in `failed_needs_review` where staff can see it.
      const submission = await createSubmission((await createCohort()).id, {
        status: 'submitted',
        answers: {},
      });

      await expect(
        repository.getEvaluationContext(submission.id, JOB_TYPES.writingEvaluation),
      ).rejects.toThrow(/no essay text/);
    });

    it('treats a whitespace-only writing answer as no answer', async () => {
      // The same reading `SubmissionService.incompleteSections` takes: a check for "did they write
      // something" must not be satisfied by spaces.
      const submission = await aSubmittedRow({ answers: { writing: { essayText: '   \n  ' } } });

      await expect(
        repository.getEvaluationContext(submission.id, JOB_TYPES.writingEvaluation),
      ).rejects.toThrow(/no essay text/);
    });

    it('throws for a Student Problems job on a submission with no open text', async () => {
      // `finalize` records `not_applicable` and enqueues no job in this case, so reaching here means
      // a row nothing in this system wrote.
      const submission = await aSubmittedRow();

      await expect(
        repository.getEvaluationContext(submission.id, JOB_TYPES.studentProblemsText),
      ).rejects.toThrow(/problemsOpenTextOriginal is empty/);
    });

    it('throws for a submission that does not exist', async () => {
      await expect(
        repository.getEvaluationContext(
          '00000000-0000-0000-0000-000000000000',
          JOB_TYPES.writingEvaluation,
        ),
      ).rejects.toThrow(/no submission with id/);
    });

    it('throws for a job type it does not recognize', async () => {
      // The claim query can hand back any `jobType` string (Section 6 makes it a plain string
      // column), so an unrecognized one has to be refused here rather than guessed at.
      const submission = await aSubmittedRow();

      await expect(
        repository.getEvaluationContext(submission.id, 'not_a_job_type'),
      ).rejects.toThrow(/unrecognized job type/);
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
