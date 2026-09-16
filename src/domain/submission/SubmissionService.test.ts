import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../../config/env.ts';
import { ContentLoader, type ContentBundle } from '../../content/ContentLoader.ts';
import { submissionRepository } from '../../data/SubmissionRepository.ts';
import type { DraftAnswers } from '../../shared/types/draft.ts';
import { createCohort, createSubmission, prisma, useCleanTestDatabase } from '../../test/fixtures.ts';
import { JOB_TYPES, SubmissionService } from './SubmissionService.ts';

/**
 * Integration coverage for `SubmissionService.finalize()` (T5.2.1, ARCHITECTURE Section 15 —
 * "First submission succeeds; second attempt for the same identity is idempotent (no duplicate row,
 * no error); concurrent simultaneous submit requests (simulated) never create two rows; incomplete
 * required sections are rejected").
 *
 * Against the real test database, because the properties under test are database properties. The
 * idempotency guarantee is a row lock and the no-double-finalize guarantee is that lock's
 * consequence; a mocked client would let this suite pass while the real one let two submits through.
 *
 * The service is constructed with both dependencies injected rather than taken from
 * `getSubmissionService()`, so a test can point it at a fixture content tree — which the
 * frozen-version case needs, since that property is only observable when two versions exist.
 */

const REAL_CONTENT = path.join(REPO_ROOT, 'content');

const tempRoots: string[] = [];

afterAll(() => {
  for (const root of tempRoots) fs.rmSync(root, { recursive: true, force: true });
});

useCleanTestDatabase();

/** The service under test, reading from the repository's own content by default. */
function serviceWith(content?: ContentLoader): SubmissionService {
  return new SubmissionService({
    submissions: submissionRepository,
    content: content ?? new ContentLoader(REAL_CONTENT),
  });
}

/** A complete set of answers, every deterministic question answered correctly. */
function answersFrom(content: ContentBundle): DraftAnswers {
  const questionsOf = (section: 'grammar' | 'vocabulary') =>
    content[section].questions;
  const readingQuestions = content.reading.passages.flatMap((passage) => passage.questions);

  const toAnswerKey = (questions: { id: string; correctAnswer: string }[]) =>
    Object.fromEntries(questions.map((question) => [question.id, question.correctAnswer]));

  return {
    grammar: toAnswerKey(questionsOf('grammar')),
    vocabulary: toAnswerKey(questionsOf('vocabulary')),
    reading: toAnswerKey(readingQuestions),
    writing: { essayText: 'Learning a language is a long project, but it rewards patience.' },
    studentProblems: {
      likertAnswers: Object.fromEntries(
        content.studentProblems.statements.map((statement) => [statement.id, 4]),
      ),
      openText: 'أجد صعوبة في التحدث أمام زملائي.',
    },
  };
}

/** The total points a section is worth, computed from content rather than assumed. */
function maxScoreOf(questions: { points: number }[]): number {
  return questions.reduce((total, question) => total + question.points, 0);
}

/** The stored jobs for a submission, oldest first. */
function jobsFor(submissionId: string) {
  return prisma().processingJob.findMany({
    where: { submissionId },
    orderBy: { createdAt: 'asc' },
  });
}

