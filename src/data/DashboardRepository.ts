import { Prisma } from '@prisma/client';
import type { Cohort } from '@prisma/client';
import { getPrismaClient } from './prismaClient.ts';

/**
 * Data access for the staff dashboard's aggregate queries (ARCHITECTURE Section 14, Section 18 —
 * "Database access: `src/data/*Repository.ts`").
 *
 * This layer holds the `GROUP BY` and nothing else. It does not decide what a "completed"
 * submission is, which bands a score falls into, what counts as a most-common response, or whether
 * a difficulty comparison is meaningful — those are the dashboard's own rules and they live in
 * `src/domain/staff/DashboardService.ts`, which Section 18 names as the canonical location for
 * "Dashboard/aggregate queries". The split is the same one every other concern in this codebase
 * makes: `SubmissionService` decides what finalization is, `SubmissionRepository` performs it.
 *
 * ## Plain SQL at request time (Section 14)
 *
 * Section 14 is explicit that dashboard metrics are *"computed on-demand with plain SQL
 * `GROUP BY`/`AVG`/`COUNT` queries at request time — no precomputed materialized views or caching
 * layer"*, and gives the reason: at a few hundred rows these return in milliseconds. So there is no
 * summary table here, nothing is memoized between requests, and every method below is one query.
 *
 * ## Why raw SQL rather than Prisma's `groupBy`
 *
 * Two reasons. Prisma's `groupBy` cannot group by an expression over a JSON column, and the Student
 * Problems aggregates are exactly that — `jsonb_each_text` over `problemsLikertAnswers` and
 * `jsonb_array_elements` over `problemsTextDerived.categories`. And grouping all four score columns
 * in one statement returns the joint distribution, from which the service sums each section's
 * marginal, instead of four round trips that could observe four different database states.
 *
 * Every value below is a bound parameter — nothing from a request is interpolated into the
 * statement text. `COUNT(*)` is cast to `int` throughout because Postgres' `count` is `bigint`,
 * which Prisma hands back as a JS `BigInt` and `JSON.stringify` refuses to serialize: an uncast
 * count would produce a dashboard that 500s on the way out rather than on the way in.
 *
 * ## Why means are not computed here
 *
 * `AVG` is deliberately absent. Postgres returns `numeric` for it, which Prisma maps to a `Decimal`
 * object rather than a number, and the service has to compute means anyway — it holds the counts
 * per score and weights them by content-derived maxima. Deriving the mean from a histogram it
 * already has keeps one source for the same number.
 */

/** Which cohorts the aggregate covers. Absent means every cohort (FR-STAFF-009). */
export type DashboardFilter = {
  cohortId?: string;
};

/** One row of the joint score distribution: how many submissions have this combination. */
export type ScoreRow = {
  contentVersion: string;
  grammarScore: number | null;
  vocabularyScore: number | null;
  readingScore: number | null;
  writingOverallScore: number | null;
  count: number;
};

/** One submission's processing state, and how many submissions are in it. */
export type ProcessingCountRow = {
  status: string;
  writingStatus: string;
  problemsTextStatus: string;
  count: number;
};

/** One student's five-point answer to one statement. */
export type LikertRow = {
  contentVersion: string;
  statementId: string;
  /** 1–5 (FR-PROB-002). */
  value: number;
  count: number;
};

/** One AI-derived difficulty category, and how many responses it was extracted from. */
export type DerivedCategoryRow = {
  label: string;
  count: number;
};

/** One acknowledged choice answer, paired with the version whose question it answers. */
export type DifficultyInputRow = {
  contentVersion: string;
  /** `answers.grammar` as stored, or null. */
  grammar: unknown;
  vocabulary: unknown;
  reading: unknown;
};

/** One evaluated writing response's per-criterion scores, for the writing-by-criterion breakdown. */
export type WritingCriteriaRow = {
  contentVersion: string;
  /** `writingCriteriaScores` as stored: `{ [criterionKey]: { score, rationale } }`. */
  criteriaScores: unknown;
};

