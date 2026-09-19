import { useEffect, useRef } from 'react';
import { DashboardPage } from './pages/staff/DashboardPage';
import { LoginPage } from './pages/staff/LoginPage';
import { SubmissionDetailPage } from './pages/staff/SubmissionDetailPage';
import { SubmissionsPage } from './pages/staff/SubmissionsPage';
import { AssessmentPage } from './pages/student/AssessmentPage';
import { EntryPage } from './pages/student/EntryPage';
import { ReportPage } from './pages/student/ReportPage';
import { ThemeToggle } from './components/ThemeToggle';
import { Link, SUBMISSION_DETAIL_PATTERN, matchPath, usePathname } from './router';

/**
 * The application root, and the route table (ARCHITECTURE Section 4 — `App.tsx # Router`).
 *
 * The paths are ARCHITECTURE Section 9's, matched exactly and by hand. Two properties of that
 * table shape this file:
 *
 * - **There is no route that names a submission.** `/report` takes no id and neither does
 *   `/assessment`; the session is the only thing that says whose work it is (NFR-SEC-009). Nothing
 *   here — and nothing that could be added here — turns a submission into a URL.
 * - **A path is not an authorization.** Every route below renders a page; the page's own request to
 *   the API is what is refused if there is no valid session, and each page decides what to do about
 *   that refusal. The SPA has no authority to grant, so it is not asked for any.
 *
 * Every path in that table now has a page: `/assessment` arrived in T4.3.2, `/report` in T5.3.2, and
 * the staff pages in E8. An unmatched path is therefore a genuine mistake rather than a page that
 * has not been built, and `NotFound` says so.
 */
/**
 * What each route is called, for the browser tab and the back-button history.
 *
 * Indexed by the same literal paths the `switch` below matches, so a route and its name are written
 * once each and sit next to each other. The two paths that carry a value — the submission detail and
 * anything unrecognised — are not in the table because a `Record` cannot express them; `titleFor`
 * handles both.
 */
const ROUTE_TITLES: Record<string, string> = {
  '/': 'English assessment',
  '/assessment': 'Assessment',
  '/report': 'Your report',
  '/staff/login': 'Staff login',
  '/staff/dashboard': 'Assessment dashboard',
  '/staff/submissions': 'Submissions',
};

/** The document title for a pathname — always suffixed, so a tab is identifiable at a glance. */
function titleFor(pathname: string): string {
  const title = ROUTE_TITLES[pathname];

  if (title !== undefined) return `${title} · Lexora`;
  if (matchPath(SUBMISSION_DETAIL_PATTERN, pathname) !== null) return 'Submission · Lexora';

  return 'Page not found · Lexora';
}

/**
 * Announces a route change: the tab's name, and where the keyboard is.
 *
 * ## Why this is needed at all
 *
 * This router swaps a subtree; it does not load a document. So nothing the browser does on a real
 * navigation happens here — the title stays at whatever `index.html` set, and focus stays on
 * whatever element the reader activated, which has usually just been unmounted. The visible result
 * is a page that looks new but is silent: a screen reader announces nothing, and every entry in the
 * browser's history carries the same name.
 *
 * ## Why it focuses rather than only setting the title
 *
 * A title is read when a page *loads*, which is not what happens here. Moving focus to the arriving
 * page's heading is what makes assistive technology read it — the heading is the first thing it
 * encounters in the new content. `main` is the fallback for the routes whose heading does not exist
 * until their data arrives (the assessment and the report both render a loading shell first);
 * focusing nothing would leave focus on the document body and announce nothing at all.
 *
 * `preventScroll` matters: `navigate` has already put the window at the top of the new route, and a
 * focus that scrolled would undo it.
 *
 * The `tabindex="-1"` is applied rather than rendered, and is left in place — the element is a
 * focus target, not a control, and `styles.css` suppresses the ring for exactly this case. Adding
 * it in markup would mean adding it to every page for a concern none of them own.
 */
function useRouteAnnouncement(pathname: string): void {
  /*
    The first render is a page load, not a navigation.

    A document the browser loaded has already announced itself: it has a title in the tab, the
    screen reader starts at the top, and — where a form is the whole point of the screen — the page
    may have deliberately put the cursor in the first field. Moving focus to the heading on mount
    would undo that, and would do it on every reload.
  */
  const isFirstRender = useRef(true);

  useEffect(() => {
    document.title = titleFor(pathname);

    if (isFirstRender.current) {
      isFirstRender.current = false;
      return;
    }

    const frame = window.requestAnimationFrame(() => {
      const main = document.querySelector('main');
      if (main === null) return;

      const target: HTMLElement = main.querySelector('h1') ?? main;
      target.setAttribute('tabindex', '-1');
      target.focus({ preventScroll: true });
    });

    return () => window.cancelAnimationFrame(frame);
  }, [pathname]);
}

export function App() {
  const pathname = usePathname();

  useRouteAnnouncement(pathname);

  // The one route Section 9's table fixes that a `switch` cannot express: it carries a submission
  // id, and a `switch` compares whole strings. Tried before the switch rather than inside it,
  // because a `case` cannot match a family of paths — and left as one explicit pattern rather than a
  // routing table, because there is exactly one such route and a table for one entry would be a
  // structure to maintain that answers nothing.
  //
  // The pattern lives in `router.tsx` beside `submissionDetailPath`, which the dashboard uses to
  // build these links, so the route and the link are one string rather than two that agree today.
  const submissionDetail = matchPath(SUBMISSION_DETAIL_PATTERN, pathname);
  if (submissionDetail?.submissionId !== undefined) {
    return <SubmissionDetailPage submissionId={submissionDetail.submissionId} />;
  }

  switch (pathname) {
    case '/':
      return <EntryPage />;

    case '/assessment':
      return <AssessmentPage />;

    case '/report':
      return <ReportPage />;

    case '/staff/login':
      return <LoginPage />;

    case '/staff/dashboard':
      return <DashboardPage />;

    case '/staff/submissions':
      return <SubmissionsPage />;

    default:
      return <NotFound pathname={pathname} />;
  }
}

/**
 * The dead end, with two ways out of it.
 *
 * `NotBuiltYet` used to live here — a placeholder for routes Section 9 fixed before their pages
 * existed. Every one of those pages is now built, so nothing could render it; it has been removed
 * rather than kept as a standing invitation to route around a page that is missing.
 *
 * Two exits rather than one, because there are two reasons to arrive here and they want different
 * things. A mistyped address wants the page the reader was aiming for, which is usually one step
 * back through their own history; a stale or shared link wants a known-good starting point. Offering
 * only the second makes the first reader retype an address they already had.
 */
function NotFound({ pathname }: { pathname: string }) {
  return (
    <main className="page page--toggle">
      <ThemeToggle variant="floating" />
      <div className="card">
        <h1>Page not found</h1>
        <p className="lede">There is nothing at {pathname}.</p>
        <p className="hint">
          The address may have been mistyped, or it may be a link from an older version. Nothing has
          gone wrong with your work.
        </p>
        <div className="button-row">
          <button type="button" className="secondary" onClick={() => window.history.back()}>
            Go back
          </button>
          <Link to="/">Back to the start</Link>
        </div>
      </div>
    </main>
  );
}