describe('SubmissionService.finalize — the first submit', () => {
  it('scores the deterministic sections and records the submission as submitted', async () => {
    const content = new ContentLoader(REAL_CONTENT).getContent('v1');
    const cohort = await createCohort();
    const submission = await createSubmission(cohort.id, {
      contentVersion: 'v1',
      answers: answersFrom(content),
    });

    const result = await serviceWith().finalize(submission.id);

    expect(result.outcome).toBe('finalized');

    const stored = await prisma().submission.findUniqueOrThrow({ where: { id: submission.id } });
    expect(stored.status).toBe('submitted');
    expect(stored.submittedAt).toBeInstanceOf(Date);

    // Every question was answered correctly, so each section scores its full maximum — and the
    // maximum is read from content, so this cannot pass by hardcoding a question count.
    expect(stored.grammarScore).toBe(maxScoreOf(content.grammar.questions));
    expect(stored.vocabularyScore).toBe(maxScoreOf(content.vocabulary.questions));
    expect(stored.readingScore).toBe(
      maxScoreOf(content.reading.passages.flatMap((passage) => passage.questions)),
    );
  });

  it('leaves the answers exactly as the student saved them', async () => {
    // Section 12: `answers` is the frozen record. Finalization reads it and writes alongside it; it
    // never rewrites it. A submission whose answers changed at submit time would be a record of
    // something the student did not do.
    const content = new ContentLoader(REAL_CONTENT).getContent('v1');
    const cohort = await createCohort();
    const answers = answersFrom(content);
    const submission = await createSubmission(cohort.id, {
      contentVersion: 'v1',
      answers,
    });

    await serviceWith().finalize(submission.id);

    const stored = await prisma().submission.findUniqueOrThrow({ where: { id: submission.id } });
    expect(stored.answers).toEqual(answers);
  });

  it('lifts the Student Problems responses into their own columns, original text unaltered', async () => {
    // FR-PROB-005 keeps the scale responses and the free text distinct; FR-PROB-009 makes the
    // original the record. This is the one write of that column in the whole system.
    const content = new ContentLoader(REAL_CONTENT).getContent('v1');
    const cohort = await createCohort();
    const answers = answersFrom(content);
    const submission = await createSubmission(cohort.id, {
      contentVersion: 'v1',
      answers,
    });

    await serviceWith().finalize(submission.id);

    const stored = await prisma().submission.findUniqueOrThrow({ where: { id: submission.id } });
    expect(stored.problemsLikertAnswers).toEqual(answers.studentProblems?.likertAnswers);
    expect(stored.problemsOpenTextOriginal).toBe(answers.studentProblems?.openText);
  });

  it('enqueues the writing job, and the Student Problems job when open text was given', async () => {
    const content = new ContentLoader(REAL_CONTENT).getContent('v1');
    const cohort = await createCohort();
    const submission = await createSubmission(cohort.id, {
      contentVersion: 'v1',
      answers: answersFrom(content),
    });

    await serviceWith().finalize(submission.id);

    const jobs = await jobsFor(submission.id);
    expect(jobs.map((job) => job.jobType).sort()).toEqual([
      JOB_TYPES.studentProblemsText,
      JOB_TYPES.writingEvaluation,
    ]);
    // Claimable by the worker's very next poll: the schema's defaults, not something finalize sets.
    expect(jobs.every((job) => job.status === 'pending')).toBe(true);
    expect(jobs.every((job) => job.attemptCount === 0)).toBe(true);
  });

  it('marks writing pending, so the report can say feedback is still being prepared', async () => {
    // `not_applicable` is the column default and means "there was nothing to process". Writing is
    // always something to process, so finalize is what moves it off that value — and until T7.3.1
    // completes the job, `pending` is the honest state (FR-FEEDBACK-004).
    const content = new ContentLoader(REAL_CONTENT).getContent('v1');
    const cohort = await createCohort();
    const submission = await createSubmission(cohort.id, {
      contentVersion: 'v1',
      answers: answersFrom(content),
    });

    await serviceWith().finalize(submission.id);

    const stored = await prisma().submission.findUniqueOrThrow({ where: { id: submission.id } });
    expect(stored.writingStatus).toBe('pending');
    expect(stored.problemsTextStatus).toBe('pending');
  });

  it('leaves the Student Problems text status not applicable when no open text was given', async () => {
    // The value the enum documents: there is no text, so there is no work, and no job is created for
    // work that does not exist.
    const content = new ContentLoader(REAL_CONTENT).getContent('v1');
    const cohort = await createCohort();
    const answers = answersFrom(content);
    delete answers.studentProblems?.openText;
    const submission = await createSubmission(cohort.id, { contentVersion: 'v1', answers });

    const result = await serviceWith().finalize(submission.id);

    expect(result.outcome).toBe('finalized');

    const stored = await prisma().submission.findUniqueOrThrow({ where: { id: submission.id } });
    expect(stored.problemsTextStatus).toBe('not_applicable');
    expect(stored.problemsOpenTextOriginal).toBeNull();
    expect(stored.problemsLikertAnswers).toEqual(answers.studentProblems?.likertAnswers);

    const jobs = await jobsFor(submission.id);
    expect(jobs.map((job) => job.jobType)).toEqual([JOB_TYPES.writingEvaluation]);
  });
});

