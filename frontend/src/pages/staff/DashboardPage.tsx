import { useEffect, useState } from 'react';
import type {
  DashboardPayload,
  DifficultyComparison,
  SectionAggregate,
  StatementAggregate,
  TopicAggregate,
  WritingCriterionAggregate,
} from '../../../../src/domain/staff/DashboardService';
import { ApiError, downloadStaffExportCsv, getStaffDashboard } from '../../api/client';
import { StaffLayout } from '../../components/StaffLayout';
import { Link, navigate, submissionDetailPath } from '../../router';

/**
 * The staff dashboard (T8.3.1) — the pilot's limited internal analysis view (PRD Section 9.7).
 *
 * ## What it is, and what it deliberately is not
 *
 * FR-STAFF-012 is a requirement about restraint: *"The dashboard must remain simple and focused; it
 * is explicitly not a full business-intelligence platform."* PRD Section 14 says why — the product's
 * job is to let staff understand one pilot cohort well enough to inform curriculum design, and
 * *"support external, deeper analysis via export rather than trying to replace tools like Excel or
 * Python within the product."*
 *
 * So there is no charting library (Section 2 pins none), no drill-down, no sorting or paging, and no
 * interactivity beyond the one filter the PRD asks for. The distributions are hand-drawn bars: a
 * `<div>` whose width is a percentage. The export control (T8.4.2) is the escape hatch to real
 * analysis tools, and it is where this page points a reader who wants more.
 *
 * ## The load rule (Section 5)
 *
 * *"`DashboardPage` → aggregate queries on load and on filter change."* One effect keyed on the
 * selected cohort does both: it runs on mount with no filter, and again whenever the selection
 * changes. There is no polling — the numbers only change when a student submits or a background job
 * finishes, and a staff member refreshing is a cheaper way to see that than a request every ten
 * seconds.
 *
 * ## What the page does not decide
 *
 * Every rule the numbers depend on — what counts as complete, which bands a distribution uses, how
 * the four sections are put on one axis, and whether the difficulty comparison is meaningful at all
 * — lives in `DashboardService` (FR-STAFF-007's "encode the decision in the service"). This file
 * renders what it is handed, including the *reason* a comparison is absent, and never recomputes or
 * second-guesses a figure.
 */

export function DashboardPage() {
  /**
   * The selected cohort, or `''` for all of them.
   *
   * The empty string is the `All cohorts` option's value rather than `undefined`, because a
   * `<select>` cannot express "no selection" — its value is always a string, and a sentinel that is
   * not a cohort id keeps "everything" distinct from "the cohort whose id is empty".
   */
  const [cohortId, setCohortId] = useState('');
  const [dashboard, setDashboard] = useState<DashboardPayload | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    setLoading(true);

    getStaffDashboard(cohortId === '' ? undefined : cohortId)
      .then((loaded) => {
        if (cancelled) return;

        setDashboard(loaded);
        setLoadError(null);
      })
      .catch((error: unknown) => {
        if (cancelled) return;

        // A lost staff session is a navigation rather than a message: re-authenticating is the only
        // way back, and the login page is where pressing Back should land anyway.
        if (error instanceof ApiError && error.status === 401) {
          navigate('/staff/login', { replace: true });
          return;
        }

        // A filter naming a cohort that no longer exists. The selection is dropped so the page
        // falls back to every cohort — which is a real answer — instead of leaving the reader
        // parked on an error they cannot clear from here.
        if (error instanceof ApiError && error.status === 404) {
          setCohortId('');
          setLoadError(error.message);
          return;
        }

        setLoadError(error instanceof ApiError ? error.message : 'Something went wrong');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      // React 18's development StrictMode runs effects twice; without this, a stale response could
      // overwrite a fresh one — which matters here, because the filter can change mid-flight.
      cancelled = true;
    };
  }, [cohortId]);

  /**
   * Downloads the current view as CSV (T8.4.2, FR-STAFF-011).
   *
   * The export follows the filter, because the filter is what the staff member is looking at: an
   * export of everything from a cohort-filtered screen would be a file they did not ask for and
   * might not notice was broader than the page.
   *
   * The blob is handed to a temporary anchor rather than assigned to `location`, because assigning
   * to `location` cannot set a filename — the browser would use the URL's last segment, and the
   * server's dated, cohort-named filename would be lost. The object URL is revoked immediately
   * afterwards; not revoking it leaks the blob for the life of the document, which on a page a staff
   * member leaves open all afternoon is a real leak rather than a theoretical one.
   */
  async function handleExport() {
    setExporting(true);
    setExportError(null);

    try {
      const { blob, filename } = await downloadStaffExportCsv(cohortId === '' ? undefined : cohortId);

      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');

      link.href = url;
      link.download = filename;
      link.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        navigate('/staff/login', { replace: true });
        return;
      }

      setExportError(error instanceof ApiError ? error.message : 'Something went wrong');
    } finally {
      setExporting(false);
    }
  }

  if (loadError !== null && dashboard === null) {
    return (
      <main className="page">
        <div className="card">
          <h1>We could not load the dashboard</h1>
          <div className="notice" role="alert">
            <p>{loadError}</p>
          </div>
          <p className="hint">Reload this page to try again.</p>
        </div>
      </main>
    );
  }

  if (dashboard === null) {
    return (
      <main className="page">
        <div className="card">
          <p className="lede">Loading dashboard…</p>
        </div>
      </main>
    );
  }

  return (
    <DashboardBody
      dashboard={dashboard}
      cohortId={cohortId}
      onCohortChange={setCohortId}
      loading={loading}
      notice={loadError}
      onExport={handleExport}
      exporting={exporting}
      exportError={exportError}
    />
  );
}

