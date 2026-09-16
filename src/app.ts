import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import type { Express } from 'express';
import { sessionRouter } from './api/session.routes.ts';
import { staffRouter } from './api/staff.routes.ts';
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

  // Parses JSON bodies. It does not trust them — every API boundary validates its body against a
  // zod schema via validateBody (T3.2.3) before the payload reaches a domain service.
  app.use(express.json());

  if (env.NODE_ENV === 'production') {
    mountFrontendBundle(app);
  }

  app.use('/api/session', sessionRouter);
  app.use('/api/staff', staffRouter);

  return app;
}
