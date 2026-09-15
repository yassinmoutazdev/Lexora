import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from './app.ts';

/**
 * Smoke test for the E1 skeleton: proves vitest runs, supertest drives the app over HTTP, and
 * `createApp()` assembles an instance with configuration loaded.
 *
 * Assertions that depend on real routes arrive with the routes themselves — this test must keep
 * passing unchanged as each Epic mounts its own router.
 */
describe('app assembly', () => {
  it('builds an Express app that answers HTTP requests', async () => {
    const response = await request(createApp()).get('/');

    // No API routes exist yet. A 404 from Express (rather than a connection error or a crash)
    // is the evidence that the app instance is assembled and serving.
    expect(response.status).toBe(404);
  });

  it('does not require a frontend bundle outside production', () => {
    // NODE_ENV=test, so the static/SPA-fallback branch is skipped and `createApp()` must not
    // depend on `npm run build` having been run.
    expect(() => createApp()).not.toThrow();
  });
});
