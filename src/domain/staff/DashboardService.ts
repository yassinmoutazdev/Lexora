import { getContentLoader, type ContentLoader, type ContentBundle } from '../../content/ContentLoader.ts';
import type { Difficulty, Question } from '../../content/contentSchemas.ts';
import {
  scoreDeterministicSections,
  sectionMaxScores,
} from '../scoring/DeterministicScoringService.ts';
import type { DeterministicSectionKey, SubmissionStatus } from '../../shared/types/sections.ts';
import type { DraftAnswers } from '../../shared/types/draft.ts';
import { dashboardRepository, type DashboardRepository, type DashboardFilter } from '../../data/DashboardRepository.ts';

/**
 * The staff dashboard's aggregate queries (ARCHITECTURE Section 18 — canonical location for
 * "Dashboard/aggregate queries"; PRD Section 9.7).
 *
 * ## What this file decides, and what it does not
 *
 * It decides the things that are *rules* rather than *queries*: what "completion" means
 * (FR-STAFF-004), which score bands a distribution is drawn over (FR-STAFF-005), how the four
 * sections are put on one comparable axis (FR-STAFF-006), which Student Problems responses are
 * being counted and how the AI-derived ones are kept distinct from them (FR-STAFF-008,
 * FR-PROB-011), and whether the difficulty comparison is meaningful enough to show at all
 * (FR-STAFF-007, T8.1.2).
 *
 * The `GROUP BY` itself lives in `src/data/DashboardRepository.ts` — Section 18's "Database access"
 * row — exactly as `SubmissionService`'s rules sit above `SubmissionRepository`'s queries.
 *
 * ## Everything here is computed at request time (Section 14)
 *
 * No snapshot table, no cache, nothing carried between calls. Section 14 is explicit: *"computed
 * on-demand with plain SQL `GROUP BY`/`AVG`/`COUNT` queries at request time — no precomputed
 * materialized views or caching layer"*, because at a few hundred rows these queries return in
 * milliseconds and a cache would be complexity solving a problem that does not exist at this scale.
 *
 * ## Content is resolved per submission version, never "current" (Section 12)
 *
 * Three of the numbers below cannot be stated without content: a section's maximum (and therefore
 * its percentage), the wording of a Student Problems statement, and a question's difficulty level.
 * A submission's `contentVersion` is frozen at draft creation, so every lookup here goes through
 * `ContentLoader.getContent(version)` for the version the *row* carries — and when rows under two
 * versions appear together they are kept apart rather than averaged into one figure that describes
 * neither.
 */

/** What the dashboard is asked for. Absent `cohortId` means every cohort (FR-STAFF-009). */
export type DashboardRequest = DashboardFilter;

/** One difficulty level's result across the compared sections (FR-STAFF-007). */
export type DifficultyAggregate = {
  difficulty: Difficulty;
  /** Question-responses at this level that the cohort gave — answered questions, not students. */
  responses: number;
  correct: number;
  accuracyPercent: number;
};

/**
 * Why the difficulty comparison is not being shown.
 *
 * A code rather than a sentence, so a page owns its own wording (PRD Section 23.1 item 5 leaves
 * staff-facing copy provisional) and so a test can assert the *reason* rather than match prose.
 */
export type DifficultyOmission =
  /** The question set is not final, so its difficulty design is not either. */
  | 'content_not_approved'
  /** A level is represented by too few questions for a difference between levels to mean anything. */
  | 'levels_under_represented';

/**
 * The difficulty comparison, which FR-STAFF-007 makes a **conditional capability**.
 *
 * FR-STAFF-007: the dashboard *"should support comparison across Basic, Intermediate, and
 * Upper-intermediate difficulty levels **where the underlying question metadata, section structure,
 * and distribution of questions make the comparison meaningful**. This is a conditional capability,
 * not an unconditional requirement — the system must not present a misleading comparison when the
 * available metadata or question distribution is insufficient."*
 *
 * So `available: false` is a **successful** outcome, not a failure: the capability is built,
 * tested, and switched off until the content underneath it can carry it. That is why the reason is
 * part of the payload rather than a `null` — a screen that silently omitted a section a staff
 * member expected would be indistinguishable from one that had nothing to show.
 */
export type DifficultyComparison =
  | { available: true; levels: DifficultyAggregate[]; questionsPerLevel: Record<string, number> }
  | { available: false; reason: DifficultyOmission };

/**
 * One skill/topic's accuracy across the cohort — the "weakest topics" panel.
 *
 * FR-DET-002 requires every Grammar/Vocabulary/Reading question to carry a `skill` label
 * ("used for staff analysis", per `contentSchemas.ts`), and until now nothing read it: not scoring,
 * not the student report, not this dashboard. This is that reading. It reuses the exact per-question
 * outcomes `buildDifficulty` already recomputes from `difficultyInputs` — grouped by `skill` instead
 * of `difficulty` — so it costs no extra query.
 *
 * ## Why this is *not* gated the way the difficulty comparison is
 *
 * `buildDifficulty` refuses to render at all while the question set is `provisional`, because a
 * per-*level* breakdown of a development set is a claim about calibration — "Basic is calibrated
 * easier than Intermediate" — that a dev set has not earned. A per-*topic* accuracy is a different
 * kind of claim: "the cohort keeps missing this specific, currently-deployed question about relative
 * clauses", which is simply true of the content actually given, provisional or not. It is the same
 * fact the student report already states, ungated, for every individual question. So this panel is
 * gated only on `MIN_RESPONSES_PER_TOPIC` — a sample-size floor — not on content approval.
 */
export type TopicAggregate = {
  skill: string;
  section: DeterministicSectionKey;
  sectionTitle: string;
  /** Responses to this skill's question(s), not students — see `DifficultyAggregate.responses`. */
  responses: number;
  correct: number;
  accuracyPercent: number;
};

