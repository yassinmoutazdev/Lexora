import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../../config/env.ts';
import { ContentLoader, getContentLoader } from '../../content/ContentLoader.ts';
import { dashboardRepository } from '../../data/DashboardRepository.ts';
import { createCohort, createSubmission, useCleanTestDatabase } from '../../test/fixtures.ts';
import { DashboardService } from './DashboardService.ts';

/**
 * Integration tests for the dashboard aggregates (T8.1.1, PRD Section 9.7; ARCHITECTURE Section 14).
 *
 * Against the real test database and the real content bundle, because both are load-bearing here:
 * the percentages in the payload come from maxima that live in `content/versions/v1`, and the
 * Student Problems statement wording comes from the same bundle. A test that stubbed the content
 * would be asserting the shape of its own fixture rather than that a seeded cohort's numbers come
 * out right, which is what ARCHITECTURE Section 15 asks this suite to cover ("correct
 * counts/averages against seeded fixture data, including cohort filtering").
 *
 * ## The maxima these expectations are written against
 *
 * Under v1 content: Grammar 9 points, Vocabulary 9, Reading 8, and Writing 0–100 (the rubric's own
 * `scoreRange`). The overall figure is Grammar + Vocabulary + Reading out of 26 — Writing is
 * compared beside them rather than folded in, because PRD Section 23.1 item 1 leaves the weight
 * between the two measurements TBD.
 */

const service = new DashboardService({
  dashboard: dashboardRepository,
  content: getContentLoader(),
});

useCleanTestDatabase();

/** The dashboard for one request, unwrapped — every test here expects a payload. */
async function dashboard(cohortId?: string) {
  const result = await service.getDashboard(cohortId === undefined ? {} : { cohortId });

  if (result.outcome !== 'ok') throw new Error(`expected a payload, got ${result.outcome}`);

  return result.payload;
}

/** The section entry with this key. */
function sectionOf(payload: Awaited<ReturnType<typeof dashboard>>, section: string) {
  const found = payload.sections.find((candidate) => candidate.section === section);
  if (!found) throw new Error(`no ${section} section in the payload`);

  return found;
}

/** The band count for one label. */
function band(entry: { distribution: { label: string; count: number }[] }, label: string): number {
  const found = entry.distribution.find((candidate) => candidate.label === label);
  if (!found) throw new Error(`no ${label} band`);

  return found.count;
}

describe('DashboardService — counts and completion status (FR-STAFF-004)', () => {
  it('counts drafts and submitted submissions, and tallies their processing state', async () => {
    const cohort = await createCohort();

    await createSubmission(cohort.id, { status: 'draft' });
    await createSubmission(cohort.id, { status: 'draft' });
    await createSubmission(cohort.id, {
      status: 'submitted',
      writingStatus: 'succeeded',
      writingOverallScore: 80,
      problemsTextStatus: 'succeeded',
    });
    await createSubmission(cohort.id, {
      status: 'submitted',
      writingStatus: 'pending',
      problemsTextStatus: 'not_applicable',
    });
    await createSubmission(cohort.id, {
      status: 'submitted',
      writingStatus: 'failed_needs_review',
      problemsTextStatus: 'pending',
    });

    const payload = await dashboard(cohort.id);

    expect(payload.counts.submissions).toBe(5);
    expect(payload.counts.draft).toBe(2);
    expect(payload.counts.submitted).toBe(3);

    // Processing tallies cover submitted rows only — the two drafts' `not_applicable` columns are
    // not a cohort of students whose Writing needs no evaluation.
    expect(payload.counts.writing).toEqual({
      not_applicable: 0,
      pending: 1,
      processing: 0,
      succeeded: 1,
      failed_needs_review: 1,
    });
    expect(payload.counts.problemsText).toEqual({
      not_applicable: 1,
      pending: 1,
      processing: 0,
      succeeded: 1,
      failed_needs_review: 0,
    });
  });

  it('reports zeroes rather than omitting a tally when a cohort has nothing in it', async () => {
    const cohort = await createCohort();

    const payload = await dashboard(cohort.id);

    expect(payload.counts.submissions).toBe(0);
    expect(payload.counts.writing.succeeded).toBe(0);
    expect(payload.sections.map((entry) => entry.scoredSubmissions)).toEqual([0, 0, 0, 0]);
    expect(payload.overall).toEqual({
      scoredSubmissions: 0,
      meanPercent: 0,
      distribution: bandCountsAtZero(),
      includes: ['grammar', 'vocabulary', 'reading'],
    });
  });
});