describe('SubmissionService.finalize — idempotency', () => {
  it('treats a second finalize as a no-op that returns the existing submission', async () => {
    // Section 11 lists a double-clicked submit under "Treated as success — the existing report is
    // returned, not an error".
    const content = new ContentLoader(REAL_CONTENT).getContent('v1');
    const cohort = await createCohort();
    const submission = await createSubmission(cohort.id, {
      contentVersion: 'v1',
      answers: answersFrom(content),
    });
    const service = serviceWith();

    const first = await service.finalize(submission.id);
    const second = await service.finalize(submission.id);

    expect(first.outcome).toBe('finalized');
    expect(second.outcome).toBe('already_submitted');

    if (first.outcome !== 'finalized' || second.outcome !== 'already_submitted') return;

    // The same row, unchanged — not a second transition that happens to look the same.
    expect(second.submission.id).toBe(first.submission.id);
    expect(second.submission.submittedAt?.getTime()).toBe(first.submission.submittedAt?.getTime());
    expect(second.submission.grammarScore).toBe(first.submission.grammarScore);
  });

  it('does not enqueue the jobs a second time', async () => {
    // The assertion that actually catches a double transition. Two submissions rows cannot exist for
    // one identity (the unique constraint), so a re-finalize that slipped through would show up here
    // as a duplicate job — and as a background evaluation the student is billed for in quota terms
    // and would see twice.
    const content = new ContentLoader(REAL_CONTENT).getContent('v1');
    const cohort = await createCohort();
    const submission = await createSubmission(cohort.id, {
      contentVersion: 'v1',
      answers: answersFrom(content),
    });
    const service = serviceWith();

    await service.finalize(submission.id);
    await service.finalize(submission.id);
    await service.finalize(submission.id);

    const jobs = await jobsFor(submission.id);
    expect(jobs.map((job) => job.jobType).sort()).toEqual([
      JOB_TYPES.studentProblemsText,
      JOB_TYPES.writingEvaluation,
    ]);
    expect(await prisma().submission.count()).toBe(1);
  });

  it('answers a finalize for a submission that does not exist with not_found', async () => {
    const result = await serviceWith().finalize('00000000-0000-0000-0000-000000000000');

    expect(result.outcome).toBe('not_found');
  });
});

describe('SubmissionService.finalize — concurrent submits', () => {
  it('finalizes once when two submits arrive together', async () => {
    // The race Section 3's check-then-write would lose. Both calls are in flight before either is
    // awaited, so both read the row; the row lock (`SELECT … FOR UPDATE`) is what makes the second
    // wait and then see the committed `submitted`, rather than both deciding to finalize.
    const content = new ContentLoader(REAL_CONTENT).getContent('v1');
    const cohort = await createCohort();
    const submission = await createSubmission(cohort.id, {
      contentVersion: 'v1',
      answers: answersFrom(content),
    });
    const service = serviceWith();

    const results = await Promise.all([
      service.finalize(submission.id),
      service.finalize(submission.id),
    ]);

    // Exactly one of them did the work; the other observed the result of it.
    expect(results.map((result) => result.outcome).sort()).toEqual([
      'already_submitted',
      'finalized',
    ]);

    // And the database agrees: one submission for the identity, one set of jobs.
    expect(await prisma().submission.count()).toBe(1);
    const jobs = await jobsFor(submission.id);
    expect(jobs.map((job) => job.jobType).sort()).toEqual([
      JOB_TYPES.studentProblemsText,
      JOB_TYPES.writingEvaluation,
    ]);

    const stored = await prisma().submission.findUniqueOrThrow({ where: { id: submission.id } });
    expect(stored.status).toBe('submitted');
  });

  it('finalizes once when several submits arrive together', async () => {
    // More than two, because a lock that happens to serialize a pair could still let three through
    // if the check ran outside it.
    const content = new ContentLoader(REAL_CONTENT).getContent('v1');
    const cohort = await createCohort();
    const submission = await createSubmission(cohort.id, {
      contentVersion: 'v1',
      answers: answersFrom(content),
    });
    const service = serviceWith();

    const results = await Promise.all(
      Array.from({ length: 5 }, () => service.finalize(submission.id)),
    );

    const outcomes = results.map((result) => result.outcome);
    expect(outcomes.filter((outcome) => outcome === 'finalized')).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome === 'already_submitted')).toHaveLength(4);

    expect(await prisma().processingJob.count({ where: { submissionId: submission.id } })).toBe(2);
  });
});

