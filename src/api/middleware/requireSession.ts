import type { RequestHandler } from 'express';
import { getStaffSession, getStudentSession } from '../../auth/session.ts';

/**
 * The one implementation behind `requireStaffSession` and `requireStudentSession` (T3.1.3).
 *
 * Both guards ask the same question — "does this request carry a live session of my kind?" — and
 * differ only in which kind. Writing that question twice would mean two places to keep in step,
 * and the whole point of ARCHITECTURE Section 9's "neither session type grants access to the
 * other's routes" is that the two answers can never drift apart.
 *
 * ## Why this is authorization and not authentication
 *
 * The guard does not check *who* the caller is, or whether the submission exists, or whether it is
 * still a draft. It only refuses a request that is not authenticated as the required kind. Every
 * finer rule belongs to the route: `PATCH /api/student/draft` re-checks `status='draft'` on the
 * write itself (Section 12), because a session issued while a draft was open must not authorize a
 * write after it has been submitted.
 *
 * ## On the response
 *
 * A flat JSON body with a generic message, per Section 11 — an unauthenticated caller learns only
 * that they are unauthenticated. A *valid* session of the wrong type is refused with the same 401
 * as no session at all: from a staff route's point of view a student is simply not staff, and
 * saying more would tell a student that a staff route exists.
 *
 * The frontend owns the redirect to the entry/login page (Section 9); an API endpoint answers with
 * a status, and the SPA's fetch wrapper decides where to send the browser.
 */

/** Which session a guard demands. */
export type SessionRequirement = 'staff' | 'student';

/**
 * The message every refusal carries. Deliberately says nothing about which session was expected.
 *
 * Exported because a route can legitimately have to answer 401 for a reason the guard cannot see —
 * a student session naming a submission row that no longer exists, for instance. The remedy is
 * identical (re-verify identity and come back), so it is reported identically, from one definition
 * rather than a second copy of the string that could drift.
 */
export const UNAUTHORIZED_MESSAGE = 'Authentication required';

/**
 * Builds a guard that rejects any request not carrying a live session of `requirement`.
 *
 * Apply it per route, on a router that already mounts the matching session middleware — not
 * globally. A guard mounted where its session middleware is not will reject every request, which
 * is at least a loud failure; the reverse (middleware mounted, guard forgotten) is the one to
 * watch for in review.
 */
export function requireSession(requirement: SessionRequirement): RequestHandler {
  return function requireSessionMiddleware(req, res, next) {
    const session = requirement === 'staff' ? getStaffSession(req) : getStudentSession(req);

    if (!session) {
      res.status(401).json({ error: UNAUTHORIZED_MESSAGE });
      return;
    }

    next();
  };
}