describe('DashboardService — score distributions and the section comparison (FR-STAFF-005/006)', () => {
  it('computes each section as a percentage of its own maximum, from the frozen content version', async () => {
    const cohort = await createCohort();

    // 9/9 = 100%, 8/8 = 100%.
    await createSubmission(cohort.id, {
      status: 'submitted',
      grammarScore: 9,
      vocabularyScore: 9,
      readingScore: 8,
      writingStatus: 'succeeded',
      writingOverallScore: 90,
    });
    // 5/9 ≈ 55.56%, 4/8 = 50%.
    await createSubmission(cohort.id, {
      status: 'submitted',
      grammarScore: 5,
      vocabularyScore: 5,
      readingScore: 4,
      writingStatus: 'pending',
    });

    const payload = await dashboard(cohort.id);

    const grammar = sectionOf(payload, 'grammar');
    expect(grammar.title).toBe('Grammar');
    expect(grammar.scoredSubmissions).toBe(2);
    expect(grammar.meanScore).toBe(7);
    expect(grammar.maxScore).toBe(9);
    expect(grammar.meanPercent).toBe(77.78); // (100 + 55.56) / 2

    // The axis FR-STAFF-006 needs: Reading is out of 8 and Writing out of 100, and both are
    // reported on the same 0–100 scale as Grammar.
    const reading = sectionOf(payload, 'reading');
    expect(reading.maxScore).toBe(8);
    expect(reading.meanPercent).toBe(75); // (100 + 50) / 2

    const writing = sectionOf(payload, 'writing');
    expect(writing.title).toBe('Writing');
    expect(writing.maxScore).toBe(100);
    expect(writing.scoredSubmissions).toBe(1); // only the one whose evaluation succeeded
    expect(writing.meanPercent).toBe(90);

    // The comparison itself: four sections, in the order FR-STAFF-006 lists them.
    expect(payload.sections.map((entry) => entry.section)).toEqual([
      'grammar',
      'vocabulary',
      'reading',
      'writing',
    ]);
  });

  it('bands scores as percentages of each section maximum, not as raw marks', async () => {
    const cohort = await createCohort();

    // Raw 9 is the top of Grammar's range and lands in the top band; raw 9 of Writing's 100 does
    // not. If the bands were drawn on raw scores these two would be indistinguishable.
    await createSubmission(cohort.id, {
      status: 'submitted',
      grammarScore: 9,
      vocabularyScore: 1,
      readingScore: 8,
      writingStatus: 'succeeded',
      writingOverallScore: 9,
    });

    const payload = await dashboard(cohort.id);

    expect(band(sectionOf(payload, 'grammar'), '90–100%')).toBe(1);
    expect(band(sectionOf(payload, 'vocabulary'), '0–49%')).toBe(1);
    expect(band(sectionOf(payload, 'reading'), '90–100%')).toBe(1);
    expect(band(sectionOf(payload, 'writing'), '0–49%')).toBe(1);
  });

  it('reports the overall figure over the three deterministic sections, and says which', async () => {
    const cohort = await createCohort();

    // 9 + 9 + 8 = 26 of 26 → 100%.
    await createSubmission(cohort.id, {
      status: 'submitted',
      grammarScore: 9,
      vocabularyScore: 9,
      readingScore: 8,
      writingStatus: 'succeeded',
      // Deliberately unlike the deterministic result: Writing is not part of the overall.
      writingOverallScore: 10,
    });
    // 0 + 0 + 0 = 0%.
    await createSubmission(cohort.id, {
      status: 'submitted',
      grammarScore: 0,
      vocabularyScore: 0,
      readingScore: 0,
    });

    const payload = await dashboard(cohort.id);

    expect(payload.overall.includes).toEqual(['grammar', 'vocabulary', 'reading']);
    expect(payload.overall.scoredSubmissions).toBe(2);
    expect(payload.overall.meanPercent).toBe(50);
    expect(band(payload.overall, '90–100%')).toBe(1);
    expect(band(payload.overall, '0–49%')).toBe(1);
  });

  it('leaves drafts out of the score aggregates entirely', async () => {
    const cohort = await createCohort();

    await createSubmission(cohort.id, { status: 'draft' });
    await createSubmission(cohort.id, {
      status: 'submitted',
      grammarScore: 9,
      vocabularyScore: 9,
      readingScore: 8,
    });

    const payload = await dashboard(cohort.id);

    // One scored submission, not two: a draft has no scores and must not drag a zero into the mean.
    expect(sectionOf(payload, 'grammar').scoredSubmissions).toBe(1);
    expect(sectionOf(payload, 'grammar').meanPercent).toBe(100);
    expect(payload.overall.scoredSubmissions).toBe(1);
  });
});