/** One writing rubric criterion's mean score across evaluated submissions. */
export type WritingCriterionAggregate = {
  key: string;
  /** The rubric's own label for this criterion (`writing-rubric.json`), never invented here. */
  label: string;
  meanScore: number;
  /** How many evaluated writing responses contributed — the denominator `meanScore` is drawn from. */
  responses: number;
};

/** A cohort as the filter control and the applied-filter heading need it. */
export type CohortSummary = {
  id: string;
  code: string;
  name: string;
};

/** One bar of a score distribution. */
export type ScoreBand = {
  /** The band's own label, e.g. `70–79%`. */
  label: string;
  count: number;
};

/** How one section's scores are spread, on the one axis every section shares. */
export type SectionAggregate = {
  section: string;
  /** The content bundle's own section title, so a heading cannot contradict the section. */
  title: string;
  /** How many submitted submissions carry a score for this section. */
  scoredSubmissions: number;
  /**
   * The section's mean as a percentage of its own maximum — the axis FR-STAFF-006 compares on.
   *
   * A percentage rather than a raw mean because the four sections are not out of the same total:
   * under v1 content Grammar and Vocabulary are out of 9 points, Reading out of 8, and Writing out
   * of 100 (FR-WRITE-009). A raw mean across those would rank a section by how many points it
   * happened to be worth.
   */
  meanPercent: number;
  /**
   * The raw mean and the maximum it was out of, or null when more than one content version
   * contributed.
   *
   * Reported because "average 6.4 out of 9" is what a member of staff actually reads, and null
   * rather than a number when versions are mixed because two versions' maxima are different
   * denominators — one raw average across them would be an average of two incomparable units, and
   * `meanPercent` is already the version-safe figure.
   */
  meanScore: number | null;
  maxScore: number | null;
  distribution: ScoreBand[];
};

/** The overall figure, over the sections every submitted submission is guaranteed to have. */
export type OverallAggregate = {
  scoredSubmissions: number;
  meanPercent: number;
  distribution: ScoreBand[];
  /**
   * The sections it is computed from.
   *
   * Carried in the payload rather than left to the page, because "overall" is not a stored column
   * and a reader is entitled to know it is Grammar + Vocabulary + Reading and not something else.
   * Writing is deliberately **not** part of it: it is a different measurement (rubric-based
   * evaluation on a 0–100 scale, FR-WRITE-009) and folding it in would require a weight between it
   * and the deterministic sections, which PRD Section 23.1 item 1 leaves TBD. The four sections are
   * compared *side by side* instead, which is what FR-STAFF-006 asks for.
   */
  includes: DeterministicSectionKey[];
};

/** One statement's responses, as the cohort answered it (FR-STAFF-008). */
export type StatementAggregate = {
  contentVersion: string;
  statementId: string;
  statement: string;
  area: string;
  areaLabel: string;
  /** How many students answered this statement. */
  responses: number;
  mean: number;
  /** The scale points, in the order the content lists them, with the counts this cohort gave. */
  counts: { value: number; label: string; count: number }[];
  /** The single most-given response, or null when no one answered the statement. */
  mostCommon: { value: number; label: string; count: number } | null;
};

/**
 * An AI-derived category and how often it came up.
 *
 * The type name carries "derived" for the reason FR-PROB-011 gives: *"AI-generated interpretations
 * and categories must be clearly labeled as derived data — not presented as the student's original
 * words or as guaranteed fact."* A field named `categories` sitting beside `statements` would be
 * presented as one list of findings about the cohort; this one cannot be read that way, and the
 * page labels it accordingly.
 */
export type DerivedCategoryAggregate = {
  label: string;
  count: number;
};

/**
 * One submission as the dashboard's list shows it (FR-STAFF-010, T8.2.3).
 *
 * Deliberately not the whole record: this is a *way in* to the individual-submission page, and a
 * list that carried scores or Student Problems data would be the dashboard trying to be the detail
 * view. The id is included because the page is addressed by it, and because the CSV export uses the
 * same id — so a staff member can move between the two.
 */
export type DashboardSubmissionSummary = {
  id: string;
  /** As the student typed it, preserved for display (Section 6). */
  rollNumber: string;
  studentName: string;
  status: SubmissionStatus;
  /** ISO 8601, or null for a submission that has not been submitted. */
  submittedAt: string | null;
};

export type DashboardPayload = {
  /** The cohort the figures cover, or null for all cohorts. */
  cohort: CohortSummary | null;
  /** Every cohort, for the filter control (FR-STAFF-009). */
  cohorts: CohortSummary[];
  counts: {
    submissions: number;
    draft: number;
    submitted: number;
    /**
     * Of the submitted submissions, how far background evaluation has got.
     *
     * Both tallies cover submitted rows only. A draft's `writingStatus` is `not_applicable`
     * (Section 6), and counting those here would report hundreds of "not applicable" submissions
     * beside a handful of real ones.
     */
    writing: Record<string, number>;
    problemsText: Record<string, number>;
  };
  overall: OverallAggregate;
  /** Grammar, Vocabulary, Reading, and Writing, in that order (FR-STAFF-006). */
  sections: SectionAggregate[];
  problems: {
    /** The students' own five-point responses, per statement. */
    statements: StatementAggregate[];
    /** The AI's categories, kept separate from the line above (FR-PROB-011). */
    derivedCategories: DerivedCategoryAggregate[];
    /** How many open-text responses have a finished analysis — the denominator for the above. */
    analysedResponses: number;
  };
  /** The conditional difficulty-level comparison (FR-STAFF-007). */
  difficulty: DifficultyComparison;
  /** The lowest-scoring skills/topics cohort-wide, worst first (see `TopicAggregate`). Capped at `WEAKEST_TOPICS_LIMIT`, and topics under `MIN_RESPONSES_PER_TOPIC` responses are left out rather than shown thin. */
  weakestTopics: TopicAggregate[];
  /** Mean score per writing rubric criterion across evaluated submissions, in the rubric's own order. */
  writingCriteria: WritingCriterionAggregate[];
  /**
   * The most recent submissions, newest first, as links into the individual-submission view
   * (FR-STAFF-010, T8.2.3).
   *
   * ## Why it is part of this payload rather than its own endpoint
   *
   * ARCHITECTURE Section 10 fixes the API surface at ten endpoints and gives this one as *"aggregate
   * metrics, filterable by cohort"*. Adding `/api/staff/submissions` for the list would be an
   * eleventh endpoint the architecture does not define, and Section 10's table is not advisory —
   * it is the contract. The list is what the dashboard needs to make FR-STAFF-010 reachable, so it
   * is part of the dashboard's answer, filtered the same way and fetched at the same time.
   *
   * Capped at `RECENT_SUBMISSIONS_LIMIT`. The complete dataset is the CSV export's job (PRD G5);
   * this is a navigation aid, not a second listing of the cohort.
   */
  recentSubmissions: DashboardSubmissionSummary[];
};