/**
 * The dashboard's contents, given a payload.
 *
 * Split from the component above so the rendering is a pure function of what it is handed — the same
 * split, for the same reason, as `ReportPage`/`ReportBody` and `SubmissionDetailPage`/
 * `SubmissionDetailBody`: the shell owns *when* to fetch, and this owns what the numbers look like.
 * It also makes the rendering checkable without a browser, which is the only kind of frontend
 * verification this repository has (Section 2 pins no DOM testing library).
 */
export function DashboardBody({
  dashboard,
  cohortId,
  onCohortChange,
  loading = false,
  notice = null,
  onExport,
  exporting = false,
  exportError = null,
}: {
  dashboard: DashboardPayload;
  cohortId: string;
  onCohortChange: (cohortId: string) => void;
  loading?: boolean;
  notice?: string | null;
  onExport: () => void;
  exporting?: boolean;
  exportError?: string | null;
}) {
  const { counts } = dashboard;
  const needsReview = (counts.writing.failed_needs_review ?? 0) + (counts.problemsText.failed_needs_review ?? 0);

  return (
    <StaffLayout activeItem="dashboard" title="Assessment dashboard">
      <div className="card">
        <p className="lede">
          Submissions, score distributions, and Student Problems patterns for{' '}
          {dashboard.cohort === null ? 'all cohorts' : dashboard.cohort.code}.
        </p>

        {notice !== null && (
          <div className="notice" role="alert">
            <p>{notice}</p>
          </div>
        )}

        <div className="filter-row">
          <label htmlFor="cohort-filter">Cohort</label>
          <select
            id="cohort-filter"
            value={cohortId}
            onChange={(event) => onCohortChange(event.target.value)}
            disabled={loading}
          >
            <option value="">All cohorts</option>
            {dashboard.cohorts.map((cohort) => (
              <option key={cohort.id} value={cohort.id}>
                {cohort.code} — {cohort.name}
              </option>
            ))}
          </select>
          {/*
            Announced rather than shown as a spinner. A dashboard that blanks its numbers on every
            filter change is harder to read than one that keeps the old ones until the new ones
            arrive — and at pilot scale the gap is a few milliseconds.
          */}
          <span className="muted" role="status" aria-live="polite">
            {loading ? 'Updating…' : ''}
          </span>
        </div>

        <p className="hint">
          This view is deliberately limited (FR-STAFF-012). For deeper analysis, export the data and
          work with it in a spreadsheet or a script.
        </p>

        <div className="export-row">
          {/*
            A button rather than a link: the export is fetched so its refusals can be handled (see
            `downloadStaffExportCsv`), which means it is an action rather than a navigation, and it
            says which cohort it will cover so the scope is on screen before the click rather than
            discovered in the filename afterwards.
          */}
          <button type="button" onClick={onExport} disabled={exporting}>
            {exporting
              ? 'Preparing export…'
              : `Export ${dashboard.cohort === null ? 'all cohorts' : dashboard.cohort.code} as CSV`}
          </button>
          {exporting && (
            <span className="muted" role="status" aria-live="polite">
              This can take a moment for a large cohort.
            </span>
          )}
        </div>

        {exportError !== null && (
          <div className="notice" role="alert">
            <p>{exportError}</p>
          </div>
        )}
      </div>

      {/*
        KPI strip: quiet by default, loud only where something needs attention. "Needs review" is
        the one figure that should never blend in with routine counts — a failed writing evaluation
        sitting in a plain metric list, the same weight as "Submitted: 18", is exactly how it gets
        missed (the presentation problem T8.3.1's original build left unaddressed).
      */}
      <div className="kpi-row">
        <KpiCard label="Submitted" value={counts.submitted} sub={`of ${counts.submissions} started`} />
        <KpiCard label="Draft / in progress" value={counts.draft} quiet />
        <KpiCard
          label="Needs review"
          value={needsReview}
          sub="Writing or Student Problems evaluations that failed automatically"
          attention={needsReview > 0}
        />
        <KpiCard
          label="Overall mean"
          value={`${dashboard.overall.meanPercent}%`}
          sub="Grammar + Vocabulary + Reading"
        />
      </div>

      <div className="card">
        <h2>Background evaluation of submitted work</h2>
        <ul className="metric-list">
          <li className="metric">
            <span className="metric-label">Writing: ready</span>
            <span className="metric-value">{counts.writing.succeeded ?? 0}</span>
          </li>
          <li className="metric">
            <span className="metric-label">Writing: still running</span>
            {/* `pending` and `processing` are both "not finished" to a reader; two rows for them
                would be a distinction the dashboard has no use for. */}
            <span className="metric-value">
              {(counts.writing.pending ?? 0) + (counts.writing.processing ?? 0)}
            </span>
          </li>
          <li className="metric">
            <span className="metric-label">Writing: needs review</span>
            <span className="metric-value">{counts.writing.failed_needs_review ?? 0}</span>
          </li>
          <li className="metric">
            <span className="metric-label">Student Problems text: ready</span>
            <span className="metric-value">{counts.problemsText.succeeded ?? 0}</span>
          </li>
          <li className="metric">
            <span className="metric-label">Student Problems text: needs review</span>
            <span className="metric-value">{counts.problemsText.failed_needs_review ?? 0}</span>
          </li>
        </ul>
      </div>

      <div className="card">
        <h2>Recent submissions</h2>
        <p className="hint">
          Open any of these to see the full record, including the Student Problems responses that are
          never shown to students. Opening one is recorded in the server log (Section 13).
        </p>

        {dashboard.recentSubmissions.length === 0 ? (
          <p className="muted">No submissions in this view yet.</p>
        ) : (
          /*
            Cards-first (spec Section 8): each submission is one clickable card rather than a table
            row. The card itself is the `<Link>` — a single focusable, keyboard-operable target that
            can be opened in a new tab — rather than a `<div onClick>` sitting around a separate link,
            which would leave two different-sized click targets doing the same thing.
          */
          <div className="submission-grid">
            {dashboard.recentSubmissions.map((submission) => (
              <Link
                key={submission.id}
                to={submissionDetailPath(submission.id)}
                className="submission-card"
              >
                <p className="submission-name">{submission.studentName}</p>
                <p className="submission-meta">
                  Roll {submission.rollNumber}
                  {submission.submittedAt !== null && (
                    <> · Submitted {new Date(submission.submittedAt).toLocaleDateString()}</>
                  )}
                </p>
                <span
                  className={
                    submission.status === 'submitted'
                      ? 'submission-status'
                      : 'submission-status submission-status--draft'
                  }
                >
                  {submission.status === 'submitted' ? 'Submitted' : 'In progress'}
                </span>
              </Link>
            ))}
          </div>
        )}

        {/*
          Said plainly, because the list is capped and a staff member counting rows against the
          "Started" figure above would otherwise think records were missing.
        */}
        {dashboard.recentSubmissions.length >= 25 && (
          <p className="hint">
            Showing the 25 most recent. Export the data for the full set.
          </p>
        )}
      </div>

      <div className="card">
        <h2>Section comparison</h2>
        <p className="hint">
          Mean score as a percentage of each section's own maximum, so Grammar, Vocabulary, Reading,
          and Writing sit on one axis (FR-STAFF-006) even though they are scored out of different
          totals.
        </p>

        <SectionComparisonChart sections={dashboard.sections} />

        <details className="dist-toggle">
          <summary>View full score distribution</summary>
          <div className="feedback-block">
            <h3>Overall</h3>
            <p className="muted">
              {dashboard.overall.scoredSubmissions} scored · mean {dashboard.overall.meanPercent}%
            </p>
            <Distribution title="Overall" distribution={dashboard.overall.distribution} hideTitle />
          </div>
          {dashboard.sections.map((section) => (
            <SectionBlock key={section.section} section={section} />
          ))}
        </details>
      </div>

      <WeakestTopicsPanel topics={dashboard.weakestTopics} />

      <WritingCriteriaPanel criteria={dashboard.writingCriteria} />

      {/*
        The difficulty-level comparison is built and working, but not shown (removed at the team's
        request). Until the question set is approved it can only ever render one thing — a card
        explaining why it is not showing anything — which is a card about its own absence taking up
        room on the screen it is absent from.

        Kept rather than deleted, deliberately: `DifficultyPanel` below, the `difficulty` field the
        service computes (with its tests), and `formatDifficulty` are all intact. When the content is
        approved this is one uncommented line. Nothing else reads `difficulty`, so the service
        computing it costs a query and no rendering.
      */}
      {/* <DifficultyPanel difficulty={dashboard.difficulty} /> */}

      <ProblemsPanel
        statements={dashboard.problems.statements}
        derivedCategories={dashboard.problems.derivedCategories}
        analysedResponses={dashboard.problems.analysedResponses}
      />

      <div className="card">
        <p className="hint">
          Every submission is reachable from the list above; the export is for working with the data
          outside the application.
        </p>
      </div>
    </StaffLayout>
  );
}