/** One submission as the dashboard's list shows it. */
export type RecentSubmissionRow = {
  id: string;
  rollNumberRaw: string;
  studentName: string;
  status: string;
  submittedAt: Date | null;
};

export class DashboardRepository {
  /**
   * The most recent submissions, for the dashboard's list (FR-STAFF-010).
   *
   * ## Why this is a row listing in a file about aggregates
   *
   * It is not an aggregate, and it would sit more naturally in `SubmissionRepository` on the
   * grounds that it returns submissions. It is here because of *why* it exists: the dashboard needs
   * a way into the individual-submission view, and this is the dashboard's read of that data — the
   * same cohort filter, the same request, the same payload. Splitting it across two repositories
   * would put one screen's data behind two objects with no rule separating them.
   *
   * ## Why a limit, and why no sorting or paging
   *
   * FR-STAFF-012 asks the dashboard to stay simple and focused rather than become a BI platform, so
   * there is no sort control, no paging, and no search. Newest first is the only order that needs no
   * explaining, and the limit is what keeps the list a navigation aid rather than a table of the
   * whole cohort — the full dataset is what the CSV export is for.
   *
   * `submittedAt` is nullable, so a draft would sort ahead of every submitted row under a plain
   * descending sort on it. Drafts are therefore ordered by `createdAt` in the same expression: a
   * student who has not submitted yet still appears, at the position their work was started, which
   * is where a staff member looking for "who has started but not finished" would expect to find it.
   */
  async recentSubmissions(
    filter: DashboardFilter,
    limit: number,
  ): Promise<RecentSubmissionRow[]> {
    return getPrismaClient().$queryRaw<RecentSubmissionRow[]>`
      SELECT s."id",
             s."rollNumberRaw" AS "rollNumberRaw",
             s."studentName",
             s."status"::text AS "status",
             s."submittedAt"
        FROM "Submission" s
       WHERE TRUE ${cohortPredicate(filter)}
       ORDER BY COALESCE(s."submittedAt", s."createdAt") DESC, s."rollNumberNormalized" ASC
       LIMIT ${limit}
    `;
  }

  /**
   * Every cohort, for the filter control (FR-STAFF-009).
   *
   * Ordered by code so the list is stable between requests — an unordered list would let the
   * control's options rearrange themselves under a staff member who is using it.
   *
   * Deliberately not filtered or paginated: at pilot scale there are one or two cohorts, and a
   * filter control that could not show every option would be a control that cannot do its job.
   */
  async listCohorts(): Promise<Cohort[]> {
    return getPrismaClient().cohort.findMany({ orderBy: { code: 'asc' } });
  }

  /** The cohort a filter names, or null. Used to refuse a filter that resolves to nothing. */
  async findCohortById(cohortId: string): Promise<Cohort | null> {
    return getPrismaClient().cohort.findUnique({ where: { id: cohortId } });
  }

  /**
   * Submission counts by lifecycle status and background-processing status (FR-STAFF-004).
   *
   * Every submission is counted, drafts included: "how many students have started and how many
   * have finished" is the first thing the dashboard has to answer, and a draft-only count would
   * make it unanswerable. The processing columns are what turn "submitted" into "and its Writing
   * feedback is ready / still running / needs review" (FR-FEEDBACK-007's `failed_needs_review`
   * surfacing to staff).
   *
   * Grouped on all three columns in one statement rather than three grouped counts, so the numbers
   * it returns are one consistent snapshot.
   */
  async countByStatusAndProcessing(filter: DashboardFilter): Promise<ProcessingCountRow[]> {
    return getPrismaClient().$queryRaw<ProcessingCountRow[]>`
      SELECT "status"::text             AS "status",
             "writingStatus"::text      AS "writingStatus",
             "problemsTextStatus"::text AS "problemsTextStatus",
             COUNT(*)::int              AS "count"
        FROM "Submission" s
       WHERE TRUE ${cohortPredicate(filter)}
       GROUP BY 1, 2, 3
    `;
  }

