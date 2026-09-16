import express from 'express';
import { z } from 'zod';
import { clearStaffSession, issueStaffSession, staffSessionMiddleware } from '../auth/session.ts';
import { getStaffAuthService } from '../domain/staff/StaffAuthService.ts';
import { staffLoginRateLimit } from './middleware/rateLimit.ts';
import { requireStaffSession } from './middleware/requireStaffSession.ts';
import { requiredText, validateBody } from './middleware/validateBody.ts';

/**
 * The staff router — login, logout, and (from E8) the dashboard, submission detail, and CSV export
 * (ARCHITECTURE Section 10, Section 18).
 *
 * `staffSessionMiddleware` is mounted on this router and `requireStaffSession` on each route that
 * needs it, rather than a session guard across the whole app. Section 9 requires that: the staff
 * and student access boundaries are separate, and a guard mounted globally is one refactor away
 * from protecting — or failing to protect — both at once. Login is the one route here that is
 * deliberately public, which is exactly why the guard is per route and not a router-level `use`.
 *
 * This file is also where staff data-access logging will live (Section 13, E8). Nothing here writes
 * a log line yet because nothing here reads a student record.
 */

/**
 * The refusal for a failed login.
 *
 * Deliberately does not say *which* of the two was wrong. `StaffAuthService` already refuses to
 * distinguish a wrong password from an email with no account behind it, and this message is the
 * other half of that: the response must not put back the distinction the service was careful not
 * to make.
 */
const INVALID_CREDENTIALS_MESSAGE = 'Invalid email or password';

const staffLoginBodySchema = z.object({
  email: requiredText('email'),
  password: requiredText('password'),
});

export const staffRouter = express.Router();

// Mounted before the routes so that login and logout can both read and write the cookie. Public
// routes need this as much as protected ones: issuing a session requires the session middleware to
// be in play.
staffRouter.use(staffSessionMiddleware);

/**
 * Exchanges email and password for a staff session (FR-STAFF-001).
 *
 * On success the session cookie is the response's whole payload — there is one permission level in
 * the MVP (FR-STAFF-003), so there is nothing else for the client to learn or carry. On failure the
 * caller is left exactly as authenticated as they arrived: no cookie is issued.
 *
 * `staffLoginRateLimit` runs first (T3.3.3), so an attacker burning attempts is stopped before any
 * password is verified — every blocked request is one bcrypt comparison the server does not spend.
 */
staffRouter.post('/login', staffLoginRateLimit, validateBody(staffLoginBodySchema), async (req, res, next) => {
  try {
    const authentication = await getStaffAuthService().authenticate(
      req.body.email,
      req.body.password,
    );

    if (authentication.outcome !== 'authenticated') {
      res.status(401).json({ error: INVALID_CREDENTIALS_MESSAGE });
      return;
    }

    issueStaffSession(req, authentication.staffUserId);

    res.json({ ok: true });
  } catch (error) {
    // Express 4 does not forward rejections from an async handler on its own.
    next(error);
  }
});

/**
 * Ends the staff session.
 *
 * Requires a session (Section 10), so a caller who is not logged in gets the same 401 any other
 * staff route would give them rather than a silent success. `clearStaffSession` expires the cookie
 * on the way out, so the client is not left holding a value it will keep presenting.
 */
staffRouter.post('/logout', requireStaffSession, (req, res) => {
  clearStaffSession(req);

  res.json({ ok: true });
});
