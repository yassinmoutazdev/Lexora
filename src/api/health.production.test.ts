import fs from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { REPO_ROOT } from '../config/env.ts';

/**
 * `GET /health` as a *production* build mounts it (T9.2.2).
 *
 * ## Why this is a separate file, and why it does not use the `createApp()` the other tests use
 *
 * In production, `createApp()` calls `mountFrontendBundle(app)` **before** the routers, and that
 * registers a catch-all route matching anything not under `/api` (the negative-lookahead pattern in
 * `src/app.ts`). A `/health` route registered after it is never reached: production answers a health
 * check with `index.html` and a **200**. That is the worst failure mode this endpoint can have,
 * because it reports healthy no matter what the database is doing, and the keep-warm ping it exists
 * for would be the last thing to notice (Section 16).
 *
 * Every other test in this suite builds the app under `NODE_ENV=test`, where that branch is skipped
 * entirely — so the assembled test app cannot see this bug at all. It takes a module graph built with
 * `NODE_ENV=production` to reproduce it, which is what `vi.resetModules()` plus a dynamic import
 * gives: a fresh `app.ts` reading a fresh `env.ts`.
 *
 * ## What is asserted
 *
 * That both halves are true at once: `/health` answers **JSON**, and a client-side route answers the
 * SPA shell HTML. The second is what makes the first mean something — if the fallback were not mounted
 * the HTML assertion would fail, and without it a `/health` that returned JSON could simply mean the
 * fallback never ran. A status-code-only assertion would catch neither, because both responses are
 * 200.
 */

/** The bundle `mountFrontendBundle` refuses to start without. */
const INDEX_HTML = path.join(REPO_ROOT, 'frontend', 'dist', 'index.html');

/**
 * A bundle is required to reach the production branch at all, and `frontend/dist` is gitignored build
 * output — present after `npm run build`, absent on a clean checkout. So this file supplies a minimal
 * shell when there is none, and removes exactly what it created, leaving a real build untouched.
 */
let createdShell = false;

beforeAll(() => {
  if (fs.existsSync(INDEX_HTML)) return;

  fs.mkdirSync(path.dirname(INDEX_HTML), { recursive: true });
  fs.writeFileSync(INDEX_HTML, '<!doctype html><html><body><div id="root"></div></body></html>');
  createdShell = true;
});

afterAll(() => {
  if (createdShell) fs.rmSync(INDEX_HTML, { force: true });
});

/**
 * Builds the app exactly as production does, in a module graph that has never seen `NODE_ENV=test`.
 *
 * Returns the app plus the fresh graph's Prisma disconnect, because the production branch resolves
 * `DATABASE_URL` rather than `DATABASE_URL_TEST` and this file must not leave that pool open — the
 * suite is one process, and an undiscarded client holds vitest's worker open after the last assertion.
 */
async function productionApp() {
  vi.resetModules();
  vi.stubEnv('NODE_ENV', 'production');
  // Required by `env.ts` for every NODE_ENV other than `test`. Obvious placeholders: nothing here
  // reaches Ollama, and a real value would mean the test depended on one.
  vi.stubEnv('OLLAMA_API_KEY', 'production-mount-test-placeholder');
  vi.stubEnv('OLLAMA_BASE_URL', 'https://ollama.invalid');
  // So the ping below talks to the real test database rather than the placeholder URL the suite
  // leaves in DATABASE_URL. `SELECT 1` against it is the same query the 200 test makes.
  vi.stubEnv('DATABASE_URL', process.env.DATABASE_URL_TEST ?? '');

  const [{ createApp }, prismaClient] = await Promise.all([
    import('../app.ts'),
    import('../data/prismaClient.ts'),
  ]);

  return { app: createApp(), disconnect: prismaClient.disconnectPrismaClient };
}

afterAll(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('GET /health in a production build', () => {
  it('is answered by its own route, not swallowed by the SPA fallback', async () => {
    const { app, disconnect } = await productionApp();

    try {
      const health = await request(app).get('/health');

      // The assertion that fails if `/health` is mounted after `mountFrontendBundle`: the fallback
      // would answer 200 with `text/html`, and a status-only check would call that healthy. The
      // status itself is not pinned — 200 or 503 both mean the route ran — because what is under test
      // here is *which handler answered*, not whether the test database is up.
      expect(health.headers['content-type']).toMatch(/application\/json/);
      expect(health.body).toEqual(
        expect.objectContaining(health.status === 200 ? { status: 'ok' } : { error: expect.any(String) }),
      );
      expect(health.text).not.toContain('<!doctype');

      // And the fallback is genuinely mounted, so the assertion above is a real distinction rather
      // than a build where no catch-all exists at all.
      const clientRoute = await request(app).get('/assessment');

      expect(clientRoute.status).toBe(200);
      expect(clientRoute.headers['content-type']).toMatch(/text\/html/);
    } finally {
      await disconnect();
    }
  });
});