/**
 * What a dashboard request resolved to.
 *
 * A discriminated union rather than a payload or a throw, because a filter naming a cohort that
 * does not exist is a *request* problem with a different remedy from a database failure: the route
 * answers it with a 404 and the page clears the filter. Returning an empty payload instead would
 * be the worst of the options — a screen headed with a cohort that has no data under a table of
 * zeroes looks exactly like a cohort that has no data.
 */
export type DashboardResult =
  | { outcome: 'ok'; payload: DashboardPayload }
  | { outcome: 'unknown_cohort' };

/**
 * The percentage bands every section's distribution is drawn over.
 *
 * A presentation choice, and deliberately the only one this file invents. FR-STAFF-005 requires a
 * *distribution*, and a distribution needs buckets; FR-STAFF-006 requires the four sections to be
 * comparable, and they are only comparable as percentages of their own maxima. Six bands is what
 * keeps the dashboard simple (FR-STAFF-012) while still showing a shape. No score, weighting, or
 * threshold in the product depends on where these edges fall.
 *
 * Half-open [min, max), with the last band open-ended so a score of exactly 100% lands in it rather
 * than falling off the end.
 */
const SCORE_BANDS: { label: string; minPercent: number; maxPercent: number }[] = [
  { label: '0–49%', minPercent: 0, maxPercent: 50 },
  { label: '50–59%', minPercent: 50, maxPercent: 60 },
  { label: '60–69%', minPercent: 60, maxPercent: 70 },
  { label: '70–79%', minPercent: 70, maxPercent: 80 },
  { label: '80–89%', minPercent: 80, maxPercent: 90 },
  { label: '90–100%', minPercent: 90, maxPercent: Number.POSITIVE_INFINITY },
];

/** The four sections the dashboard compares, in the order FR-STAFF-006 lists them. */
const COMPARED_SECTIONS = ['grammar', 'vocabulary', 'reading', 'writing'] as const;

/** The sections the overall figure is computed from — see `OverallAggregate.includes`. */
const OVERALL_SECTIONS: DeterministicSectionKey[] = ['grammar', 'vocabulary', 'reading'];

/** The processing statuses a tally is reported over, zero-filled so a page need not handle absence. */
const PROCESSING_STATUSES = [
  'not_applicable',
  'pending',
  'processing',
  'succeeded',
  'failed_needs_review',
] as const;

/**
 * How many questions each difficulty level must carry, across the compared sections, before the
 * difficulty comparison is shown (FR-STAFF-007).
 *
 * FR-STAFF-007 leaves "meaningful" to be decided here — *"where the underlying question metadata,
 * section structure, and distribution of questions make the comparison meaningful"* — and PRD
 * Section 23.1 item 7 records the capability's feasibility as still open. This constant is that
 * decision, and it is deliberately in the service rather than in the page: a rule the UI applies is
 * a rule each new view has to remember.
 *
 * **Three**, because below it a level's accuracy is a statement about the questions rather than
 * about the cohort. With two questions a level can only score 0%, 50%, or 100% for any one student,
 * so a single question's wording drives half of that level's result and the comparison would move
 * whenever the team swapped a question — which is exactly the "misleading comparison" the
 * requirement forbids. Three is the smallest count at which no one question is decisive.
 *
 * This is a floor on the *question set*, not on the cohort: with three questions a level, a cohort
 * of thirty gives ninety responses, which is a perfectly ordinary measurement. The gate exists
 * because a thin question set is misleading regardless of how many students answered it, which is
 * why it is checked against content and not against row counts.
 */
const MIN_QUESTIONS_PER_LEVEL = 3;

/**
 * How many responses a topic needs before its accuracy is reported in the weakest-topics panel.
 *
 * Not a question-count floor like `MIN_QUESTIONS_PER_LEVEL` — it can't be one. Every skill label in
 * the current content is carried by exactly one question (see the grammar/vocabulary/reading question
 * files), so a floor on *questions per skill* would always evaluate to one and gate nothing. What
 * makes one skill's accuracy meaningful is enough *students* having answered that question, which is
 * a floor on responses instead. Five is the same order of magnitude as `MIN_QUESTIONS_PER_LEVEL`'s
 * reasoning: below it, one or two students' luck decides the whole figure.
 */
const MIN_RESPONSES_PER_TOPIC = 5;

/**
 * How many topics the weakest-topics panel shows.
 *
 * Same reasoning as `RECENT_SUBMISSIONS_LIMIT`: the panel exists to point staff at where curriculum
 * time is best spent, not to restate every skill's accuracy — a ranked list longer than the worst
 * handful stops being "look here first" and starts being the per-question data the report and the
 * CSV export already carry in full (FR-STAFF-012).
 */
const WEAKEST_TOPICS_LIMIT = 5;