describe('DashboardService — most common Student Problems responses (FR-STAFF-008)', () => {
  it('counts the five-point responses per statement and names the most common one', async () => {
    const cohort = await createCohort();

    // sp-01 answered 5, 5, 2 by three students; sp-02 answered 3 once.
    await createSubmission(cohort.id, {
      status: 'submitted',
      problemsLikertAnswers: { 'sp-01': 5, 'sp-02': 3 },
      problemsTextStatus: 'not_applicable',
    });
    await createSubmission(cohort.id, {
      status: 'submitted',
      problemsLikertAnswers: { 'sp-01': 5, 'sp-02': 3 },
      problemsTextStatus: 'not_applicable',
    });
    await createSubmission(cohort.id, {
      status: 'submitted',
      problemsLikertAnswers: { 'sp-01': 2 },
      problemsTextStatus: 'not_applicable',
    });

    const payload = await dashboard(cohort.id);

    const sp01 = payload.problems.statements.find((entry) => entry.statementId === 'sp-01');
    expect(sp01).toBeDefined();
    // The statement's own wording, from the versioned bundle rather than from the row.
    expect(sp01?.statement).toBe('I feel confident when I speak English around other people.');
    expect(sp01?.area).toBe('speaking_confidence');
    expect(sp01?.areaLabel).toBe('Speaking and confidence');
    expect(sp01?.responses).toBe(3);
    expect(sp01?.mean).toBe(4); // (5 + 5 + 2) / 3
    expect(sp01?.counts.map((count) => count.value)).toEqual([1, 2, 3, 4, 5]);
    expect(sp01?.counts.map((count) => count.count)).toEqual([0, 1, 0, 0, 2]);
    // The scale's own labels come from the bundle too, so a five-point answer is never rendered
    // as a bare number where the instrument's wording belongs.
    expect(sp01?.counts[4]?.label).toBe('Strongly agree');
    expect(sp01?.mostCommon).toEqual({ value: 5, label: 'Strongly agree', count: 2 });

    const sp02 = payload.problems.statements.find((entry) => entry.statementId === 'sp-02');
    expect(sp02?.responses).toBe(2);
    expect(sp02?.mostCommon).toEqual({ value: 3, label: 'Neutral', count: 2 });
  });

  it('keeps the AI-derived categories out of the statements the students answered', async () => {
    const cohort = await createCohort();

    await createSubmission(cohort.id, {
      status: 'submitted',
      problemsLikertAnswers: { 'sp-01': 4 },
      problemsOpenTextOriginal: 'I struggle to follow fast speech.',
      problemsTextStatus: 'succeeded',
      problemsTextDerived: {
        normalizedText: 'I struggle to follow fast speech.',
        categories: [
          { label: 'Listening speed', evidence: 'follow fast speech' },
          { label: 'Confidence', evidence: 'struggle' },
        ],
      },
    });
    await createSubmission(cohort.id, {
      status: 'submitted',
      problemsLikertAnswers: { 'sp-01': 4 },
      problemsOpenTextOriginal: 'Fast speech is hard.',
      problemsTextStatus: 'succeeded',
      problemsTextDerived: {
        normalizedText: 'Fast speech is hard.',
        categories: [{ label: 'Listening speed', evidence: 'Fast speech' }],
      },
    });
    // Still pending: its open text has produced no categories yet, so it contributes none.
    await createSubmission(cohort.id, {
      status: 'submitted',
      problemsLikertAnswers: { 'sp-01': 2 },
      problemsOpenTextOriginal: 'I find writing hard.',
      problemsTextStatus: 'pending',
    });

    const payload = await dashboard(cohort.id);

    expect(payload.problems.derivedCategories).toEqual([
      { label: 'Listening speed', count: 2 },
      { label: 'Confidence', count: 1 },
    ]);
    expect(payload.problems.analysedResponses).toBe(2);

    // The derived categories are their own list, and the students' responses are another. A page
    // that rendered one as the other would be presenting the model's labels as the cohort's words
    // (FR-PROB-011), which is why they are not merged here where a caller could not separate them.
    expect(payload.problems.statements.every((entry) => entry.statementId.startsWith('sp-'))).toBe(
      true,
    );
  });
});

