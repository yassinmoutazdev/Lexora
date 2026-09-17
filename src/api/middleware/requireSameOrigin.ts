import type { Request, RequestHandler } from 'express';

/**
 * Origin-checking for state-changing requests (T9.3.1) — the other half of ARCHITECTURE Section 13's
 * CSRF posture.
 *
 * Section 13: *"`SameSite=Lax` plus origin-checking on state-changing requests is sufficient here —
 * there is no cross-site embedding use case for this app, so a full CSRF-token scheme would be
 * unjustified complexity for this threat model."* That sentence names two mechanisms and the codebase
 * had one. `SameSite=Lax` has been set on both session cookies since T3.1.1; this is the other half,
 * and Section 13's own words are the reason it is a header check rather than a token: the document
 * considered the stronger posture and rejected it for this threat model.
 *
 * ## Why `SameSite=Lax` alone is not the whole posture
 *
 * `SameSite` is enforced by the **browser**, not by this server. It is the primary defence and it
 * works — but it is a property of the client, and it is the client the attacker is trying to abuse.
 * A request that carries the session cookie without a matching `Origin` is either not from a browser
 * at all, or from one that did not apply the rule. Refusing it server-side means the guarantee does
 * not rest on the attacker's browser behaving.
 *
 * That difference is also why this cannot be tested with an integration test alone: a supertest
 * request carries whatever headers the test sets, so a "cross-origin" POST arrives *with* the cookie
 * regardless of `SameSite`. Only the server refusing it makes the assertion mean anything.
 *
 * ## Only state-changing methods
 *
 * `GET` and `HEAD` are safe by definition (Section 10's contract gives no reading endpoint a side
 * effect), and refusing them would break ordinary navigation — a link from another site to the
 * assessment is a legitimate same-site GET with a foreign `Origin`. `OPTIONS` is included in the
 * exempt set because it is a preflight, which by construction carries no cookie and changes nothing.
 *
 * ## A missing `Origin` is allowed, and that is deliberate
 *
 * Modern browsers send `Origin` on every state-changing request, including same-origin ones, so a
 * browser-driven attack always presents one and always presents a wrong one. What does *not* send it
 * is a non-browser client — `curl`, the keep-warm ping, a script — and those have no victim's cookie
 * to abuse: an attacker with the ability to send arbitrary requests directly is not performing CSRF,
 * and `SameSite` was never the control for them. Refusing absent-`Origin` requests would break
 * operational tooling to defend against an attacker who is not deterred by it.
 *
 * ## Why it reads `req.protocol` and `Host`
 *
 * The comparison is against the origin *this request arrived at*, which is what makes it meaningful:
 * a request whose `Origin` disagrees with its own `Host` and scheme came from somewhere else. On
 * Render both sides of that depend on `app.set('trust proxy', 1)` (T9.4.1) — without it `req.protocol`
 * reports `http` on an HTTPS request, and a same-origin POST from an `https://` page would be refused
 * as cross-origin. That setting's absence is loud here rather than silent, which is the opposite of
 * how it fails for cookies.
 */

/** Methods this middleware examines. Everything else is exempt — see the note above. */
const STATE_CHANGING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * The refusal.
 *
 * A cross-site attacker cannot read this body — the response carries no CORS headers, so the browser
 * withholds it — which makes the message purely for a legitimate client that is genuinely confused,
 * and it names no identity and no internal detail either way (Section 11).
 */
const CROSS_ORIGIN_MESSAGE = 'Cross-origin request refused';

/**
 * Whether `origin` names the same origin this request arrived at.
 *
 * The `Origin` header is a URL without a path, so it is parsed rather than string-compared: that
 * normalizes the things a literal comparison would trip on, and it makes `Origin: null` — which a
 * sandboxed frame sends, and which is not a URL — a refusal rather than an accident.
 */
function isSameOrigin(origin: string, req: Request): boolean {
  let claimed: URL;

  try {
    claimed = new URL(origin);
  } catch {
    return false;
  }

  const host = req.get('host');

  if (host === undefined) return false;

  return claimed.host === host && claimed.protocol === `${req.protocol}:`;
}

/**
 * Refuses a state-changing request whose `Origin` is not this server's own.
 *
 * Mounted globally in `createApp()` rather than per router: unlike the session middlewares, which
 * Section 9 requires to be mounted per router because two `cookie-session` instances would collide,
 * this one has no per-request state and no boundary to keep separate. A route added later is covered
 * by having been added, which is the property a cross-cutting refusal should have.
 *
 * It is deliberately **not** logged. Section 13 specifies exactly one log line for this system — the
 * staff data-access line — and a second event type invented here would be adding to a security
 * requirement rather than implementing it; the same reasoning the export endpoint records. A refused
 * request still appears in Render's own HTTP request log as a 403, which is where an operator would
 * look for it (Section 16).
 */
export const requireSameOrigin: RequestHandler = (req, res, next) => {
  if (!STATE_CHANGING_METHODS.has(req.method)) {
    next();
    return;
  }

  const origin = req.get('origin');

  if (origin === undefined) {
    next();
    return;
  }

  if (!isSameOrigin(origin, req)) {
    res.status(403).json({ error: CROSS_ORIGIN_MESSAGE });
    return;
  }

  next();
};