/**
 * The sections the difficulty comparison covers, and why it is not all five.
 *
 * FR-STAFF-007's "section structure" clause. Only Grammar, Vocabulary, and Reading carry questions
 * with a difficulty level (FR-DET-002's metadata); Writing is one open-ended task and Student
 * Problems is a set of statements, so neither has levels to compare and including them would mean
 * inventing one. These are the same three sections `DeterministicScoringService` scores — a
 * comparison can only be drawn from per-question outcomes, and those three are the sections that
 * have them.
 */
const DIFFICULTY_SECTIONS: DeterministicSectionKey[] = ['grammar', 'vocabulary', 'reading'];

/**
 * The three levels, in the order PRD Section 10 lists them — easiest first.
 *
 * Spelled out rather than taken from `difficultySchema`'s inferred order, so a level added to the
 * content vocabulary appears here as a compile error rather than silently never being reported.
 */
const DIFFICULTY_LEVELS: Difficulty[] = ['basic', 'intermediate', 'upper-intermediate'];

/**
 * How many submissions the dashboard lists (T8.2.3).
 *
 * Twenty-five is roughly a screenful of rows, which is the point: the list exists to give staff a
 * way into an individual submission (FR-STAFF-010), and a list longer than a screen stops being
 * something you scan and becomes something you search — at which point the CSV export, which has
 * every row and every column, is the right tool (PRD G5, FR-STAFF-012).
 */
const RECENT_SUBMISSIONS_LIMIT = 25;

export type DashboardServiceDeps = {
  dashboard: DashboardRepository;
  content: ContentLoader;
};

export class DashboardService {
  private readonly deps: DashboardServiceDeps;

  constructor(deps: DashboardServiceDeps) {
    this.deps = deps;
  }

  /**
   * Builds the dashboard payload for one filter.
   *
   * The four aggregate queries are issued together rather than in sequence: they are independent
   * reads of the same tables, and awaiting them one at a time would take four round trips to answer
   * a question the database can be asked in one pass.
   */
  async getDashboard(request: DashboardRequest = {}): Promise<DashboardResult> {
    const filter: DashboardFilter =
      request.cohortId === undefined ? {} : { cohortId: request.cohortId };

    const cohort =
      filter.cohortId === undefined ? null : await this.deps.dashboard.findCohortById(filter.cohortId);

    // Refused before any aggregate runs: there is no honest payload for a cohort that does not
    // exist, and running the queries anyway would be four scans to build one.
    if (filter.cohortId !== undefined && cohort === null) return { outcome: 'unknown_cohort' };

    const [
      cohorts,
      processingRows,
      scoreRows,
      likertRows,
      derivedRows,
      difficultyRows,
      writingCriteriaRows,
      recentRows,
    ] = await Promise.all([
      this.deps.dashboard.listCohorts(),
      this.deps.dashboard.countByStatusAndProcessing(filter),
      this.deps.dashboard.scoreDistribution(filter),
      this.deps.dashboard.likertResponseCounts(filter),
      this.deps.dashboard.derivedCategoryCounts(filter),
      this.deps.dashboard.difficultyInputs(filter),
      this.deps.dashboard.writingCriteriaScores(filter),
      this.deps.dashboard.recentSubmissions(filter, RECENT_SUBMISSIONS_LIMIT),
    ]);

    return {
      outcome: 'ok',
      payload: {
        cohort: cohort === null ? null : toCohortSummary(cohort),
        cohorts: cohorts.map(toCohortSummary),
        counts: tallyCounts(processingRows),
        overall: this.buildOverall(scoreRows),
        sections: COMPARED_SECTIONS.map((section) => this.buildSection(section, scoreRows)),
        problems: {
          statements: this.buildStatements(likertRows),
          derivedCategories: derivedRows.map((row) => ({ label: row.label, count: row.count })),
          analysedResponses: countAnalysedResponses(processingRows),
        },
        difficulty: this.buildDifficulty(difficultyRows),
        weakestTopics: this.buildWeakestTopics(difficultyRows),
        writingCriteria: this.buildWritingCriteria(writingCriteriaRows),
        recentSubmissions: recentRows.map((row) => ({
          id: row.id,
          rollNumber: row.rollNumberRaw,
          studentName: row.studentName,
          status: row.status as SubmissionStatus,
          submittedAt: row.submittedAt?.toISOString() ?? null,
        })),
      },
    };
  }

  /**
   * One section's distribution, on the shared percentage axis.
   *
   * The rows are grouped by score *and* content version, so this walks them version by version and
   * resolves that version's maximum before turning a raw score into a percentage. That is the whole
   * reason `contentVersion` is a grouping key in the query: a percentage computed against the wrong
   * version's maximum would be a plausible-looking number with nothing behind it.
   *
   * `meanScore`/`maxScore` are reported only when a single version contributed — see
   * `SectionAggregate`.
   */
  private buildSection(section: string, rows: ScoreRowForSection[]): SectionAggregate {
    const counts = new Map<string, number>();
    let scored = 0;
    let percentTotal = 0;
    let rawTotal = 0;

    const versions = new Set<string>();
    // The maximum of each contributing version, so "did they all agree" can be answered below.
    const maxima = new Set<number>();

    for (const row of rows) {
      const score = scoreOf(section, row);
      if (score === null) continue;

      const content = this.deps.content.getContent(row.contentVersion);
      const maxScore = maxScoreOf(section, content);

      versions.add(row.contentVersion);
      maxima.add(maxScore);

      const percent = maxScore === 0 ? 0 : (score / maxScore) * 100;

      scored += row.count;
      percentTotal += percent * row.count;
      rawTotal += score * row.count;

      const band = bandLabel(percent);
      counts.set(band, (counts.get(band) ?? 0) + row.count);
    }

    const singleVersion = versions.size === 1;

    return {
      section,
      title: this.sectionTitle(section, versions),
      scoredSubmissions: scored,
      meanPercent: scored === 0 ? 0 : round(percentTotal / scored),
      meanScore: singleVersion && scored > 0 ? round(rawTotal / scored) : null,
      maxScore: singleVersion ? ([...maxima][0] ?? null) : null,
      distribution: bandCounts(counts),
    };
  }