  /**
   * The joint distribution of the four scored columns (FR-STAFF-005/006).
   *
   * Only submitted rows: a draft has no scores, and including one would put a row of nulls into
   * every marginal. The four columns are grouped together so that the service can sum each
   * section's marginal from one result, and so that the *overall* figure — which combines the three
   * deterministic sections of one submission — is computable from a single row rather than by
   * re-joining submissions to themselves.
   *
   * `contentVersion` is a grouping key and not decoration. A section's maximum comes from the
   * content the submission was taken under (Section 12), so two submissions under two versions
   * cannot be turned into percentages against one denominator, and the service must be able to tell
   * them apart.
   */
  async scoreDistribution(filter: DashboardFilter): Promise<ScoreRow[]> {
    return getPrismaClient().$queryRaw<ScoreRow[]>`
      SELECT "contentVersion",
             "grammarScore",
             "vocabularyScore",
             "readingScore",
             "writingOverallScore",
             COUNT(*)::int AS "count"
        FROM "Submission" s
       WHERE s."status" = 'submitted' ${cohortPredicate(filter)}
       GROUP BY 1, 2, 3, 4, 5
    `;
  }

  /**
   * The five-point scale responses, counted per statement (FR-STAFF-008).
   *
   * `jsonb_each_text` unpacks `problemsLikertAnswers` — `{ statementId: 1–5 }` — into one row per
   * answer, which is what makes this a `GROUP BY` over the students' responses rather than a read
   * of every submission's JSON into memory.
   *
   * ## The `CASE` guarding `jsonb_each_text`
   *
   * `jsonb_each_text` raises on anything that is not a JSON object, and a `WHERE` clause is not a
   * guarantee that it runs second: Postgres may evaluate the lateral function before filtering. So
   * the guard is expressed as the function's *argument* — a non-object column is fed `'{}'`, which
   * yields no rows — rather than as a predicate that might be reordered past the failure.
   *
   * `problemsLikertAnswers` is `Json?` (Section 6) and only `SubmissionService.finalize` writes it,
   * always as an object built from the validated autosave schema, so the guard should never fire.
   * It exists because the alternative failure mode is not "a missing statement" but "the whole
   * dashboard returns 500", which one malformed row would be enough to cause.
   *
   * The `[1-5]` filter is the same kind of belt: FR-PROB-002's scale is validated at the API
   * boundary, and a value outside it is not a response the dashboard can average, so it is excluded
   * rather than allowed to error or to skew a mean.
   */
  async likertResponseCounts(filter: DashboardFilter): Promise<LikertRow[]> {
    return getPrismaClient().$queryRaw<LikertRow[]>`
      SELECT s."contentVersion"   AS "contentVersion",
             entry.key            AS "statementId",
             (entry.value)::int   AS "value",
             COUNT(*)::int        AS "count"
        FROM "Submission" s
        CROSS JOIN LATERAL jsonb_each_text(
          CASE WHEN jsonb_typeof(s."problemsLikertAnswers") = 'object'
               THEN s."problemsLikertAnswers" ELSE '{}'::jsonb END
        ) AS entry(key, value)
       WHERE s."status" = 'submitted'
         AND entry.value ~ '^[1-5]$'
         ${cohortPredicate(filter)}
       GROUP BY 1, 2, 3
    `;
  }

  /**
   * How often each AI-derived difficulty category was extracted (FR-STAFF-008).
   *
   * `problemsTextDerived.categories` is the model's own short labels (FR-PROB-011), stored in their
   * own column precisely so they can never be read as the student's words — Section 6 keeps the
   * original and the derived text in separate columns, and this query reads only the derived one.
   * The service labels the result as derived; nothing here decides how it is presented.
   *
   * Reads rows where `problemsTextDerived` is set, which is exactly the set whose
   * `problemsTextStatus` is `succeeded` — `recordStudentProblemsAnalysis` writes the two together
   * in one statement. Restating the status as a predicate would be a second expression of that same
   * fact, and the two could only ever disagree.
   *
   * A response with no categories contributes no rows rather than a row of nulls, which is why the
   * `CASE` yields an empty array: `categories` may legitimately be empty (a response that matches
   * no category is an honest answer), and an empty array legitimately produces no group.
   */
  async derivedCategoryCounts(filter: DashboardFilter): Promise<DerivedCategoryRow[]> {
    return getPrismaClient().$queryRaw<DerivedCategoryRow[]>`
      SELECT category ->> 'label' AS "label",
             COUNT(*)::int        AS "count"
        FROM "Submission" s
        CROSS JOIN LATERAL jsonb_array_elements(
          CASE WHEN jsonb_typeof(s."problemsTextDerived" -> 'categories') = 'array'
               THEN s."problemsTextDerived" -> 'categories' ELSE '[]'::jsonb END
        ) AS category
       WHERE s."status" = 'submitted'
         AND category ->> 'label' IS NOT NULL
         ${cohortPredicate(filter)}
       GROUP BY 1
       ORDER BY "count" DESC, "label" ASC
    `;
  }

