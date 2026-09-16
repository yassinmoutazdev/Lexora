import express from 'express';
import type { Express } from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { rateLimit, resetRateLimits } from './rateLimit.ts';

/**
 * Tests for the rate-limiting middleware (T3.3.3).
 *
 * These pin down the middleware's own behaviour — counting, blocking, window expiry, and keeping
 * separate budgets per limiter and per address — without depending on the thresholds the real
 * routes are configured with, which are deliberately far too high to exhaust in a test. That the
 * two real routes actually carry a limiter is asserted in `src/api/rateLimit.routes.test.ts`.
 *
 * Windows here are milliseconds wide rather than the production fifteen minutes, so window expiry
 * is a real assertion rather than a mocked one.
 */

function createApp(options: { limit: number; windowMs: number }): Express {
  const app = express();
  app.use('/limited', rateLimit(options));
  app.get('/limited', (_req, res) => {
    res.json({ ok: true });
  });

  return app;
}

describe('rateLimit — within the limit', () => {
  it('allows exactly `limit` requests and refuses the next one', async () => {
    const app = createApp({ limit: 3, windowMs: 60_000 });

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await request(app).get('/limited').expect(200);
    }

    await request(app).get('/limited').expect(429);
  });

  it('refuses with a generic message and a Retry-After', async () => {
    const app = createApp({ limit: 1, windowMs: 60_000 });

    await request(app).get('/limited').expect(200);

    const refused = await request(app).get('/limited').expect(429);

    expect(refused.body).toEqual({ error: 'Too many attempts — please try again later' });
    // Enough to tell a client when to come back, and nothing about what the limit is keyed on.
    expect(Number(refused.headers['retry-after'])).toBeGreaterThan(0);
    expect(Number(refused.headers['retry-after'])).toBeLessThanOrEqual(60);
  });
});

describe('rateLimit — the window', () => {
  it('starts counting again once the window has passed', async () => {
    // A refused caller is delayed, not banned: this is what keeps a shared campus address from
    // being locked out for the rest of the day by one burst.
    const app = createApp({ limit: 1, windowMs: 100 });

    await request(app).get('/limited').expect(200);
    await request(app).get('/limited').expect(429);

    await new Promise((resolve) => setTimeout(resolve, 150));

    await request(app).get('/limited').expect(200);
  });

  it('does not extend the window when a refused request arrives', async () => {
    // Otherwise a script hammering the endpoint would keep pushing its own release time away and
    // lock out the address behind it indefinitely.
    const app = createApp({ limit: 1, windowMs: 200 });

    await request(app).get('/limited').expect(200);
    await request(app).get('/limited').expect(429);
    await request(app).get('/limited').expect(429);

    await new Promise((resolve) => setTimeout(resolve, 250));

    await request(app).get('/limited').expect(200);
  });
});

describe('rateLimit — resetRateLimits', () => {
  it('gives a limiter its full budget back', async () => {
    // The whole point of the reset: a test file shares one allowance per limiter, so without this a
    // file that verifies identities more often than the limit allows fails with 429s that have
    // nothing to do with what it asserts. This proves the reset is real and not a no-op.
    const app = createApp({ limit: 1, windowMs: 60_000 });

    await request(app).get('/limited').expect(200);
    await request(app).get('/limited').expect(429);

    resetRateLimits();

    await request(app).get('/limited').expect(200);
  });

  it('resets every limiter, not only the most recent one', async () => {
    // The reason the module keeps a registry rather than one counter: the two production endpoints
    // have separate budgets, and a reset that reached only one of them would leave the other's
    // allowance spent across the whole file — the exact failure this exists to prevent.
    const app = express();
    app.use('/first', rateLimit({ limit: 1, windowMs: 60_000 }));
    app.use('/second', rateLimit({ limit: 1, windowMs: 60_000 }));
    app.get('/first', (_req, res) => res.json({ ok: true }));
    app.get('/second', (_req, res) => res.json({ ok: true }));

    await request(app).get('/first').expect(200);
    await request(app).get('/first').expect(429);
    await request(app).get('/second').expect(200);
    await request(app).get('/second').expect(429);

    resetRateLimits();

    await request(app).get('/first').expect(200);
    await request(app).get('/second').expect(200);
  });

  it('does not weaken the limit it resets', async () => {
    // A reset clears the count; it does not raise the ceiling. The limiter must refuse the request
    // after `limit` again, or this would be a way to disable it rather than to isolate tests.
    const app = createApp({ limit: 1, windowMs: 60_000 });

    resetRateLimits();

    await request(app).get('/limited').expect(200);
    await request(app).get('/limited').expect(429);
    await request(app).get('/limited').expect(429);
  });
});

describe('rateLimit — separate budgets', () => {
  it('gives each limiter instance its own counter', async () => {
    // A burst against one endpoint must not spend another's budget — the two routes share a policy
    // but not a count.
    const app = express();
    app.use('/first', rateLimit({ limit: 1, windowMs: 60_000 }));
    app.use('/second', rateLimit({ limit: 1, windowMs: 60_000 }));
    app.get('/first', (_req, res) => res.json({ ok: true }));
    app.get('/second', (_req, res) => res.json({ ok: true }));

    await request(app).get('/first').expect(200);
    await request(app).get('/first').expect(429);

    await request(app).get('/second').expect(200);
  });

  it('counts each address separately', async () => {
    // The property that makes this per-IP rather than a global counter: one address being refused
    // must not refuse anyone else. Distinct socket addresses would need two network clients, so
    // the address is varied the way a deployed instance sees it — through the proxy header, with
    // the hop trusted exactly as it is on Render (T9.4.1).
    const app = express();
    app.set('trust proxy', 1);
    app.use('/limited', rateLimit({ limit: 1, windowMs: 60_000 }));
    app.get('/limited', (_req, res) => {
      res.json({ ok: true });
    });

    await request(app).get('/limited').set('X-Forwarded-For', '203.0.113.1').expect(200);
    await request(app).get('/limited').set('X-Forwarded-For', '203.0.113.1').expect(429);

    // A different address still has its full allowance.
    await request(app).get('/limited').set('X-Forwarded-For', '203.0.113.2').expect(200);
  });
});
