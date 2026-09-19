import { useEffect, useState } from 'react';
import type { DashboardPayload } from '../../../../src/domain/staff/DashboardService';
import { ApiError, getStaffDashboard } from '../../api/client';
import { StaffLayout } from '../../components/StaffLayout';
import { Link, navigate, submissionDetailPath } from '../../router';

/**
 * The submissions list (staff).
 *
 * ## Why this page exists at all, and what it costs
 *
 * The sidebar has carried a second nav item since the staff shell was built, but both items
 * pointed at `/staff/dashboard`, so "Submissions" was a label that navigated nowhere — clicking it
 * from the dashboard did nothing, and the only way into an individual record was the card grid
 * further down that same page.
 *
 * This adds an eighth route to ARCHITECTURE Section 9's table, which is a deliberate amendment
 * rather than an oversight (Section 9 is updated alongside this file). What it does **not** add is
 * an eighth API endpoint: Section 10 describes the API as *"deliberately small — one endpoint per
 * real user action"*, and `GET /api/staff/dashboard` already returns exactly the rows this page
 * needs (`recentSubmissions`: id, roll number, name, status, submittedAt). So the page reads that
 * endpoint and renders one part of its payload.
 *
 * The cost of that choice is inherited and stated on the page rather than hidden: the list is the
 * 25 most recent submissions, because that is what the dashboard's query bounds it to. A page that
 * silently showed a subset of a set it calls "submissions" would be worse than one that says so,
 * which is why the cap notice is rendered whenever the list is full rather than only when it
 * overflows.
 *
 * ## Why the list is not filtered by cohort
 *
 * The dashboard carries a cohort filter because it aggregates per cohort; this page is a list, and
 * the pilot has one cohort. Adding a filter here would duplicate a control whose state lives on
 * another page, so the honest version at this scale is no filter — and the CSV export is the tool
 * for anything the list cannot answer (FR-STAFF-012).
 */
export function SubmissionsPage() {
  const [dashboard, setDashboard] = useState<DashboardPayload | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    getStaffDashboard()
      .then((loaded) => {
        if (cancelled) return;

        setDashboard(loaded);
        setLoadError(null);
      })
      .catch((error: unknown) => {
        if (cancelled) return;

        // A lost staff session is a navigation rather than a message — the same handling as
        // `DashboardPage`, because re-authenticating is the only way back.
        if (error instanceof ApiError && error.status === 401) {
          navigate('/staff/login', { replace: true });
          return;
        }

        setLoadError(error instanceof ApiError ? error.message : 'Something went wrong');
      });

    return () => {
      cancelled = true;
    };
  }, []);

  if (loadError !== null && dashboard === null) {
    return (
      <main className="page">
        <div className="card">
          <h1>We could not load the submissions</h1>
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
          <p className="lede">Loading submissions…</p>
        </div>
      </main>
    );
  }

  return <SubmissionsBody dashboard={dashboard} />;
}

/**
 * The list, given a payload.
 *
 * Split from the component above for the reason `DashboardBody` records: the shell owns *when* to
 * fetch, and this owns what the page looks like — which keeps the rendering a pure function of its
 * input, and checkable without a browser.
 *
 * The cards are the same treatment as the dashboard's recent list, deliberately: the two views show
 * the same records, and a staff member who learns what a card looks like on one page should not
 * have to learn a second design on the other.
 */
export function SubmissionsBody({ dashboard }: { dashboard: DashboardPayload }) {
  const { recentSubmissions } = dashboard;

  return (
    <StaffLayout activeItem="submissions" title="Submissions">
      <div className="card">
        <h2>All submissions</h2>
        <p className="hint">
          Open any of these to see the full record, including the Student Problems responses that are
          never shown to students. Opening one is recorded in the server log (Section 13).
        </p>

        {recentSubmissions.length === 0 ? (
          <p className="muted">No submissions yet.</p>
        ) : (
          /*
            The card is the `<Link>` itself — one focusable, keyboard-operable target that can be
            opened in a new tab — rather than a `<div onClick>` around a separate link.
          */
          <div className="submission-grid">
            {recentSubmissions.map((submission) => (
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
          Said plainly whenever the list is full, because a staff member counting cards against the
          dashboard's "Started" figure would otherwise think records were missing.
        */}
        {recentSubmissions.length >= 25 && (
          <p className="hint">Showing the 25 most recent. Export the data for the full set.</p>
        )}
      </div>
    </StaffLayout>
  );
}
