import {
  LayoutDashboard,
  ListChecks,
  LogOut,
  PanelLeftClose,
  PanelLeftOpen,
  Users,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { staffLogout } from '../api/client';
import { Link, navigate } from '../router';
import { ThemeToggle } from './ThemeToggle';

/** The stored collapse preference's key, following `ThemeToggle`'s `lexora-theme` convention. */
const SIDEBAR_COLLAPSED_STORAGE_KEY = 'lexora-staff-sidebar-collapsed';

function readStoredCollapsed(): boolean {
  if (typeof window === 'undefined') return false;

  return window.localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY) === 'true';
}

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
 * ## Collapse
 *
 * The sidebar can now actually collapse — the earlier version fixed only the class name for this,
 * not the interaction (see the git history of this comment). The toggle lives in the topbar rather
 * than inside the sidebar itself, because collapsing the sidebar is exactly the moment its own
 * controls become unreachable; a button that only exists inside the thing it opens cannot reopen it.
 * `.staff-content` needs no explicit resizing rule for this: it is `flex: 1` inside `.staff-shell`,
 * so it fills whatever width `.staff-sidebar` gives up.
 *
 * The preference persists in `localStorage`, same mechanism and reasoning as `ThemeToggle`'s theme
 * choice, so it survives a reload and is not something each page has to thread through as state.
 * Read here rather than by the caller: a route change back to a staff page should not silently
 * re-expand a sidebar the person collapsed.
 */
export function StaffLayout({
  activeItem,
  title,
  children,
}: {
  activeItem: 'dashboard' | 'submissions' | 'cohorts';
  title: string;
  children: ReactNode;
}) {
  const [collapsed, setCollapsed] = useState<boolean>(readStoredCollapsed);

  useEffect(() => {
    window.localStorage.setItem(SIDEBAR_COLLAPSED_STORAGE_KEY, String(collapsed));
  }, [collapsed]);

  /*
    Signing out is owned here rather than inside the button that starts it.

    The failure has to be visible whether or not the sidebar is collapsed, and a message rendered
    inside a container that can animate to `width: 0` with `overflow: hidden` is a message that can
    be hidden by the thing it is warning about. Lifting the state puts the notice in the content
    area, which the collapse cannot reach — and puts the action itself somewhere a second control
    (the notice's own "Try again") can call it too, without two copies of the request.
  */
  const [signingOut, setSigningOut] = useState(false);
  const [signOutFailed, setSignOutFailed] = useState(false);

  async function handleSignOut() {
    setSigningOut(true);
    setSignOutFailed(false);

    try {
      await staffLogout();
      navigate('/staff/login', { replace: true });
    } catch {
      setSignOutFailed(true);
      setSigningOut(false);
    }
  }

  return (
    <div className={collapsed ? 'staff-shell staff-shell--collapsed' : 'staff-shell'}>
      <nav
        id="staff-sidebar"
        className="staff-sidebar"
        aria-label="Staff navigation"
        aria-hidden={collapsed}
      >
        <div className="brand">Lexora</div>

        <Link
          to="/staff/dashboard"
          className="staff-nav-item"
          aria-current={activeItem === 'dashboard' ? 'true' : undefined}
          tabIndex={collapsed ? -1 : undefined}
        >
          <LayoutDashboard aria-hidden="true" />
          Dashboard
        </Link>
        <Link
          to="/staff/submissions"
          className="staff-nav-item"
          aria-current={activeItem === 'submissions' ? 'true' : undefined}
          tabIndex={collapsed ? -1 : undefined}
        >
          <ListChecks aria-hidden="true" />
          Submissions
        </Link>
        <Link
          to="/staff/cohorts"
          className="staff-nav-item"
          aria-current={activeItem === 'cohorts' ? 'true' : undefined}
          tabIndex={collapsed ? -1 : undefined}
        >
          <Users aria-hidden="true" />
          Cohorts
        </Link>

        <div className="staff-sidebar-footer">
          <SignOutButton collapsed={collapsed} signingOut={signingOut} onSignOut={handleSignOut} />
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
          <button
            type="button"
            className="sidebar-toggle"
            onClick={() => setCollapsed((value) => !value)}
            aria-expanded={!collapsed}
            aria-controls="staff-sidebar"
          >
            {collapsed ? <PanelLeftOpen aria-hidden="true" /> : <PanelLeftClose aria-hidden="true" />}
            <span className="sr-only">{collapsed ? 'Show sidebar' : 'Hide sidebar'}</span>
          </button>
          <h1>{title}</h1>
          <ThemeToggle />
        </div>

        <div className="staff-content">
          {/*
            Here, not in the sidebar. This is the one message in the shell that must survive the
            sidebar being collapsed, and it is where the reader is already looking for the page's
            own content rather than three levels into a nav rail.
          */}
          {signOutFailed && (
            <div className="notice" role="alert">
              <p>We could not sign you out — you are still signed in.</p>
              <div className="button-row">
                <button
                  type="button"
                  className="secondary"
                  onClick={() => void handleSignOut()}
                  disabled={signingOut}
                >
                  {signingOut ? 'Signing out…' : 'Try again'}
                </button>
              </div>
            </div>
          )}

          {children}
        </div>
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
 * ## Presentational, and why
 *
 * This renders the button and nothing else — it owns no request and no failure state. Both live in
 * `StaffLayout`, because the failure has to be shown outside the sidebar: a message inside a
 * container that animates to `width: 0` with `overflow: hidden` can be hidden by the very thing it
 * is warning about, and a staff member who collapsed the sidebar after a failed sign-out would be
 * left with an open session and nothing on screen saying so.
 *
 * Signing out is also the one action here where a silent failure is a security problem rather than
 * an inconvenience, which is why the notice keeps an explicit "Try again" rather than only stating
 * the problem.
 */
function SignOutButton({
  collapsed,
  signingOut,
  onSignOut,
}: {
  collapsed: boolean;
  signingOut: boolean;
  onSignOut: () => Promise<void>;
}) {
  return (
    <div className="staff-account">
      <button
        type="button"
        className="staff-signout"
        onClick={() => void onSignOut()}
        disabled={signingOut}
        tabIndex={collapsed ? -1 : undefined}
      >
        <LogOut aria-hidden="true" />
        {signingOut ? 'Signing out…' : 'Sign out'}
      </button>
    </div>
  );
}