describe('DashboardService — cohort filter (FR-STAFF-009)', () => {
  it('covers every cohort when no filter is given, and one when it is', async () => {
    const first = await createCohort({ code: 'FILTER-A' });
    const second = await createCohort({ code: 'FILTER-B' });

    await createSubmission(first.id, {
      status: 'submitted',
      grammarScore: 9,
      vocabularyScore: 9,
      readingScore: 8,
    });
    await createSubmission(second.id, {
      status: 'submitted',
      grammarScore: 0,
      vocabularyScore: 0,
      readingScore: 0,
    });

    const all = await dashboard();
    expect(all.cohort).toBeNull();
    expect(all.counts.submitted).toBe(2);
    expect(all.overall.meanPercent).toBe(50);

    // Every cohort is offered as a filter option, not only the one being shown.
    expect(all.cohorts.map((entry) => entry.code)).toContain('FILTER-A');
    expect(all.cohorts.map((entry) => entry.code)).toContain('FILTER-B');

    const onlyFirst = await dashboard(first.id);
    expect(onlyFirst.cohort).toEqual({ id: first.id, code: 'FILTER-A', name: first.name });
    expect(onlyFirst.counts.submitted).toBe(1);
    expect(onlyFirst.overall.meanPercent).toBe(100);
    expect(band(onlyFirst.overall, '90–100%')).toBe(1);
    expect(band(onlyFirst.overall, '0–49%')).toBe(0);
  });

  it('refuses a filter that names no cohort rather than reporting every cohort as if filtered', async () => {
    await createCohort();
    await createSubmission((await createCohort()).id, { status: 'submitted' });

    const result = await service.getDashboard({ cohortId: '00000000-0000-0000-0000-000000000000' });

    expect(result).toEqual({ outcome: 'unknown_cohort' });
  });
});

/** All six bands at zero, in order — the shape an empty cohort renders. */
function bandCountsAtZero() {
  return ['0–49%', '50–59%', '60–69%', '70–79%', '80–89%', '90–100%'].map((label) => ({
    label,
    count: 0,
  }));
}

/**
 * The conditional difficulty comparison (FR-STAFF-007, T8.1.2).
 *
 * The requirement is a *negative* one — "the system must not present a misleading comparison when
 * the available metadata or question distribution is insufficient" — so two of the three cases
 * below prove the comparison is **omitted**, and say which gate omitted it. The third proves the
 * capability is real rather than permanently off, by giving it content that can carry it.
 *
 * The content is the variable under test, so it is built rather than assumed: `content/versions/v1`
 * is copied into a temp tree and its three question files are approved (they are `provisional` as
 * committed, which is PRD Section 23.1 item 3's open question set). Nothing is ever written into
 * the repository's own `content/`.
 */

const tempRoots: string[] = [];

afterAll(() => {
  for (const root of tempRoots) fs.rmSync(root, { recursive: true, force: true });
});

/**
 * Builds a fixture content tree with one extra version, and a loader for it.
 *
 * `mutate` receives that version's directory so each test can decide what makes its content
 * approvable or not.
 */
function fixtureContent(
  version: string,
  mutate: (versionDir: string) => void,
): { loader: ContentLoader; service: DashboardService } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lexora-dashboard-'));
  tempRoots.push(root);
  fs.cpSync(path.join(REPO_ROOT, 'content'), root, { recursive: true });

  const versionDir = path.join(root, 'versions', version);
  fs.cpSync(path.join(root, 'versions', 'v1'), versionDir, { recursive: true });
  mutate(versionDir);

  const loader = new ContentLoader(root);

  return {
    loader,
    service: new DashboardService({ dashboard: dashboardRepository, content: loader }),
  };
}