describe('SubmissionService.finalize — incomplete submissions', () => {
  /** A complete set of answers for the real content, so a test can break exactly one thing. */
  function completeAnswers(): DraftAnswers {
    return answersFrom(new ContentLoader(REAL_CONTENT).getContent('v1'));
  }

  it('refuses a draft with an unfinished section and names it', async () => {
    const cohort = await createCohort();
    const answers = completeAnswers();
    delete answers.reading;
    const submission = await createSubmission(cohort.id, { contentVersion: 'v1', answers });

    const result = await serviceWith().finalize(submission.id);

    expect(result).toEqual({ outcome: 'incomplete', incompleteSections: ['reading'] });
  });

  it('names every unfinished section, in presentation order', async () => {
    const cohort = await createCohort();
    const submission = await createSubmission(cohort.id, { contentVersion: 'v1', answers: {} });

    const result = await serviceWith().finalize(submission.id);

    expect(result).toEqual({
      outcome: 'incomplete',
      incompleteSections: ['grammar', 'vocabulary', 'reading', 'writing', 'studentProblems'],
    });
  });

  it('refuses a section that is answered only in part', async () => {
    // Every question, not "at least one" — the section is the unit the student is asked to finish.
    const cohort = await createCohort();
    const answers = completeAnswers();
    const grammar = answers.grammar ?? {};
    const [firstQuestionId] = Object.keys(grammar);
    const submission = await createSubmission(cohort.id, {
      contentVersion: 'v1',
      answers: { ...answers, grammar: { [firstQuestionId ?? '']: 'a' } },
    });

    const result = await serviceWith().finalize(submission.id);

    expect(result).toEqual({ outcome: 'incomplete', incompleteSections: ['grammar'] });
  });

  it('treats a blank writing response as unfinished', async () => {
    // A check whose purpose is that the student wrote must not be satisfied by spaces.
    const cohort = await createCohort();
    const answers = completeAnswers();
    const submission = await createSubmission(cohort.id, {
      contentVersion: 'v1',
      answers: { ...answers, writing: { essayText: '   ' } },
    });

    const result = await serviceWith().finalize(submission.id);

    expect(result).toEqual({ outcome: 'incomplete', incompleteSections: ['writing'] });
  });

  it('refuses Student Problems when a statement has no scale response', async () => {
    const content = new ContentLoader(REAL_CONTENT).getContent('v1');
    const cohort = await createCohort();
    const answers = completeAnswers();
    const likert = { ...answers.studentProblems?.likertAnswers };
    const [firstStatementId] = Object.keys(likert);
    delete likert[firstStatementId ?? ''];
    const submission = await createSubmission(cohort.id, {
      contentVersion: 'v1',
      answers: { ...answers, studentProblems: { likertAnswers: likert } },
    });

    const result = await serviceWith().finalize(submission.id);

    expect(result).toEqual({ outcome: 'incomplete', incompleteSections: ['studentProblems'] });
    expect(content.studentProblems.statements.length).toBeGreaterThan(0);
  });

  it('accepts a submission whose open-ended Student Problems answer is blank', async () => {
    // FR-ASSESS-007 / EDGE-007: the open text is optional and must never block submission.
    const cohort = await createCohort();
    const answers = completeAnswers();
    const submission = await createSubmission(cohort.id, {
      contentVersion: 'v1',
      answers: { ...answers, studentProblems: { ...answers.studentProblems, openText: '' } },
    });

    const result = await serviceWith().finalize(submission.id);

    expect(result.outcome).toBe('finalized');
  });

  it('leaves an incomplete draft untouched: still a draft, scored nothing, no jobs', async () => {
    // The refusal has to be a refusal, not a partial finalization. A student who is told their
    // Reading is unfinished must still find their Reading editable.
    const cohort = await createCohort();
    const answers = completeAnswers();
    delete answers.reading;
    const submission = await createSubmission(cohort.id, { contentVersion: 'v1', answers });

    await serviceWith().finalize(submission.id);

    const stored = await prisma().submission.findUniqueOrThrow({ where: { id: submission.id } });
    expect(stored.status).toBe('draft');
    expect(stored.submittedAt).toBeNull();
    expect(stored.grammarScore).toBeNull();
    expect(stored.vocabularyScore).toBeNull();
    expect(stored.readingScore).toBeNull();
    expect(stored.writingStatus).toBe('not_applicable');
    expect(stored.answers).toEqual(answers);
    expect(await jobsFor(submission.id)).toEqual([]);
  });

  it('accepts the submission once the missing section is filled in', async () => {
    // The refusal is a state, not a block: the same draft finalizes normally afterwards, which is
    // what makes "still a draft" a meaningful answer rather than a dead end.
    const cohort = await createCohort();
    const answers = completeAnswers();
    const { reading, ...withoutReading } = answers as DraftAnswers & { reading: object };
    const submission = await createSubmission(cohort.id, {
      contentVersion: 'v1',
      answers: withoutReading,
    });

    expect((await serviceWith().finalize(submission.id)).outcome).toBe('incomplete');

    // The student finishes Reading — one section-scoped autosave, exactly as the UI would send it.
    await prisma().submission.update({
      where: { id: submission.id },
      data: { answers: { ...withoutReading, reading } },
    });

    expect((await serviceWith().finalize(submission.id)).outcome).toBe('finalized');
  });
});

