import express from 'express';
import type { Express } from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../app.ts';
import { hashPassword } from '../auth/passwordHasher.ts';
import { createCohort, createStaffUser, useCleanTestDatabase } from '../test/fixtures.ts';
import { STUDENT_VERIFY_RATE_LIMIT, STAFF_LOGIN_RATE_LIMIT } from './middleware/rateLimit.ts';
import { sessionRouter } from './session.routes.ts';
import { staffRouter } from './staff.routes.ts';

/**
 * Integration tests that the two public endpoints actually carry their rate limiter (T3.3.3).
 *
 * `src/api/middleware/rateLimit.test.ts` proves the middleware works; this proves it is *wired* —
 * that `student-verify` and `staff/login` count against it before anything else runs.
 *
 * The limiters are per-process singletons, so this file deliberately calls each endpoint only to
 * exhaust it and nothing else. The other route test files call these endpoints well within their
 * thresholds, and each test file gets its own module graph.
 *
 * The bulk of each burst is malformed bodies, which are refused by `validateBody` in microseconds
 * — cheap for the test and no less conclusive, because the limiter counts every request to the
 * route regardless of its body. The last permitted request is a *real* one in both cases, so what
 * gets blocked is a genuine attempt rather than only junk.
 */

const EMAIL = 'staff@lexora.test';
const PASSWORD = 'correct horse battery staple';

function createTestApp(): Express {
  const app = express();
  app.use(express.json());
  app.use('/api/session', sessionRouter);
  app.use('/api/staff', staffRouter);

  return app;
}

useCleanTestDatabase();

describe('rate limiting is applied to the public endpoints', () => {
  it('blocks further student verifications once the threshold is reached', async () => {
    await createCohort({ code: 'PILOT-2026' });
    const app = createTestApp();

    // One short of the limit, with bodies that never reach a lookup.
    for (let attempt = 1; attempt < STUDENT_VERIFY_RATE_LIMIT; attempt += 1) {
      await request(app).post('/api/session/student-verify').send({}).expect(400);
    }

    // The last permitted request is a real one, and it is served.
    await request(app)
      .post('/api/session/student-verify')
      .send({ cohortCode: 'PILOT-2026', rollNumber: '2021-001', studentName: 'Alice Example' })
      .expect(200);

    // The next real one is refused, and refused before it reaches the identity service.
    const blocked = await request(app)
      .post('/api/session/student-verify')
      .send({ cohortCode: 'PILOT-2026', rollNumber: '2021-002', studentName: 'Bob Example' })
      .expect(429);

    expect(blocked.body).toEqual({ error: 'Too many attempts — please try again later' });
  });

  it('blocks further staff logins once the threshold is reached', async () => {
    await createStaffUser({ email: EMAIL, passwordHash: await hashPassword(PASSWORD) });
    const app = createTestApp();

    for (let attempt = 1; attempt < STAFF_LOGIN_RATE_LIMIT; attempt += 1) {
      await request(app).post('/api/staff/login').send({}).expect(400);
    }

    await request(app).post('/api/staff/login').send({ email: EMAIL, password: PASSWORD }).expect(200);

    // Refused before the password is verified, so a blocked attempt costs no bcrypt work.
    const blocked = await request(app)
      .post('/api/staff/login')
      .send({ email: EMAIL, password: PASSWORD })
      .expect(429);

    expect(blocked.body).toEqual({ error: 'Too many attempts — please try again later' });
  });

  it('keys the limiter on the real client address the deployment proxy reports', async () => {
    // The assembled application, not a throwaway one, so this covers `app.set('trust proxy', 1)`
    // in `src/app.ts` rather than the middleware alone. Without that setting `req.ip` is the
    // proxy's address and every student shares one allowance — a whole computer lab locking itself
    // out is the failure mode, so the second address having its own budget is the point.
    await createCohort({ code: 'PILOT-2026' });
    const app = createApp();

    const firstAddress = '203.0.113.10';
    const secondAddress = '203.0.113.11';

    for (let attempt = 1; attempt <= STUDENT_VERIFY_RATE_LIMIT; attempt += 1) {
      await request(app)
        .post('/api/session/student-verify')
        .set('X-Forwarded-For', firstAddress)
        .send({})
        .expect(400);
    }

    await request(app)
      .post('/api/session/student-verify')
      .set('X-Forwarded-For', firstAddress)
      .send({})
      .expect(429);

    // A different address is unaffected, and a real request from it is served.
    await request(app)
      .post('/api/session/student-verify')
      .set('X-Forwarded-For', secondAddress)
      .send({ cohortCode: 'PILOT-2026', rollNumber: '2021-001', studentName: 'Alice Example' })
      .expect(200);
  });
});
