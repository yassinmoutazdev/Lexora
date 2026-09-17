import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import type { Express } from 'express';
import { errorHandler } from './api/middleware/errorHandler.ts';
import { requireSameOrigin } from './api/middleware/requireSameOrigin.ts';
import { healthRouter } from './api/health.routes.ts';
import { sessionRouter } from './api/session.routes.ts';
import { staffRouter } from './api/staff.routes.ts';
import { studentRouter } from './api/student.routes.ts';
import { env, REPO_ROOT } from './config/env.ts';

/** Vite's build output, produced by `npm run build:frontend`. */
const FRONTEND_DIST = path.join(REPO_ROOT, 'frontend', 'dist');

/**
 * Serves the built React bundle from the same process as the API (ARCHITECTURE Section 1:
 * single deployable). Only in production — in development the Vite dev server serves the SPA
 * and proxies `/api` here, so mounting these routes would only ever serve a stale bundle.
 */
function mountFrontendBundle(app: Express): void {
  const indexHtml = path.join(FRONTEND_DIST, 'index.html');

  if (!fs.existsSync(indexHtml)) {
    throw new Error(
      `NODE_ENV=production but no frontend bundle was found at ${FRONTEND_DIST}.\n` +
        'Run `npm run build` before starting the server.',
    );
  }

  app.use(express.static(FRONTEND_DIST));

  // Client-side routes (/assessment, /report, /staff/dashboard) are not files on disk, so any
  // remaining GET falls through to the SPA shell. API paths are excluded so a mistyped or
  // removed endpoint still 404s as an API response instead of quietly returning HTML.
  app.get(/^\/(?!api(?:\/|$)).*/, (_req, res) => {
    res.sendFile(indexHtml);
  });
}

/**
 * Assembles the Express application: middleware, static assets, and route mounting.
 *
 * This is the API layer only — it owns request parsing and delegated routing, never business
 * rules (ARCHITECTURE Section 1). Routers are mounted here as each Epic implements them:
 * session routes in E3, student routes in E4, staff routes in E8.
 *
 * Exported as a factory rather than a module-level singleton so tests can build an app instance
 * without starting a listener.
 */
export function createApp(): Express {
  const app = express();

  // Render terminates TLS at its proxy, so nothing Express reads from the socket describes the
  // real request: without this, `req.protocol` reports `http` on an HTTPS request and `req.ip` is
  // the proxy's address. Both matter, and both fail silently if this is missing —
  // `src/auth/session.ts` marks the session cookies Secure from `req.protocol`, and
  // `src/api/middleware/rateLimit.ts` keys on `req.ip`, so an entire cohort would share one
  // allowance while every cookie quietly lost its Secure attribute.
  //
  // Must be `1`, never `true`. `1` trusts exactly one hop, so `req.ip` is the address Render's
  // proxy saw. `true` trusts every hop and takes the left-most entry in `X-Forwarded-For`, which a
  // student can set — that would let them reset their own rate-limit budget with each request.
  //
  // Assumes a proxy is always in front, which ARCHITECTURE Section 16 fixes as Render. An instance
  // exposed directly would need `false`, since the header would then be client-controlled.
  app.set('trust proxy', 1);

  // Origin-checking for state-changing requests (T9.3.1) — the second half of Section 13's CSRF
  // posture, whose first half is the `SameSite=Lax` on both session cookies (`src/auth/session.ts`).
  //
  // Mounted globally rather than per router, and before `express.json()`: unlike the session
  // middlewares, which Section 9 requires per router because two `cookie-session` instances would
  // collide on `req.session`, this one holds no per-request state. A refusal here costs no body parse
  // and no route work, which is the point — a cross-origin request is stopped before it can reach
  // anything that reads, writes, or issues a session.
  app.use(requireSameOrigin);

  // Parses JSON bodies. It does not trust them — every API boundary validates its body against a
  // zod schema via validateBody (T3.2.3) before the payload reaches a domain service.
  app.use(express.json());

  // Mounted before the frontend bundle, and the order is the whole reason this line is here rather
  // than with the other routers below. In production `mountFrontendBundle` registers
  // `app.get(/^\/(?!api(?:\/|$)).*/, …)` — a catch-all for anything not under `/api` — so a `/health`
  // registered after it is never reached: production would answer a health check with `index.html`
  // and a 200, reporting healthy no matter what the database was doing. That is the worst possible
  // failure mode for the keep-warm ping this endpoint exists to serve (ARCHITECTURE Section 16), and
  // it is invisible outside production, because the SPA branch does not run under NODE_ENV=test.
  //
  // The endpoint is deliberately not under `/api`: it is an operational probe with no session and no
  // body, not a member of Section 10's ten-endpoint contract.
  app.use('/health', healthRouter);

  if (env.NODE_ENV === 'production') {
    mountFrontendBundle(app);
  }

  app.use('/api/session', sessionRouter);
  app.use('/api/student', studentRouter);
  app.use('/api/staff', staffRouter);

  // Mounted last, after every router (T9.1.1). Express walks error middleware in registration order
  // and only the middleware registered *after* the one that failed is reached, so an error handler
  // mounted above would never see an error raised below it — and every `next(error)` in the routes
  // above would continue to fall through to Express's built-in handler, which answers `text/html`
  // with a stack trace outside production (ARCHITECTURE Section 11).
  app.use(errorHandler);

  return app;
}