/**
 * One KPI strip card.
 *
 * `attention` is the mechanism behind "quiet unless something is wrong" (see `DashboardBody`'s
 * `needsReview`): a card is only ever tinted when its own caller has decided the number is bad news,
 * never inferred from the value itself here, so a page cannot accidentally flag a number nobody
 * asked it to judge.
 */
function KpiCard({
  label,
  value,
  sub,
  attention = false,
  quiet = false,
}: {
  label: string;
  value: number | string;
  sub?: string;
  attention?: boolean;
  quiet?: boolean;
}) {
  const className = attention ? 'kpi-card kpi-card--attention' : quiet ? 'kpi-card kpi-card--quiet' : 'kpi-card';

  return (
    <div className={className}>
      <p className="kpi-label">{label}</p>
      <p className="kpi-value">{value}</p>
      {sub !== undefined && <p className="kpi-sub">{sub}</p>}
    </div>
  );
}

/**
 * Above this mean, a bar reaches too close to the top of its track for the value to sit above it,
 * so the value moves inside the bar instead.
 *
 * Derived from the chart's own geometry rather than chosen: the track is 11rem (176px) tall and the
 * value occupies roughly 17px including its gap, so the space above a bar stops holding it at
 * 17/176 ≈ 9.7% of the track — i.e. a mean of about 90%. If `--compare-track-h` or the value's
 * font size changes, this moves with them.
 */
