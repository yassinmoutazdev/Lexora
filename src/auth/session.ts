import cookieSession from 'cookie-session';
import type { Request, RequestHandler } from 'express';
import { env } from '../config/env.ts';

/**
 * The two independent cookie sessions (T3.1.1), and nothing else.
 *
 * ARCHITECTURE Section 9 defines exactly two sessions — a longer-lived staff session and a
 * short-lived student one — and states that *neither grants access to the other's routes*. This
 * module owns how each is stored and read; `requireStaffSession` / `requireStudentSession`
 * (T3.1.3) own when each is demanded, and the domain services (T3.2.1, T3.3.1) own who may be
 * given one. There is deliberately no third concept here.
 *
 * ## Why two `cookie-session` instances, and why they are mounted per router
 *
 * `cookie-session` keeps its state in a signed cookie and publishes it as `req.session`. Two
 * instances stacked on one request therefore *collide*: the second defines `req.session` over the
 * first's accessor, and the first silently stops being readable. That is not a hypothetical — it
 * is why ARCHITECTURE Section 9 requires this middleware to be applied per router rather than
 * globally, "so the two access boundaries can never be accidentally merged".
 *
 * The collision is turned into a loud error instead of a silent merge: each middleware tags the
 * request with its kind and refuses to run if another has already tagged it. A single request can
 * never carry both sessions, which makes cross-session access structurally impossible rather than
 * a discipline the route table has to maintain.
 *
 * ## Lifetimes
 *
 * - **Staff — absolute 8 hours from issuance.** Staff return to the dashboard repeatedly, so the
 *   session is generous; it is renewed only by logging in again, never merely by use.
 * - **Student — 30 minutes of inactivity.** Sliding, not absolute: `cookie-session` only rewrites
 *   its cookie when the session has changed, so the student middleware stamps a `lastSeenAt` on
 *   every request carrying a live session. That makes the session "changed", which re-issues the
 *   cookie with a full 30-minute window. An absolute 30 minutes would log a student out mid-essay,
 *   which the PRD's free-writing task (Section 9.4) makes a normal occurrence rather than an edge
 *   case.
 *
 * ## Cookie attributes (Section 13: httpOnly, Secure, SameSite=Lax)
 *
 * `httpOnly` and `sameSite: 'lax'` are set explicitly below. `secure` is deliberately **left
 * unset**, which makes the underlying `cookies` library mark the cookie Secure exactly when the
 * request arrived over TLS (`req.protocol === 'https'`). That is the same rule a browser applies,
 * and it is the only setting that is correct in both environments:
 *
 *   - forcing `secure: true` makes `cookies.set()` throw 'Cannot send secure cookie over
 *     unencrypted connection' on any plain-HTTP request, which would 500 every login locally and
 *     on any deployment where Express does not see the TLS termination;
 *   - forcing `secure: false` would drop the attribute in production, where it is the point.
 *
 * On Render, TLS terminates at the proxy, so `req.protocol` reports `https` only once Express is
 * told to trust that hop (`app.set('trust proxy', 1)`). That setting belongs to the deployment
 * task (T9.4.1); it is also what makes per-IP rate limiting (T3.3.3) see a student's real address
 * rather than the proxy's.
 *
 * ## What is *not* here
 *
 * The cookie payload is signed, not encrypted, so a student can read their own `submissionId` out
 * of their own cookie. That is not a leak of anyone else's data, and it grants nothing: forging a
 * different value requires `SESSION_SECRET`, and ARCHITECTURE Section 9 provides no ID-bearing
 * route to spend a guessed id on.
 */

/** The staff session cookie. Distinct from the student cookie by name, not by shape. */
export const STAFF_SESSION_COOKIE = 'lexora_staff_session';

/** The student session cookie. */
export const STUDENT_SESSION_COOKIE = 'lexora_student_session';

/** Staff sessions last 8 hours from issuance (Section 9). */
export const STAFF_SESSION_TTL_MS = 8 * 60 * 60 * 1000;

/** Student sessions survive 30 minutes without a request (Section 9). */
export const STUDENT_SESSION_IDLE_TTL_MS = 30 * 60 * 1000;

/** What a live staff session asserts: which staff user this is. */
export type StaffSession = {
  staffUserId: string;
};

/** What a live student session asserts: exactly one submission, and nothing else (Section 1). */
export type StudentSession = {
  submissionId: string;
};

type SessionKind = 'staff' | 'student';

/**
 * Session payload keys.
 *
 * Declared as constants rather than open-coded strings because a typo in a string literal is
 * invisible to the compiler, and a typo here would mean "no session" — a silent 401 rather than a
 * build failure.
 */
const STAFF_USER_ID = 'staffUserId';
const SUBMISSION_ID = 'submissionId';

/**
 * Stamped on every request that carries a live student session, purely to make `cookie-session`
 * rewrite its cookie and so renew the idle window. See "Lifetimes" above.
 */
const STUDENT_LAST_SEEN_AT = 'lastSeenAt';

/**
 * Which session middleware has run for this request, if any.
 *
 * A symbol rather than a string so it cannot collide with an application field, and a property on
 * the request rather than a module-level map so it is scoped to exactly one request by
 * construction.
 */
const SESSION_KIND = Symbol('lexora.sessionKind');

type RequestWithSessionKind = Request & { [SESSION_KIND]?: SessionKind };

type SessionPayload = NonNullable<Request['session']>;

/**
 * Builds one session middleware.
 *
 * Both session types differ only in cookie name, lifetime, and whether use renews them, so they
 * are one implementation parameterised three ways rather than two that could drift apart.
 */