function readJson(filePath: string): any {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJson(filePath: string, value: unknown): void {
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf8');
}

/** Marks a version's three question files final, which is FR-STAFF-007's first gate. */
function approveQuestionFiles(versionDir: string): void {
  for (const name of [
    'grammar-questions.json',
    'vocabulary-questions.json',
    'reading-questions.json',
  ]) {
    const filePath = path.join(versionDir, name);
    const file = readJson(filePath);
    file.contentStatus = 'approved';
    delete file.statusNote;
    writeJson(filePath, file);
  }
}

/** The payload a fixture service returns, unwrapped. */
async function fixtureDashboard(service: DashboardService, cohortId: string) {
  const result = await service.getDashboard({ cohortId });

  if (result.outcome !== 'ok') throw new Error(`expected a payload, got ${result.outcome}`);

  return result.payload;
}

/** Every question in a section of a bundle, Reading's flattened out of its passages. */
function questionsOf(loader: ContentLoader, version: string, section: string) {
  const content = loader.getContent(version);

  return section === 'reading'
    ? content.reading.passages.flatMap((passage) => passage.questions)
    : (content as any)[section].questions;
}

/** Answers for a whole section, every one of them right or every one of them wrong. */
function answersFor(
  loader: ContentLoader,
  version: string,
  section: string,
  correctness: 'correct' | 'wrong',
): Record<string, string> {
  return Object.fromEntries(
    questionsOf(loader, version, section).map((question: any) => {
      if (correctness === 'correct') return [question.id, question.correctAnswer];

      // Any option that is not the key. The content schema guarantees a choice question has at
      // least two options and that the key is one of them, so this always finds one.
      const wrong = question.options.find((option: any) => option.id !== question.correctAnswer);
      return [question.id, wrong.id];
    }),
  );
}

describe('DashboardService — difficulty comparison is conditional (FR-STAFF-007)', () => {
  it('omits the comparison when the question set is provisional, and says so', async () => {
    // The real, committed content — every file `provisional` (PRD Section 23.1 item 3).
    const cohort = await createCohort();

    await createSubmission(cohort.id, {
      status: 'submitted',
      contentVersion: 'v1',
      grammarScore: 9,
      vocabularyScore: 9,
      readingScore: 8,
    });

    const payload = await dashboard(cohort.id);

    expect(payload.difficulty).toEqual({ available: false, reason: 'content_not_approved' });

    // The omission is *only* of the comparison: the same payload still carries the section figures
    // the rest of the dashboard is built from. A gate that took the rest of the page with it would
    // be a different, and much worse, failure.
    expect(payload.overall.scoredSubmissions).toBe(1);
    expect(sectionOf(payload, 'grammar').maxScore).toBe(9);
  });

  it('omits the comparison when a level is thinly represented, even with final content', async () => {
    const cohort = await createCohort();

    // Approved, but every Grammar and Vocabulary question has been relabelled to one level, so
    // `basic` and `upper-intermediate` are left with only Reading's two questions each — below the
    // three the service requires.
    const { loader, service: fixtureService } = fixtureContent('approved-thin', (versionDir) => {
      approveQuestionFiles(versionDir);

      for (const name of ['grammar-questions.json', 'vocabulary-questions.json']) {
        const filePath = path.join(versionDir, name);
        const file = readJson(filePath);
        for (const question of file.questions) question.difficulty = 'intermediate';
        writeJson(filePath, file);
      }
    });

    await createSubmission(cohort.id, {
      status: 'submitted',
      contentVersion: 'approved-thin',
      answers: {
        grammar: answersFor(loader, 'approved-thin', 'grammar', 'correct'),
        vocabulary: answersFor(loader, 'approved-thin', 'vocabulary', 'correct'),
        reading: answersFor(loader, 'approved-thin', 'reading', 'correct'),
      },
    });

    const payload = await fixtureDashboard(fixtureService, cohort.id);

    expect(payload.difficulty).toEqual({ available: false, reason: 'levels_under_represented' });
  });

  it('shows the comparison, with per-level accuracy, once the content can carry it', async () => {
    const cohort = await createCohort();

    const { loader, service: fixtureService } = fixtureContent('approved', approveQuestionFiles);

    // Grammar and Reading answered correctly, Vocabulary answered wrong — so the three levels differ
    // only by how many questions each section contributes to them, which is precisely what the
    // comparison has to be honest about.
    await createSubmission(cohort.id, {
      status: 'submitted',
      contentVersion: 'approved',
      answers: {
        grammar: answersFor(loader, 'approved', 'grammar', 'correct'),
        vocabulary: answersFor(loader, 'approved', 'vocabulary', 'wrong'),
        reading: answersFor(loader, 'approved', 'reading', 'correct'),
      },
      grammarScore: 9,
      vocabularyScore: 0,
      readingScore: 8,
    });

    const payload = await fixtureDashboard(fixtureService, cohort.id);

    // v1's distribution: Grammar 3/3/3, Vocabulary 3/3/3, Reading 2/4/2 — so 8 basic, 10
    // intermediate, 8 upper-intermediate question-responses from one submission.
    expect(payload.difficulty.available).toBe(true);
    if (!payload.difficulty.available) throw new Error('unreachable');

    expect(payload.difficulty.questionsPerLevel).toEqual({
      basic: 8,
      intermediate: 10,
      'upper-intermediate': 8,
    });

    // Correct = Grammar (3/3/3) + Reading (2/4/2); Vocabulary contributed none.
    expect(payload.difficulty.levels).toEqual([
      { difficulty: 'basic', responses: 8, correct: 5, accuracyPercent: 62.5 },
      { difficulty: 'intermediate', responses: 10, correct: 7, accuracyPercent: 70 },
      { difficulty: 'upper-intermediate', responses: 8, correct: 5, accuracyPercent: 62.5 },
    ]);
  });

  it('counts every contributing version, so one provisional version omits the comparison', async () => {
    const cohort = await createCohort();

    const { loader, service: fixtureService } = fixtureContent('approved', approveQuestionFiles);

    // One submission under the approved fixture version, one under the real provisional v1.
    await createSubmission(cohort.id, {
      status: 'submitted',
      contentVersion: 'approved',
      answers: {
        grammar: answersFor(loader, 'approved', 'grammar', 'correct'),
        vocabulary: answersFor(loader, 'approved', 'vocabulary', 'correct'),
        reading: answersFor(loader, 'approved', 'reading', 'correct'),
      },
    });
    await createSubmission(cohort.id, {
      status: 'submitted',
      contentVersion: 'v1',
      answers: {
        grammar: answersFor(loader, 'v1', 'grammar', 'correct'),
        vocabulary: answersFor(loader, 'v1', 'vocabulary', 'correct'),
        reading: answersFor(loader, 'v1', 'reading', 'correct'),
      },
    });

    const payload = await fixtureDashboard(fixtureService, cohort.id);

    // Counting only the approved version would draw a per-level comparison across a question set
    // half of which the team has not confirmed — the mixed-set version of the same misleading
    // comparison.
    expect(payload.difficulty).toEqual({ available: false, reason: 'content_not_approved' });
  });

  it('leaves drafts and unanswerable sections out of the per-level counts', async () => {
    const cohort = await createCohort();

    const { loader, service: fixtureService } = fixtureContent('approved', approveQuestionFiles);

    await createSubmission(cohort.id, { status: 'draft' });
    await createSubmission(cohort.id, {
      status: 'submitted',
      contentVersion: 'approved',
      // Nothing answered: every question still counts as a response, because an unanswered question
      // is part of what the section was out of, and scoring already reports it as incorrect.
      answers: {},
    });

    const payload = await fixtureDashboard(fixtureService, cohort.id);

    expect(payload.difficulty.available).toBe(true);
    if (!payload.difficulty.available) throw new Error('unreachable');

    // 26 questions across the three sections (9 + 9 + 8), all of them incorrect — and the draft
    // contributes none of them.
    const total = payload.difficulty.levels.reduce((sum, level) => sum + level.responses, 0);
    expect(total).toBe(26);
    expect(payload.difficulty.levels.every((level) => level.correct === 0)).toBe(true);
    expect(loader.getContent('approved').grammar.questions).toHaveLength(9);
  });
});