  /**
   * The overall figure — the three deterministic sections combined, per submission.
   *
   * Computed row by row rather than by summing the section figures: a submission's overall is one
   * student's total across three sections, and an average of three section averages is a different
   * (and wrong) number whenever the sections have different numbers of missing scores.
   *
   * A row contributes only when all three scores are present. Under v1 content every submitted
   * submission has all three — `finalize` refuses an incomplete assessment — so this is a
   * completeness guard rather than a filter that normally excludes anything, and it keeps a
   * half-scored legacy row from being averaged in as if it were a whole one.
   */
  private buildOverall(rows: ScoreRowForSection[]): OverallAggregate {
    const counts = new Map<string, number>();
    let scored = 0;
    let percentTotal = 0;

    for (const row of rows) {
      const scores = OVERALL_SECTIONS.map((section) => scoreOf(section, row));
      if (scores.some((score) => score === null)) continue;

      const content = this.deps.content.getContent(row.contentVersion);
      const maxima = sectionMaxScores(content);

      const earned = OVERALL_SECTIONS.reduce((total, section, index) => total + scores[index]!, 0);
      const possible = OVERALL_SECTIONS.reduce((total, section) => total + maxima[section], 0);

      const percent = possible === 0 ? 0 : (earned / possible) * 100;

      scored += row.count;
      percentTotal += percent * row.count;

      const band = bandLabel(percent);
      counts.set(band, (counts.get(band) ?? 0) + row.count);
    }

    return {
      scoredSubmissions: scored,
      meanPercent: scored === 0 ? 0 : round(percentTotal / scored),
      distribution: bandCounts(counts),
      includes: OVERALL_SECTIONS,
    };
  }

  /**
   * The five-point responses, rolled up per statement (FR-STAFF-008).
   *
   * Statements are emitted in the content bundle's own order, not by count: the order is the
   * instrument's design (FR-PROB-001 groups statements into areas), and a list that reordered
   * itself by popularity would make two visits to the dashboard show two different questionnaires.
   *
   * Rows are grouped by `(contentVersion, statementId)` because the statement *text* comes from the
   * version the student answered under (Section 12). A statement dropped or reworded in a later
   * version therefore reports as two entries rather than as one whose wording is neither version's.
   */
  private buildStatements(rows: LikertRowForStatement[]): StatementAggregate[] {
    const byStatement = new Map<string, { row: LikertRowForStatement; counts: Map<number, number> }>();

    for (const row of rows) {
      const key = `${row.contentVersion}\u0000${row.statementId}`;
      const held = byStatement.get(key) ?? { row, counts: new Map<number, number>() };

      held.counts.set(row.value, (held.counts.get(row.value) ?? 0) + row.count);
      byStatement.set(key, held);
    }

    const aggregates: StatementAggregate[] = [];
    const order = new Map<string, number>();

    for (const [key, held] of byStatement) {
      const content = this.deps.content.getContent(held.row.contentVersion);
      const statement = content.studentProblems.statements.find(
        (candidate) => candidate.id === held.row.statementId,
      );

      // A statement id with no entry in the version it was answered under means the row and the
      // bundle disagree about what the student was asked. Skipping keeps a wording-less row out of
      // the aggregate; there is no text that could be shown for it that would be true.
      if (!statement) continue;

      const area = content.studentProblems.areas.find((candidate) => candidate.id === statement.area);

      const scale = [...content.studentProblems.scale].sort((a, b) => a.value - b.value);
      const counts = scale.map((point) => ({
        value: point.value,
        label: point.label,
        count: held.counts.get(point.value) ?? 0,
      }));

      const responses = counts.reduce((total, count) => total + count.count, 0);
      const total = counts.reduce((sum, count) => sum + count.value * count.count, 0);

      let mostCommon: StatementAggregate['mostCommon'] = null;
      for (const count of counts) {
        // `>` rather than `>=`: on a tie the lower scale point wins, which is a fixed rule rather
        // than whichever order the query happened to return.
        if (count.count > 0 && (mostCommon === null || count.count > mostCommon.count)) {
          mostCommon = { value: count.value, label: count.label, count: count.count };
        }
      }

      order.set(key, statementOrder(content, statement.id));
      aggregates.push({
        contentVersion: held.row.contentVersion,
        statementId: statement.id,
        statement: statement.text,
        area: statement.area,
        // The area's label if the bundle knows it; the raw id if it does not, so a missing label
        // shows as a missing label rather than as no area at all.
        areaLabel: area?.label ?? statement.area,
        responses,
        mean: responses === 0 ? 0 : round(total / responses),
        counts,
        mostCommon,
      });
    }

    const sorted = aggregates.sort((a, b) => {
      const byVersion = a.contentVersion.localeCompare(b.contentVersion);
      if (byVersion !== 0) return byVersion;

      return (
        (order.get(`${a.contentVersion}\u0000${a.statementId}`) ?? 0) -
        (order.get(`${b.contentVersion}\u0000${b.statementId}`) ?? 0)
      );
    });

    return sorted;
  }

