import { AssessmentPage } from './pages/student/AssessmentPage';
import { EntryPage } from './pages/student/EntryPage';
import { ReportPage } from './pages/student/ReportPage';
import { Link, usePathname } from './router';

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
 * Routes arrive with the Epics that build their pages. `/assessment` is T4.3.2 and `/report` is
 * T5.3.2; the staff pages are E8. Until a page exists, its path renders `NotBuiltYet` rather than a
 * 404, so that a link to a route the plan has already fixed reads as "not yet" instead of
 * "mistyped" — the entry page's Staff login link is the first such caller.
 */
export function App() {
  const pathname = usePathname();

  switch (pathname) {
    case '/':
      return <EntryPage />;

    case '/assessment':
      return <AssessmentPage />;

    case '/report':
      return <ReportPage />;

    case '/staff/login':
      return <NotBuiltYet title="Staff login" task="T8.3.2" />;

    default:
      return <NotFound pathname={pathname} />;
  }
}

/** A route Section 9 fixes but whose page a later task builds. */
function NotBuiltYet({ title, task }: { title: string; task: string }) {
  return (
    <main className="page">
      <div className="card">
        <h1>{title}</h1>
        <p className="lede">This page is not available yet.</p>
        <p className="muted">Built in {task}.</p>
        <Link to="/">Back to the start</Link>
      </div>
    </main>
  );
}

function NotFound({ pathname }: { pathname: string }) {
  return (
    <main className="page">
      <div className="card">
        <h1>Page not found</h1>
        <p className="lede">There is nothing at {pathname}.</p>
        <Link to="/">Back to the start</Link>
      </div>
    </main>
  );
}