  /**
   * The three sections' choice answers, for the difficulty comparison (FR-STAFF-007, T8.1.2).
   *
   * Only the three deterministic sections are selected. The difficulty comparison is about
   * questions, and Writing and Student Problems have none — Writing is a single free-text task and
   * Student Problems is an instrument of statements. Selecting `answers` whole would also drag
   * every essay and open-text response into memory to compute a figure that reads none of them.
   *
   * The scores are *not* read from the stored columns here, unlike every other query in this file.
   * Those columns are section totals, and FR-STAFF-007 asks for a comparison *within* a section
   * across difficulty levels — which only per-question outcomes can answer. So this returns the
   * answers and lets `DashboardService` score them against the submission's frozen content, through
   * the same `DeterministicScoringService` the student report uses. Section 14's "no caching layer"
   * applies to this too: it is computed per request like everything else.
   */
  async difficultyInputs(filter: DashboardFilter): Promise<DifficultyInputRow[]> {
    return getPrismaClient().$queryRaw<DifficultyInputRow[]>`
      SELECT s."contentVersion"        AS "contentVersion",
             s."answers" -> 'grammar'    AS "grammar",
             s."answers" -> 'vocabulary' AS "vocabulary",
             s."answers" -> 'reading'    AS "reading"
        FROM "Submission" s
       WHERE s."status" = 'submitted' ${cohortPredicate(filter)}
    `;
  }

  /**
   * Per-criterion writing scores for evaluated submissions, for the writing-by-criterion breakdown
   * (a dashboard extension of FR-STAFF-006/012 — see `DashboardService.buildWritingCriteria`).
   *
   * Restricted to `writingStatus = 'succeeded'`: a criterion score only exists once evaluation has
   * finished, and `not_applicable`/`pending`/`processing`/`failed_needs_review` rows carry no
   * `writingCriteriaScores` to average. The service does not have to filter these out itself — the
   * same "only count what actually has the field" rule `difficultyInputs` leaves to `DashboardService`
   * for choice answers is enforced here in SQL instead, because unlike a choice answer, a row with no
   * evaluation is not an input to *re-score* — it is simply not a row this aggregate is about.
   */
  async writingCriteriaScores(filter: DashboardFilter): Promise<WritingCriteriaRow[]> {
    return getPrismaClient().$queryRaw<WritingCriteriaRow[]>`
      SELECT s."contentVersion"         AS "contentVersion",
             s."writingCriteriaScores"  AS "criteriaScores"
        FROM "Submission" s
       WHERE s."status" = 'submitted'
         AND s."writingStatus" = 'succeeded'
         AND s."writingCriteriaScores" IS NOT NULL
         ${cohortPredicate(filter)}
    `;
  }
}

/**
 * The cohort restriction, or nothing at all.
 *
 * `Prisma.empty` rather than an optional predicate spelled two ways, so the unfiltered case adds no
 * SQL to the statement and both branches stay one query shape. Every query aliases `Submission` as
 * `s`, so the fragment has exactly one spelling.
 */
function cohortPredicate(filter: DashboardFilter): Prisma.Sql {
  if (filter.cohortId === undefined) return Prisma.empty;

  return Prisma.sql`AND s."cohortId" = ${filter.cohortId}`;
}

/** The process-wide repository instance. */
export const dashboardRepository = new DashboardRepository();