  /**
   * The conditional difficulty-level comparison (FR-STAFF-007, T8.1.2).
   *
   * ## The two gates, and why each is one
   *
   * **1. The question set must be final.** PRD Section 23.1 item 7 records the feasibility of this
   * comparison as *"conditional on final question metadata and distribution design"*, and every file
   * in `content/versions/v1` is marked `contentStatus: "provisional"` — a development set awaiting
   * the team's final questions and difficulty distribution (Section 23.1 item 3). A per-level
   * breakdown of a provisional set is a finding about which development questions were written, not
   * about the cohort's ability, and presenting it as the latter is precisely the misleading
   * comparison FR-STAFF-007 forbids. The gate lifts by itself the day the team approves the content:
   * nothing here needs changing, which is what makes this a conditional capability rather than an
   * unbuilt one.
   *
   * **2. No level may be thinly represented.** Checked against the content's own question counts,
   * not against row counts — see `MIN_QUESTIONS_PER_LEVEL` for why three, and why a large cohort
   * does not cure a thin question set.
   *
   * The gates are checked in that order so the reported reason is the one the team can act on. With
   * provisional content, "the content is not approved" is the blocker; reporting a distribution
   * complaint about a set that is going to be rewritten would send someone to fix the wrong thing.
   *
   * ## Why it re-scores instead of reading the stored columns
   *
   * The stored `grammarScore`/`vocabularyScore`/`readingScore` are section *totals*. A per-difficulty
   * breakdown needs per-question outcomes, and the only honest source for those is the same
   * `DeterministicScoringService` the student report uses, applied to the answers this submission
   * actually holds against the content version it was taken under. Scoring is a pure function
   * (Section 7), so this is a recomputation and not a second opinion: for any row whose stored total
   * was produced by this system, the two agree by construction.
   */
  private buildDifficulty(rows: DifficultyInputRowLike[]): DifficultyComparison {
    // The versions the compared rows were taken under. A submission's `contentVersion` is frozen at
    // draft creation (Section 12), so a cohort that spans a content change is judged on both
    // versions' questions — and if either is unapproved, the comparison spans a provisional set.
    //
    // Falling back to the current version when nothing has been submitted keeps the gate answerable
    // on an empty dashboard: the reason the section is missing is the same reason it is missing on a
    // populated one, and a page should be able to say so before the first student submits.
    const versions =
      rows.length === 0
        ? [this.deps.content.getCurrentVersion()]
        : [...new Set(rows.map((row) => row.contentVersion))];

    const bundles = versions.map((version) => this.deps.content.getContent(version));

    if (bundles.some((bundle) => !isQuestionSetApproved(bundle))) {
      return { available: false, reason: 'content_not_approved' };
    }

    // Question counts per level, summed across the compared sections. A level's total is what the
    // accuracy below is drawn from, so a level short everywhere is short regardless of which
    // section it was short in.
    const questionsPerLevel = countQuestionsPerLevel(bundles);

    if (DIFFICULTY_LEVELS.some((level) => (questionsPerLevel[level] ?? 0) < MIN_QUESTIONS_PER_LEVEL)) {
      return { available: false, reason: 'levels_under_represented' };
    }

    const totals = new Map<Difficulty, { responses: number; correct: number }>(
      DIFFICULTY_LEVELS.map((level) => [level, { responses: 0, correct: 0 }]),
    );

    for (const row of rows) {
      const bundle = this.deps.content.getContent(row.contentVersion);
      const difficultyOf = difficultyByQuestionId(bundle);

      const scores = scoreDeterministicSections(toDraftAnswers(row), bundle);

      for (const section of DIFFICULTY_SECTIONS) {
        for (const outcome of scores[section].questions) {
          const level = difficultyOf.get(outcome.questionId);

          // A scored question with no difficulty in the bundle it was scored against cannot be
          // attributed to a level. `questionSchema` requires the field, so this is unreachable for
          // content that loaded; skipping rather than guessing keeps it from silently landing in
          // whichever level happened to be first.
          if (level === undefined) continue;

          const total = totals.get(level);
          if (total === undefined) continue;

          total.responses += 1;
          if (outcome.correct) total.correct += 1;
        }
      }
    }

    return {
      available: true,
      questionsPerLevel,
      levels: DIFFICULTY_LEVELS.map((level) => {
        const total = totals.get(level) ?? { responses: 0, correct: 0 };

        return {
          difficulty: level,
          responses: total.responses,
          correct: total.correct,
          accuracyPercent: total.responses === 0 ? 0 : round((total.correct / total.responses) * 100),
        };
      }),
    };
  }

  /**
   * The weakest-topics panel (see `TopicAggregate` for what it is and why it is gated differently
   * from the difficulty comparison).
   *
   * Reuses `rows` — the same `difficultyInputs` this call already fetched for `buildDifficulty` — and
   * the same per-question re-scoring, grouped by `skill` instead of `difficulty`. Two aggregates
   * built from one query and one scoring pass, rather than a second round trip for a second grouping
   * of the same underlying facts.
   */
  private buildWeakestTopics(rows: DifficultyInputRowLike[]): TopicAggregate[] {
    const totals = new Map<
      string,
      { skill: string; section: DeterministicSectionKey; sectionTitle: string; responses: number; correct: number }
    >();

    for (const row of rows) {
      const bundle = this.deps.content.getContent(row.contentVersion);
      const scores = scoreDeterministicSections(toDraftAnswers(row), bundle);

      for (const section of DIFFICULTY_SECTIONS) {
        const questionsById = new Map(
          (section === 'reading'
            ? bundle.reading.passages.flatMap((passage) => passage.questions)
            : bundle[section].questions
          ).map((question) => [question.id, question]),
        );

        for (const outcome of scores[section].questions) {
          const question = questionsById.get(outcome.questionId);

          // Unreachable for content that loaded (`questionSchema` requires `skill`), same as the
          // equivalent guard in `buildDifficulty` — kept explicit rather than assumed.
          if (question === undefined) continue;

          // Keyed by section + skill, not skill alone: two sections could coincidentally reuse a
          // label, and conflating "Word formation" in Vocabulary with a same-named Reading skill
          // would average two different things into one number.
          const key = `${section}:${question.skill}`;
          const total = totals.get(key) ?? {
            skill: question.skill,
            section,
            sectionTitle: bundle[section].title,
            responses: 0,
            correct: 0,
          };

          total.responses += 1;
          if (outcome.correct) total.correct += 1;
          totals.set(key, total);
        }
      }
    }

    return [...totals.values()]
      .filter((total) => total.responses >= MIN_RESPONSES_PER_TOPIC)
      .map((total) => ({
        skill: total.skill,
        section: total.section,
        sectionTitle: total.sectionTitle,
        responses: total.responses,
        correct: total.correct,
        accuracyPercent: round((total.correct / total.responses) * 100),
      }))
      // Worst first; more responses breaks a tie, since a thin-but-qualifying topic's accuracy is
      // the less certain of two equal figures.
      .sort((a, b) => a.accuracyPercent - b.accuracyPercent || b.responses - a.responses)
      .slice(0, WEAKEST_TOPICS_LIMIT);
  }