const LABEL_ABOVE_MAX_PERCENT = 90;

/**
 * The FR-STAFF-006 comparison, drawn as one grouped bar chart instead of four separate stacked
 * lists a reader had to compare by eye. Height is `meanPercent`; the response count sits underneath
 * so nobody reads a two-submission mean with the confidence of a forty-submission one.
 *
 * The value sits above its bar by default — inside the grey track but clear of the blue, which is
 * what makes a short bar's number legible. Inside the bar, as it was, an 11% bar clips its own
 * label: the fill is only about 1.2rem tall and the number is about 1rem of it, so the figure is
 * squeezed against the bar's edges or cut off entirely by the track's `overflow: hidden`.
 */
function SectionComparisonChart({ sections }: { sections: SectionAggregate[] }) {
  return (
    <div className="compare-chart">
      {sections.map((section) => (
        <div className="compare-col" key={section.section}>
          <div className="compare-bar-track">
            <div className="compare-bar-fill" style={{ height: `${section.meanPercent}%` }}>
              {/*
                No value where nothing is scored. The mean of an empty set is undefined, not zero,
                and printing "0%" against an empty track would state a score nobody received — the
                "0 scored" caption underneath is what carries that fact.
              */}
              {section.scoredSubmissions > 0 && (
                <span
                  className={
                    section.meanPercent > LABEL_ABOVE_MAX_PERCENT
                      ? 'compare-value compare-value--inside'
                      : 'compare-value'
                  }
                >
                  {section.meanPercent}%
                </span>
              )}
            </div>
          </div>
          <p className="compare-label">{section.title}</p>
          <p className="compare-n">{section.scoredSubmissions} scored</p>
        </div>
      ))}
    </div>
  );
}