function createSessionMiddleware(config: {
  kind: SessionKind;
  cookieName: string;
  maxAgeMs: number;
  /**
   * Given the chance to modify the session on every request that has one, which is what renews a
   * sliding lifetime. Omitted for the staff session, whose lifetime is absolute.
   */
  refresh?: (session: SessionPayload) => void;
}): RequestHandler {
  // `keys` rather than `secret`: the same value, but in the form that leaves room for signing-key
  // rotation without a redeploy of this module.
  const handleCookieSession = cookieSession({
    name: config.cookieName,
    keys: [env.SESSION_SECRET],
    maxAge: config.maxAgeMs,
    httpOnly: true,
    sameSite: 'lax',
  });

  return function sessionMiddleware(req, _res, next) {
    const mounted = (req as RequestWithSessionKind)[SESSION_KIND];

    if (mounted) {
      next(
        new Error(
          `The staff and student session middleware both ran on one request (${mounted} then ` +
            `${config.kind}). Each is a separate cookie-session instance that defines ` +
            '`req.session`, so stacking them silently discards the outer session. Mount ' +
            '`staffSessionMiddleware` on the staff router and `studentSessionMiddleware` on the ' +
            'student routers — never globally (ARCHITECTURE Section 9).',
        ),
      );
      return;
    }

    (req as RequestWithSessionKind)[SESSION_KIND] = config.kind;

    handleCookieSession(req, _res, (error?: unknown) => {
      if (error) {
        next(error);
        return;
      }

      // Reading `req.session` here is what materialises it inside cookie-session so that writing
      // to it is picked up when the response headers are assembled.
      const session = req.session;
      if (config.refresh && session) config.refresh(session);

      next();
    });
  };
}

/** Mount on the staff router only (Section 9 — per router, never globally). */
export const staffSessionMiddleware: RequestHandler = createSessionMiddleware({
  kind: 'staff',
  cookieName: STAFF_SESSION_COOKIE,
  maxAgeMs: STAFF_SESSION_TTL_MS,
});

/** Mount on the student routers only (Section 9 — per router, never globally). */
export const studentSessionMiddleware: RequestHandler = createSessionMiddleware({
  kind: 'student',
  cookieName: STUDENT_SESSION_COOKIE,
  maxAgeMs: STUDENT_SESSION_IDLE_TTL_MS,
  refresh: (session) => {
    // Only a session that actually carries an identity is renewed. Renewing an empty one would
    // hand a cookie to a visitor who has not verified, and would renew a cleared session.
    if (typeof session[SUBMISSION_ID] === 'string') {
      session[STUDENT_LAST_SEEN_AT] = Date.now();
    }
  },
});

/**
 * Guards the write and clear paths against being used on the wrong router.
 *
 * Issuing a session is a grant of authority. If the matching middleware is not mounted, the write
 * would land on a plain request property, no cookie would ever be sent, and the failure would
 * present later as "the student is inexplicably logged out". Throwing here makes a mis-mounted
 * router a visible 500 at the moment it is exercised instead.
 *
 * Reads do not throw — see `readSession` — because "no session of this kind" is a legitimate
 * answer that `requireXSession` turns into a 401.
 */
function assertSessionKind(req: Request, expected: SessionKind): void {
  const actual = (req as RequestWithSessionKind)[SESSION_KIND];

  if (actual === expected) return;

  throw new Error(
    `Expected a ${expected} session on this request but found ${actual ?? 'none'}. ` +
      `${expected}SessionMiddleware must be mounted on this router before any route that ` +
      `issues or clears a ${expected} session (ARCHITECTURE Section 9).`,
  );
}

/**
 * Reads this request's session, or null when it holds none of the requested kind.
 *
 * Returning null for the *other* kind is the whole point: a valid staff session read as a student
 * session yields nothing, and vice versa. That is "neither session type grants access to the
 * other's routes" (Section 9) implemented at the point of reading, before any route can act on it.
 */
function readSession(req: Request, kind: SessionKind): SessionPayload | null {
  if ((req as RequestWithSessionKind)[SESSION_KIND] !== kind) return null;

  return req.session ?? null;
}

/** The staff session on this request, or null. */
export function getStaffSession(req: Request): StaffSession | null {
  const session = readSession(req, 'staff');
  const staffUserId = session?.[STAFF_USER_ID];

  // Shape-checked rather than trusted: a session object that exists but lacks the identity it is
  // supposed to carry is not a session, whatever its cookie says.
  return typeof staffUserId === 'string' ? { staffUserId } : null;
}

/** The student session on this request, or null. */
export function getStudentSession(req: Request): StudentSession | null {
  const session = readSession(req, 'student');
  const submissionId = session?.[SUBMISSION_ID];

  return typeof submissionId === 'string' ? { submissionId } : null;
}

/**
 * Grants a staff session and starts its 8 hours.
 *
 * Assigning a fresh object is also how an existing staff session is renewed: `cookie-session`
 * treats the new object as a change, so logging in again restarts the window.
 */
export function issueStaffSession(req: Request, staffUserId: string): void {
  assertSessionKind(req, 'staff');
  req.session = { [STAFF_USER_ID]: staffUserId };
}

/**
 * Grants a student session scoped to exactly one submission (Section 1 — the session authorizes
 * the assessment and the report for that submission, and nothing else).
 */
export function issueStudentSession(req: Request, submissionId: string): void {
  assertSessionKind(req, 'student');
  req.session = { [SUBMISSION_ID]: submissionId };
}

/** Ends the staff session. `cookie-session` deletes the cookie on the way out. */
export function clearStaffSession(req: Request): void {
  assertSessionKind(req, 'staff');
  req.session = null;
}

/** Ends the student session. */
export function clearStudentSession(req: Request): void {
  assertSessionKind(req, 'student');
  req.session = null;
}