  /**
   * Writing's mean score per rubric criterion, across evaluated submissions.
   *
   * The section-level `sections` aggregate already reports Writing's overall mean; this is the
   * breakdown underneath it, using scores that are already computed and stored by
   * `WritingScoreCalculator` at evaluation time — no new model call, purely an average of numbers
   * that exist.
   */
  private buildWritingCriteria(rows: WritingCriteriaInputRowLike[]): WritingCriterionAggregate[] {
    // The rubric defines the criteria this breakdown has columns for; a row with no rubric to read
    // has nothing to report against, so an empty result (not zeroed criteria with invented labels)
    // is the honest answer with no submissions yet.
    const version = rows[0]?.contentVersion ?? this.deps.content.getCurrentVersion();
    const rubric = this.deps.content.getContent(version).writingRubric;

    const totals = new Map<string, { sum: number; responses: number }>(
      rubric.criteria.map((criterion) => [criterion.key, { sum: 0, responses: 0 }]),
    );

    for (const row of rows) {
      const scores = asCriteriaScores(row.criteriaScores);
      if (scores === undefined) continue;

      for (const [key, total] of totals) {
        const criterion = scores[key];
        if (criterion === undefined) continue;

        total.sum += criterion.score;
        total.responses += 1;
      }
    }

    return rubric.criteria.map((criterion) => {
      const total = totals.get(criterion.key) ?? { sum: 0, responses: 0 };

      return {
        key: criterion.key,
        label: criterion.label,
        meanScore: total.responses === 0 ? 0 : round(total.sum / total.responses),
        responses: total.responses,
      };
    });
  }

  /**
   * The content bundle's own title for a section, so a heading cannot contradict its section.
   */
  private sectionTitle(section: string, versions: Set<string>): string {
    // Any contributing version will do: a section's *title* is not one of the things a version
    // governs in a way that could differ, and the alternative — a title per version — would be a
    // heading a page cannot render. Falls back to the section key when nothing contributed, so an
    // empty dashboard still has headings.
    const version = [...versions][0] ?? this.deps.content.getCurrentVersion();
    const content = this.deps.content.getContent(version);

    if (section === 'grammar' || section === 'vocabulary' || section === 'reading') {
      return content[section].title;
    }

    return content.writingPrompt.title;
  }
}

/**
 * The row shape the section and overall builders read.
 *
 * Structural rather than importing `ScoreRow`, so this file depends on the fields it uses and not on
 * the repository's row type — the same reason `SubmissionRepository` declares `DraftAnswersLike`.
 */
type ScoreRowForSection = {
  contentVersion: string;
  grammarScore: number | null;
  vocabularyScore: number | null;
  readingScore: number | null;
  writingOverallScore: number | null;
  count: number;
};

/** The row shape the recent-submissions list reads. */
type RecentSubmissionRowLike = {
  id: string;
  rollNumberRaw: string;
  studentName: string;
  status: string;
  submittedAt: Date | null;
};

type LikertRowForStatement = {
  contentVersion: string;
  statementId: string;
  value: number;
  count: number;
};

/** The stored score for one section, or null when the submission has none. */
function scoreOf(section: string, row: ScoreRowForSection): number | null {
  if (section === 'grammar') return row.grammarScore;
  if (section === 'vocabulary') return row.vocabularyScore;
  if (section === 'reading') return row.readingScore;

  return row.writingOverallScore;
}

/**
 * One section's maximum, from the content it was taken under.
 *
 * Writing's comes from the rubric's own `scoreRange` (FR-WRITE-009's 0–100 scale) rather than the
 * literal 100, for the same reason the deterministic sections' maxima are summed from `points`
 * instead of being written down: a version that changed either would otherwise be divided by a
 * number it does not use.
 */
function maxScoreOf(
  section: string,
  content: ReturnType<ContentLoader['getContent']>,
): number {
  if (section === 'grammar' || section === 'vocabulary' || section === 'reading') {
    return sectionMaxScores(content)[section];
  }

  return content.writingRubric.scoreRange.max;
}

/** Which band a percentage falls in. */
function bandLabel(percent: number): string {
  const band = SCORE_BANDS.find((candidate) => percent < candidate.maxPercent);

  // The last band's `maxPercent` is infinite, so `find` cannot miss; the fallback is for a reader
  // who cannot see that and would otherwise have to reason about `undefined`.
  return (band ?? SCORE_BANDS[SCORE_BANDS.length - 1]!).label;
}

/** Every band, in order, with the counts collected for it — zero-filled so a page renders a shape. */
function bandCounts(counts: Map<string, number>): ScoreBand[] {
  return SCORE_BANDS.map((band) => ({ label: band.label, count: counts.get(band.label) ?? 0 }));
}

/** A statement's position in its bundle, so the instrument's own ordering is preserved. */
function statementOrder(content: ReturnType<ContentLoader['getContent']>, statementId: string): number {
  return content.studentProblems.statements.findIndex((statement) => statement.id === statementId);
}

