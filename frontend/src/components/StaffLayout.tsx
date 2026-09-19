import { LayoutDashboard, ListChecks } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link } from '../router';
import { ThemeToggle } from './ThemeToggle';

/**
 * The staff application shell (spec Section 5 — "fixed, collapsible sidebar for primary
 * navigation").
 *
 * Both staff pages (`DashboardPage`, `SubmissionDetailPage`) render their own `<main>` content
 * inside this, rather than each re-implementing the sidebar and topbar. `activeItem` says which
 * sidebar entry is "current" — the submission detail page is reached *from* the dashboard, but it
 * still belongs under "Submissions" while open, so that item stays highlighted there too.
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

        <div className="staff-sidebar-footer">Lexora pilot</div>
      </nav>

      <div className="staff-main">
        <div className="staff-topbar">
          <h1>{title}</h1>
          <ThemeToggle />
        </div>

        <div className="staff-content">{children}</div>
      </div>
    </div>
  );
}