describe('SubmissionService.finalize — the frozen content version', () => {
  /**
   * A throwaway content tree carrying two versions, with a newer one current.
   *
   * v1 and v2 are identical but for one Grammar answer key, which is the smallest change that makes
   * the same answers score differently under each. This is the only arrangement in which "scored
   * against the version it was taken under" and "scored against what is current" are distinguishable
   * — with a single version in the repository the two rules agree and a violation would be invisible.
   */
  function makeTwoVersionContentRoot(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lexora-finalize-content-'));
    tempRoots.push(root);
    fs.cpSync(REAL_CONTENT, root, { recursive: true });

    const versionTwo = path.join(root, 'versions', 'v2');
    fs.cpSync(path.join(root, 'versions', 'v1'), versionTwo, { recursive: true });

    const grammarPath = path.join(versionTwo, 'grammar-questions.json');
    const grammar = JSON.parse(fs.readFileSync(grammarPath, 'utf8'));
    const [first] = grammar.questions;
    first.correctAnswer = first.options.find(
      (option: { id: string }) => option.id !== first.correctAnswer,
    ).id;
    fs.writeFileSync(grammarPath, JSON.stringify(grammar, null, 2), 'utf8');

    fs.writeFileSync(
      path.join(root, 'current-version.json'),
      JSON.stringify({ version: 'v2' }, null, 2),
      'utf8',
    );

    return root;
  }

  it('scores against the version the submission was taken under, not the current one', async () => {
    const loader = new ContentLoader(makeTwoVersionContentRoot());
    expect(loader.getCurrentVersion()).toBe('v2');

    const versionOne = loader.getContent('v1');
    const versionTwo = loader.getContent('v2');

    // Answers correct under v1 — including the question v2 has re-keyed.
    const answers = answersFrom(versionOne);
    const [rekeyedQuestion] = versionTwo.grammar.questions;
    expect(rekeyedQuestion).toBeDefined();

    const cohort = await createCohort();
    const submission = await createSubmission(cohort.id, {
      contentVersion: 'v1',
      answers,
    });

    const result = await serviceWith(loader).finalize(submission.id);
    expect(result.outcome).toBe('finalized');

    const stored = await prisma().submission.findUniqueOrThrow({ where: { id: submission.id } });
    const fullMarks = maxScoreOf(versionOne.grammar.questions);

    // Full marks under v1. Under v2 the same answers would be one question short, so this number is
    // the difference between reading the frozen version and reading `getCurrentVersion()`.
    expect(stored.grammarScore).toBe(fullMarks);
    expect(stored.grammarScore).not.toBe(fullMarks - (rekeyedQuestion?.points ?? 0));
  });

  it('refuses to score a submission whose frozen version no longer resolves', async () => {
    // `getContent` throws for an unknown version rather than falling back (Section 12). Falling back
    // here would score a student against questions they never saw, and the numbers would look
    // entirely reasonable — which is why the loud failure is the right one.
    const cohort = await createCohort();
    const submission = await createSubmission(cohort.id, {
      contentVersion: 'v-does-not-exist',
      answers: answersFrom(new ContentLoader(REAL_CONTENT).getContent('v1')),
    });

    await expect(serviceWith().finalize(submission.id)).rejects.toThrow(/v-does-not-exist/);

    // And the refusal left nothing half-written.
    const stored = await prisma().submission.findUniqueOrThrow({ where: { id: submission.id } });
    expect(stored.status).toBe('draft');
    expect(stored.submittedAt).toBeNull();
    expect(await jobsFor(submission.id)).toEqual([]);
  });
});

describe('SubmissionService.finalize — access boundaries it must not cross', () => {
  it('writes only to the submission it was given', async () => {
    const content = new ContentLoader(REAL_CONTENT).getContent('v1');
    const cohort = await createCohort();
    const mine = await createSubmission(cohort.id, {
      contentVersion: 'v1',
      answers: answersFrom(content),
    });
    const theirs = await createSubmission(cohort.id, {
      contentVersion: 'v1',
      answers: answersFrom(content),
    });

    await serviceWith().finalize(mine.id);

    const untouched = await prisma().submission.findUniqueOrThrow({ where: { id: theirs.id } });
    expect(untouched.status).toBe('draft');
    expect(untouched.submittedAt).toBeNull();
    expect(await jobsFor(theirs.id)).toEqual([]);
  });
});
