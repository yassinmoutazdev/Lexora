import { LayoutDashboard, ListChecks, LogOut } from 'lucide-react';
import { useState } from 'react';
import type { ReactNode } from 'react';
import { staffLogout } from '../api/client';
import { Link, navigate } from '../router';
import { ThemeToggle } from './ThemeToggle';

/**
 * The staff application shell (spec Section 5 — "fixed, collapsible sidebar for primary
 * navigation").
 *
 * All three staff pages (`DashboardPage`, `SubmissionsPage`, `SubmissionDetailPage`) render their
 * own content inside this, rather than each re-implementing the sidebar and topbar. `activeItem`
 * says which sidebar entry is "current" — the submission detail page is reached *from* the
 * dashboard, but it still belongs under "Submissions" while open, so that item stays highlighted
 * there too.
 *
 * It also owns `SignOut` (below), which is the shell's only account control. That placement is the
 * point: the control is a property of being in the staff area, not of any one page, so a page cannot
 * be built that forgets to offer a way out.
 *
 * The two loading and error states each staff page renders are expected to render *inside* this too.
 * They did not previously, which meant the sidebar vanished exactly when something had gone wrong —
 * see the note on `DashboardPage`'s shell states.
 *
 * This patch does not build the collapse interaction itself (the spec only fixes that the sidebar
 * *can* collapse, not when); the class is named so that behavior is a follow-up rather than a
 * rename.
 */
export function StaffLayout({
  activeItem,
  title,
  children,
}: {
  activeItem: 'dashboard' | 'submissions';
  title: string;
  children: ReactNode;
}) {
  return (
    <div className="staff-shell">
      <nav className="staff-sidebar" aria-label="Staff navigation">
        <div className="brand">Lexora</div>

        <Link
          to="/staff/dashboard"
          className="staff-nav-item"
          aria-current={activeItem === 'dashboard' ? 'true' : undefined}
        >
          <LayoutDashboard aria-hidden="true" />
          Dashboard
        </Link>
        <Link
          to="/staff/submissions"
          className="staff-nav-item"
          aria-current={activeItem === 'submissions' ? 'true' : undefined}
        >
          <ListChecks aria-hidden="true" />
          Submissions
        </Link>

        <div className="staff-sidebar-footer">
          <SignOut />
          <p className="staff-footer-note">Lexora pilot</p>
        </div>
      </nav>

      {/*
        A real `<main>` landmark, not a `<div>`.

        Two things depend on it. A screen-reader user navigates by landmark, and the staff pages
        were the only ones in the application without one — every student page has had a `<main>`
        since it was written. And `useRouteAnnouncement` moves focus into `main` (or its heading) on
        every route change, so without this element nothing was announced anywhere in the staff area:
        it queried for a landmark that did not exist and quietly did nothing.
      */}
      <main className="staff-main">
        <div className="staff-topbar">
          <h1>{title}</h1>
          <ThemeToggle />
        </div>

        <div className="staff-content">{children}</div>
      </main>
    </div>
  );
}

/**
 * The way out of the staff area.
 *
 * `POST /api/staff/logout` has existed and been integration-tested since T3.3.2, but nothing in the
 * SPA ever called it and the shell offered no control — so a staff session, which lasts eight hours
 * absolute (Section 9), could not be ended except by clearing cookies by hand. NFR-SEC-010 asks that
 * staff access be held more tightly than student access; a session nobody can close was the one
 * place the interface contradicted that.
 *
 * `replace` on the way out, for the reason `LoginPage` gives about the way in: the shell behind them
 * is one they have just given up the right to see, and stepping back into it would only produce a
 * `401` and a second redirect.
 *
 * The failure state is inline rather than a notice at the top of the page, because the control that
 * failed is the one the reader is looking at. Signing out is also the one action where a silent
 * failure is a security problem rather than an inconvenience: a staff member who believes they have
 * signed out and has not is worse off than one who is told plainly to try again. So the message says
 * the session is still open, which is the fact that matters.
 */
function SignOut() {
  const [signingOut, setSigningOut] = useState(false);
  const [failed, setFailed] = useState(false);

  async function handleSignOut() {
    setSigningOut(true);
    setFailed(false);

    try {
      await staffLogout();
      navigate('/staff/login', { replace: true });
    } catch {
      setFailed(true);
      setSigningOut(false);
    }
  }

  return (
    <div className="staff-account">
      <button
        type="button"
        className="staff-signout"
        onClick={() => void handleSignOut()}
        disabled={signingOut}
      >
        <LogOut aria-hidden="true" />
        {signingOut ? 'Signing out…' : 'Sign out'}
      </button>

      {failed && (
        <p className="staff-signout-error" role="alert">
          We could not sign you out — you are still signed in. Try again.
        </p>
      )}
    </div>
  );
}