/**
 * The weakest-topics panel — new in this pass. Every Grammar/Vocabulary/Reading question already
 * carries a `skill` label (FR-DET-002, "used for staff analysis") that nothing previously read; this
 * is that reading, as a worst-first ranked list rather than another per-topic histogram, because the
 * question this panel answers is "where should curriculum time go", not "what is the full spread".
 *
 * An empty list is a real, sayable outcome — not enough responses yet for any topic to clear
 * `MIN_RESPONSES_PER_TOPIC` — and the page says so rather than rendering a panel with nothing in it.
 */
function WeakestTopicsPanel({ topics }: { topics: TopicAggregate[] }) {
  return (
    <div className="card">
      <h2>Weakest topics</h2>
      <p className="hint">
        Accuracy per skill/topic label, worst first — this is where curriculum time is best spent.
        A topic only appears once enough students have answered its question for the number to mean
        something.
      </p>

      {topics.length === 0 ? (
        <p className="muted">Not enough responses yet for any topic to be reported.</p>
      ) : (
        <ul className="rank-list">
          {topics.map((topic) => (
            <li className="rank-row" key={`${topic.section}:${topic.skill}`}>
              <span className="rank-name">
                {topic.skill}
                <span className="rank-section">{topic.sectionTitle}</span>
              </span>
              <span className="rank-track">
                <span
                  className={`rank-fill ${severityClass(topic.accuracyPercent)}`}
                  style={{ width: `${topic.accuracyPercent}%` }}
                />
              </span>
              <span className="rank-pct">{topic.accuracyPercent}%</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** The four severity bands the weakest-topics bars are tinted by — worst to best. */
function severityClass(accuracyPercent: number): string {
  if (accuracyPercent < 25) return 'sev-1';
  if (accuracyPercent < 50) return 'sev-2';
  if (accuracyPercent < 75) return 'sev-3';
  return 'sev-4';
}

/**
 * Writing's mean score per rubric criterion — an extension of the section comparison above, one
 * level deeper into the one section the comparison cannot break down further on its own. Every
 * number here is already computed and stored by `WritingScoreCalculator` at evaluation time; this
 * is purely an average of figures that exist, not a new model call.
 */
function WritingCriteriaPanel({ criteria }: { criteria: WritingCriterionAggregate[] }) {
  const evaluated = Math.max(...criteria.map((criterion) => criterion.responses), 0);

  return (
    <div className="card">
      <h2>Writing — by criterion</h2>
      <p className="hint">
        Mean of each rubric criterion across evaluated submissions
        {evaluated > 0 && <> ({evaluated} evaluated)</>}.
      </p>

      {evaluated === 0 ? (
        <p className="muted">No writing responses have been evaluated yet.</p>
      ) : (
        <div className="criteria-grid">
          {criteria.map((criterion) => (
            <div className="criteria-row" key={criterion.key}>
              <span>{criterion.label}</span>
              <span className="criteria-track">
                <span className="criteria-fill" style={{ width: `${criterion.meanScore}%` }} />
              </span>
              <span className="criteria-value">{criterion.meanScore}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * One section's line in the comparison (FR-STAFF-005/006), inside the "view full distribution"
 * disclosure — the mean itself is now the grouped chart above; this is the detail behind it.
 *
 * `meanScore`/`maxScore` are shown only when they are present, which they are unless submissions
 * under more than one content version are being aggregated — the server reports null then, because
 * two versions' maxima are different denominators. `meanPercent` is always shown, because it is the
 * figure that is comparable in every case.
 */
function SectionBlock({ section }: { section: SectionAggregate }) {
  return (
    <div className="feedback-block">
      <h3>
        {section.title}{' '}
        <span className="score">
          {section.meanScore !== null && section.maxScore !== null
            ? `mean ${section.meanScore} / ${section.maxScore}`
            : `mean ${section.meanPercent}%`}
        </span>
      </h3>
      <p className="muted">
        {section.scoredSubmissions} scored
        {section.meanScore !== null && <> · {section.meanPercent}%</>}
      </p>
      <Distribution title={section.title} distribution={section.distribution} hideTitle />
    </div>
  );
}

/**
 * A distribution as hand-drawn bars.
 *
 * A `<div>` per band whose width is the band's share of the largest band, not of the total: with
 * six bands and a dozen submissions, scaling to the total makes every bar invisible. The count is
 * printed beside each bar, so the bar is a shape and the number is the fact.
 */
function Distribution({
  title,
  distribution,
  hideTitle = false,
}: {
  title: string;
  distribution: { label: string; count: number }[];
  hideTitle?: boolean;
}) {
  const total = distribution.reduce((sum, band) => sum + band.count, 0);
  const largest = distribution.reduce((max, band) => Math.max(max, band.count), 0);

  return (
    <div className="feedback-block">
      {!hideTitle && <h3>{title}</h3>}
      {total === 0 ? (
        <p className="muted">No scores in this view yet.</p>
      ) : (
        distribution.map((band) => (
          <div key={band.label} className="bar-row">
            <span className="bar-label">{band.label}</span>
            <span className="bar-track">
              <span
                className="bar-fill"
                style={{ width: largest === 0 ? '0%' : `${(band.count / largest) * 100}%` }}
              />
            </span>
            <span className="bar-value">{band.count}</span>
          </div>
        ))
      )}
    </div>
  );
}

/**
 * The conditional difficulty comparison (FR-STAFF-007, T8.1.2).
 *
 * When it is unavailable, the page says so and says why, rather than rendering nothing. FR-STAFF-007
 * forbids a *misleading* comparison; it does not ask for silence. A section that simply vanished
 * would be indistinguishable from a bug, and a staff member who had been told the capability exists
 * would have no way to find out that the blocker is the content, not the software.
 *
 * The wording is the page's, and PRD Section 23.1 item 5 leaves staff-facing copy provisional — the
 * service returns a reason code precisely so this text can change without touching the rule.
 */
function DifficultyPanel({ difficulty }: { difficulty: DifficultyComparison }) {
  if (!difficulty.available) {
    const explanation: Record<typeof difficulty.reason, string> = {
      content_not_approved:
        'The question set is still provisional, so its difficulty design is not final. Comparing ' +
        'levels now would report which development questions were written rather than how the ' +
        'cohort performed.',
      levels_under_represented:
        'One or more difficulty levels are represented by too few questions for a difference ' +
        'between levels to mean anything.',
    };

    return (
      <div className="card">
        <h2>Difficulty levels</h2>
        <p className="muted">
          This comparison is not shown, because it would be misleading (FR-STAFF-007).
        </p>
        <p>{explanation[difficulty.reason]}</p>
      </div>
    );
  }

  const questionCounts = Object.entries(difficulty.questionsPerLevel);

  return (
    <div className="card">
      <h2>Difficulty levels</h2>
      <p className="hint">
        Accuracy across Basic, Intermediate, and Upper-intermediate questions in Grammar,
        Vocabulary, and Reading. Writing has no difficulty levels, so it is not part of this.
      </p>

      <ul className="metric-list">
        {difficulty.levels.map((level) => (
          <li key={level.difficulty} className="metric">
            <span className="metric-label">{formatDifficulty(level.difficulty)}</span>
            <span className="metric-value">
              {level.accuracyPercent}%{' '}
              <span className="muted">
                ({level.correct}/{level.responses})
              </span>
            </span>
          </li>
        ))}
      </ul>

      <p className="muted">
        Drawn from {questionCounts.map(([level, count]) => `${count} ${formatDifficulty(level)}`).join(', ')}{' '}
        questions.
      </p>
    </div>
  );
}

/** A difficulty value as it is written in the PRD (Section 10). */
function formatDifficulty(difficulty: string): string {
  const labels: Record<string, string> = {
    basic: 'Basic',
    intermediate: 'Intermediate',
    'upper-intermediate': 'Upper-intermediate',
  };

  return labels[difficulty] ?? difficulty;
}

/**
 * The most common Student Problems responses (FR-STAFF-008).
 *
 * ## Leads with a ranking, not a full read
 *
 * Every one of the 15–20 statements used to render fully expanded — its own five-band histogram,
 * always on screen, regardless of whether it was one of the ones actually worth attention. This
 * panel now leads with the `TOP_STATEMENTS_SHOWN` statements the cohort agreed with *most*
 * (`mean` is already a five-point scale where "agree" indicates difficulty; see
 * `StatementAggregate`), because "what's the actual signal" is the question a staff member opens
 * this panel to answer. Every statement's full histogram is still one click away, not removed.
 *
 * ## Why the statements and the AI's categories are separate blocks
 *
 * The first is what students said; the second is what a model made of what they wrote. FR-PROB-011
 * requires the second to be clearly labelled as derived, and the surest way to make two things
 * distinguishable is not to put them in one list — so the categories are their own block, under
 * their own heading, carrying the same "derived" tag the submission view uses.
 *
 * The normalised text is not shown here at all. It is individual student prose (FR-PROB-015 scopes
 * it to authorized staff, which this is, but it is still one student's words), and a dashboard
 * aggregates. Staff who need it open the submission.
 */
function ProblemsPanel({
  statements,
  derivedCategories,
  analysedResponses,
}: {
  statements: StatementAggregate[];
  derivedCategories: { label: string; count: number }[];
  analysedResponses: number;
}) {
  const ranked = [...statements].sort((a, b) => b.mean - a.mean);
  const leading = ranked.slice(0, TOP_STATEMENTS_SHOWN);

  return (
    <div className="ai-panel">
      <h2>Student Problems — curriculum signal only</h2>
      <p className="hint">
        This section never affects any English score (FR-PROB-008/012). It is collected for
        curriculum analysis, and it is not a clinical or diagnostic instrument (FR-PROB-006). The
        statements below are the ones the cohort agreed with most.
      </p>

      {statements.length === 0 ? (
        <p className="muted">No statements have been answered yet.</p>
      ) : (
        <>
          <ul className="ai-rank-list">
            {leading.map((statement) => (
              <li className="ai-rank-row" key={`${statement.contentVersion}:${statement.statementId}`}>
                <span className="ai-statement">{statement.statement}</span>
                <span className="ai-mean">{statement.mean}</span>
              </li>
            ))}
          </ul>

          <details className="ai-detail">
            <summary>View all {statements.length} statements</summary>
            <ul className="problem-list">
              {ranked.map((statement) => (
                <ProblemStatement
                  key={`${statement.contentVersion}:${statement.statementId}`}
                  statement={statement}
                />
              ))}
            </ul>
          </details>
        </>
      )}

      <div className="derived">
        <p className="derived-head">
          <span className="derived-tag">Derived data</span>{' '}
          <span className="muted">
            — difficulties an AI identified in the open-ended responses
          </span>
        </p>
        <p className="hint">
          These are the system's labels, not the students' words, and not a diagnosis. They are
          counted across {analysedResponses} analysed {analysedResponses === 1 ? 'response' : 'responses'}.
        </p>

        {derivedCategories.length === 0 ? (
          <p className="muted">No categories were identified.</p>
        ) : (
          <ul className="metric-list">
            {derivedCategories.map((category) => (
              <li key={category.label} className="metric">
                <span className="metric-label">{category.label}</span>
                <span className="metric-value">{category.count}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

/** How many statements the leading ranked list shows before "View all" takes over. */
const TOP_STATEMENTS_SHOWN = 3;

/**
 * One statement's row: its wording, how the cohort answered it, and the modal response.
 *
 * The full five-point spread is shown rather than only the mode, because "most students agreed" and
 * "the cohort split evenly with a slight lean" are different findings about a curriculum, and the
 * mode alone cannot tell them apart.
 */
function ProblemStatement({ statement }: { statement: StatementAggregate }) {
  return (
    <li className="problem">
      <p className="problem-statement">{statement.statement}</p>
      <p className="muted">
        {statement.areaLabel} · {statement.responses} responses · mean {statement.mean}
      </p>
      {statement.counts.map((count) => (
        <div key={count.value} className="bar-row">
          <span className="bar-label">{count.label}</span>
          <span className="bar-track">
            <span
              className="bar-fill"
              style={{
                width:
                  statement.responses === 0
                    ? '0%'
                    : `${(count.count / statement.responses) * 100}%`,
              }}
            />
          </span>
          <span className="bar-value">{count.count}</span>
        </div>
      ))}
      {statement.mostCommon !== null && (
        <p className="muted">
          Most common: {statement.mostCommon.label} ({statement.mostCommon.count})
        </p>
      )}
    </li>
  );
}
