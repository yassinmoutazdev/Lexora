import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import type { Express } from 'express';
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

  // Parses JSON bodies. It does not trust them — every API boundary validates its body against a
  // zod schema via validateBody (T3.2.3) before the payload reaches a domain service.
  app.use(express.json());

  if (env.NODE_ENV === 'production') {
    mountFrontendBundle(app);
  }

  app.use('/api/session', sessionRouter);
  app.use('/api/student', studentRouter);
  app.use('/api/staff', staffRouter);

  return app;
}