/** Submission counts, split by lifecycle status and by background-processing status. */
function tallyCounts(rows: ProcessingCountRowLike[]): DashboardPayload['counts'] {
  const counts: DashboardPayload['counts'] = {
    submissions: 0,
    draft: 0,
    submitted: 0,
    writing: zeroedProcessingStatuses(),
    problemsText: zeroedProcessingStatuses(),
  };

  for (const row of rows) {
    counts.submissions += row.count;

    if (row.status === 'submitted') counts.submitted += row.count;
    else counts.draft += row.count;

    // Background state is only meaningful for a submitted row — a draft's columns are
    // `not_applicable` because nothing has been enqueued, not because anything was decided.
    if (row.status !== 'submitted') continue;

    counts.writing[row.writingStatus] = (counts.writing[row.writingStatus] ?? 0) + row.count;
    counts.problemsText[row.problemsTextStatus] =
      (counts.problemsText[row.problemsTextStatus] ?? 0) + row.count;
  }

  return counts;
}

/** How many Student Problems responses produced a finished analysis — the derived figures' base. */
function countAnalysedResponses(rows: ProcessingCountRowLike[]): number {
  return rows
    .filter((row) => row.status === 'submitted' && row.problemsTextStatus === 'succeeded')
    .reduce((total, row) => total + row.count, 0);
}

function zeroedProcessingStatuses(): Record<string, number> {
  return Object.fromEntries(PROCESSING_STATUSES.map((status) => [status, 0]));
}

type ProcessingCountRowLike = {
  status: string;
  writingStatus: string;
  problemsTextStatus: string;
  count: number;
};

/** The answers the difficulty comparison scores, as the repository returns them. */
type DifficultyInputRowLike = {
  contentVersion: string;
  grammar: unknown;
  vocabulary: unknown;
  reading: unknown;
};

/** The row shape `buildWritingCriteria` reads. */
type WritingCriteriaInputRowLike = {
  contentVersion: string;
  criteriaScores: unknown;
};

/**
 * Whether the question set behind a bundle is final (FR-STAFF-007's first gate).
 *
 * Only the three compared sections. Writing and Student Problems are not part of the difficulty
 * comparison — they have no difficulty levels to compare — so a provisional writing prompt or
 * statement set says nothing about whether *this* comparison can be drawn, and gating on them would
 * hold the question-set comparison hostage to content it does not read.
 */
function isQuestionSetApproved(bundle: ContentBundle): boolean {
  return DIFFICULTY_SECTIONS.every((section) => bundle[section].contentStatus === 'approved');
}

/** How many questions each level carries, summed over the compared sections of every bundle. */
function countQuestionsPerLevel(bundles: ContentBundle[]): Record<string, number> {
  const counts: Record<string, number> = Object.fromEntries(
    DIFFICULTY_LEVELS.map((level) => [level, 0]),
  );

  for (const bundle of bundles) {
    for (const question of comparedSectionQuestions(bundle)) {
      counts[question.difficulty] = (counts[question.difficulty] ?? 0) + 1;
    }
  }

  return counts;
}

/**
 * Every question in the compared sections, Reading's included.
 *
 * Reading nests its questions under passages, so this flattens — the same "every question in a
 * section" rule `DeterministicScoringService.questionsOf` applies, and it is restated here only
 * because that one is private to the scoring module and returns questions per section rather than
 * across the three. Both read the same content shape, which is what `readingFileSchema` fixes.
 */
function comparedSectionQuestions(bundle: ContentBundle): Question[] {
  return DIFFICULTY_SECTIONS.flatMap((section) =>
    section === 'reading'
      ? bundle.reading.passages.flatMap((passage) => passage.questions)
      : bundle[section].questions,
  );
}

/** Question id → its difficulty, for attributing a scored outcome to a level. */
function difficultyByQuestionId(bundle: ContentBundle): Map<string, Difficulty> {
  return new Map(
    comparedSectionQuestions(bundle).map((question) => [question.id, question.difficulty]),
  );
}

/**
 * The submissions' answers, as the scorer reads them.
 *
 * A single-justification cast, of the same kind `toDraftAnswers` makes in `src/api/student.routes.ts`
 * and for the same reason: every write to `answers` passes through `draftAutosaveBodySchema`, which
 * checks the section key and the answers' shape **together**, so a value stored under `grammar` is a
 * `ChoiceAnswers` by construction. This query reaches around that validation by reading the column
 * directly, so the assumption is restated here rather than left implicit — and scoring is indifferent
 * to it either way, since an answer that is not a string simply scores as unanswered.
 */
function toDraftAnswers(row: DifficultyInputRowLike): DraftAnswers {
  return {
    grammar: asChoiceAnswers(row.grammar),
    vocabulary: asChoiceAnswers(row.vocabulary),
    reading: asChoiceAnswers(row.reading),
  };
}

/** One stored section's answers, or undefined when the column held something else. */
function asChoiceAnswers(value: unknown): Record<string, string> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;

  return value as Record<string, string>;
}

/**
 * `writingCriteriaScores` as stored, or undefined when the column held something else.
 *
 * A row that reaches `buildWritingCriteria` already satisfies `writingStatus = 'succeeded' AND
 * writingCriteriaScores IS NOT NULL` (the repository's `WHERE` clause), so `undefined` here is not
 * an expected outcome — it is the same defence-in-depth `asChoiceAnswers` applies: the column's type
 * is `Json?`, which nothing at the database layer stops from holding a string or an array, so a
 * degenerate value is skipped rather than trusted.
 */
function asCriteriaScores(value: unknown): Record<string, { score: number }> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;

  return value as Record<string, { score: number }>;
}

function toCohortSummary(cohort: { id: string; code: string; name: string }): CohortSummary {
  return { id: cohort.id, code: cohort.code, name: cohort.name };
}

/** Two decimal places — enough to distinguish cohorts, few enough to read. */
function round(value: number): number {
  return Math.round(value * 100) / 100;
}

let instance: DashboardService | undefined;

/** The process-wide service, wired to the shared repository and content loader. */
export function getDashboardService(): DashboardService {
  instance ??= new DashboardService({
    dashboard: dashboardRepository,
    content: getContentLoader(),
  });

  return instance;
}
