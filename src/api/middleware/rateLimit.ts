import type { RequestHandler } from 'express';

/**
 * Per-IP rate limiting for the two public credential-guessing endpoints (T3.3.3).
 *
 * ARCHITECTURE Section 13: `POST /api/session/student-verify` and `POST /api/staff/login` "are
 * rate-limited per IP (e.g., a simple in-memory or Postgres-backed counter — no external
 * rate-limiting service needed at this traffic volume)". This is the in-memory counter, and it is
 * hand-rolled for the reason Section 2 gives: the dependency list is closed, and a rate limiter is
 * not on it.
 *
 * ## Fixed window, not a token bucket
 *
 * A fixed window is the simplest thing that blunts online guessing, and its known weakness — a
 * burst across a window boundary can reach twice the limit — is irrelevant here. The threat is an
 * automated script making thousands of attempts, not one that carefully straddles a 15-minute
 * boundary to make 120 instead of 60.
 *
 * ## The thresholds, and why they are not tighter
 *
 * The cohort is a university class, and a class is exactly the thing that shares one address: a
 * computer lab behind a NAT, or a campus proxy, presents every student in the room as a single IP.
 * A per-IP limit tight enough to be interesting against a brute-force script would then lock out
 * an entire lab the moment a session started, which is a far worse outcome than the guessing it
 * would prevent — a student who cannot begin the assessment at all.
 *
 * So the numbers are set to be comfortably above any legitimate burst while still capping an
 * attacker at a rate that makes online guessing pointless:
 *
 * - **student-verify: 60 per 15 minutes.** Every attempt must match a cohort code, a roll number,
 *   *and* a name (Section 13), so guessing is already three-dimensional; 60 attempts is a ceiling
 *   of 5,760 a day, against a search space no script finishes.
 * - **staff-login: 20 per 15 minutes.** Staff passwords are bcrypt-hashed at cost 12, so each
 *   attempt already costs an attacker a quarter-second of server time and returns nothing usable.
 *   Two staff members do not legitimately log in twenty times in a quarter of an hour.
 *
 * Successful requests count too, which is what makes this a plain request limiter rather than
 * something that has to be told how the request turned out. At these thresholds the difference
 * never matters to a real user.
 *
 * ## Behind a proxy
 *
 * `req.ip` is the socket address unless Express is told to trust the proxy hop. On Render, without
 * `app.set('trust proxy', 1)` (T9.4.1), every request arrives from the proxy and the whole pilot
 * shares one counter — the same setting the Secure cookie attribute depends on, documented in
 * `src/auth/session.ts`.
 */

/** One window's length, used by both endpoints. */
const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;

/** Student verification attempts allowed per IP per window. */
export const STUDENT_VERIFY_RATE_LIMIT = 60;

/** Staff login attempts allowed per IP per window. */
export const STAFF_LOGIN_RATE_LIMIT = 20;

/**
 * The refusal. Generic, per Section 11 — it says the caller has made too many attempts and nothing
 * about whether any of them were close.
 */
const TOO_MANY_REQUESTS_MESSAGE = 'Too many attempts — please try again later';

/** Above this many tracked addresses, expired windows are swept on the next new one. */
const SWEEP_THRESHOLD = 1000;

type Window = { count: number; resetAt: number };

export type RateLimitOptions = {
  /** Requests permitted per address within one window. */
  limit: number;
  windowMs: number;
};

/**
 * Drops windows that have already expired.
 *
 * Without this the map would grow once per distinct address and never shrink — slow, but unbounded
 * is unbounded. Sweeping only when the map is already large keeps the common path O(1) and makes
 * this cost proportional to the entries it removes.
 */
function sweepExpired(windows: Map<string, Window>, now: number): void {
  if (windows.size < SWEEP_THRESHOLD) return;

  for (const [key, window] of windows) {
    if (window.resetAt <= now) windows.delete(key);
  }
}

/**
 * Every counter this module has built, so a test can clear them (see `resetRateLimits`).
 *
 * Populated by `rateLimit()` below. In the application that is two entries, created once at module
 * load for the two production endpoints; the extra entries only ever come from tests that build
 * their own limiter.
 */
const counters: Map<string, Window>[] = [];

/**
 * Builds a limiter with its own counter.
 *
 * Each call gets its own `Map`, so two endpoints sharing a policy still keep separate budgets — a
 * burst of student verifications must not consume a staff member's login attempts.
 */
export function rateLimit(options: RateLimitOptions): RequestHandler {
  const windows = new Map<string, Window>();
  counters.push(windows);

  return function rateLimitMiddleware(req, res, next) {
    const now = Date.now();
    const key = req.ip ?? 'unknown';

    let window = windows.get(key);

    if (!window || window.resetAt <= now) {
      window = { count: 0, resetAt: now + options.windowMs };
      windows.set(key, window);
      sweepExpired(windows, now);
    }

    window.count += 1;

    if (window.count > options.limit) {
      // Tells a well-behaved client when to come back, rather than leaving it to retry blindly.
      res.set('Retry-After', String(Math.max(1, Math.ceil((window.resetAt - now) / 1000))));
      res.status(429).json({ error: TOO_MANY_REQUESTS_MESSAGE });
      return;
    }

    next();
  };
}

/**
 * Forgets every request counted so far, so each test starts with a full budget.
 *
 * ## Why this exists
 *
 * The counters are per-process and module-level, which is the production design: one instance, one
 * allowance per address (Section 13's "simple in-memory counter" — no external rate-limiting
 * service at this traffic volume). The consequence is that a *test file* shares one budget across
 * every test in it, because a test file is one process and one module graph. A file that verifies
 * an identity more than the limit allows — which is easy to reach, since each integration test
 * builds its own rows and therefore its own session — starts failing with 429s that have nothing to
 * do with what it is asserting. That is a false failure, and it reads like an authentication bug.
 *
 * Clearing between tests is the same principle as truncating the database between tests: each test
 * begins from a known state. It hides nothing, because the limiter's own behaviour is proven
 * elsewhere against limits small enough to exhaust deliberately
 * (`src/api/middleware/rateLimit.test.ts`, `src/api/rateLimit.routes.test.ts`) — and this function
 * does not raise a limit, shorten a window, or make the middleware skippable. It is not reachable
 * over HTTP and is called from exactly one place: the test fixture.
 *
 * Exported for tests to read, like the two limits above.
 */
export function resetRateLimits(): void {
  for (const windows of counters) windows.clear();
}

/** Applied to `POST /api/session/student-verify`. */
export const studentVerifyRateLimit: RequestHandler = rateLimit({
  limit: STUDENT_VERIFY_RATE_LIMIT,
  windowMs: RATE_LIMIT_WINDOW_MS,
});

/** Applied to `POST /api/staff/login`. */
export const staffLoginRateLimit: RequestHandler = rateLimit({
  limit: STAFF_LOGIN_RATE_LIMIT,
  windowMs: RATE_LIMIT_WINDOW_MS,
});
