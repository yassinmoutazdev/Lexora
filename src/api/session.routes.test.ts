import express from 'express';
import type { Express } from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../app.ts';
import {
  STAFF_SESSION_COOKIE,
  STUDENT_SESSION_COOKIE,
  getStudentSession,
  studentSessionMiddleware,
} from '../auth/session.ts';
import { createCohort, createSubmission, prisma, useCleanTestDatabase } from '../test/fixtures.ts';
import { requireStudentSession } from './middleware/requireStudentSession.ts';
import { sessionRouter } from './session.routes.ts';

/**
 * Integration tests for `POST /api/session/student-verify` (T3.2.2), against the real test
 * database.
 *
 * The property worth proving is not "the route returns 200" but the whole chain: details typed on
 * the entry page become a submission row, and the session handed back is scoped to exactly that
 * row. So the tests drive the real router and then present the cookie it issued to a student-only
 * route, rather than only inspecting the `Set-Cookie` header.
 *
 * The entry page (`/`), the assessment, and the report are E4/E8 work; the router under test here
 * is the real one, mounted exactly as `createApp()` mounts it.
 */

/** The refusal contract from ARCHITECTURE Section 11, restated here rather than imported. */
const REFUSAL = { error: "We couldn't find a matching record — check your details" };

/**
 * The real session router, plus a probe route standing in for the E4 student routes.
 *
 * Without a student-protected route there is no way to show that the issued cookie *authorizes*
 * anything — only that a cookie was sent. `requireStudentSession` is the same middleware those
 * routes will use (T3.1.3), so this is the real access path with a placeholder handler.
 */
function createTestApp(): Express {
  const app = express();
  app.use(express.json());
  app.use('/api/session', sessionRouter);

  const probe = express.Router();
  probe.use(studentSessionMiddleware);
  probe.get('/whoami', requireStudentSession, (req, res) => {
    res.json({ session: getStudentSession(req) });
  });
  app.use('/api/probe', probe);

  return app;
}

/** Every cookie name on a response, sorted. */
function cookieNames(response: request.Response): string[] {
  return setCookieHeaders(response)
    .map((value) => value.split('=')[0] ?? '')
    .sort();
}

function setCookieHeaders(response: request.Response): string[] {
  const header = response.headers['set-cookie'];
  if (!header) return [];

  return Array.isArray(header) ? header : [header];
}

/** The `Set-Cookie` header for a named cookie, if the response carried one. */
function setCookieFor(response: request.Response, name: string): string | undefined {
  return setCookieHeaders(response).find((value) => value.startsWith(`${name}=`));
}

useCleanTestDatabase();

describe('POST /api/session/student-verify — verified identities', () => {
  it('creates a draft, issues a session scoped to it, and reports the draft status', async () => {
    const cohort = await createCohort({ code: 'PILOT-2026', name: 'Pilot Cohort 2026' });
    const agent = request.agent(createTestApp());

    const response = await agent
      .post('/api/session/student-verify')
      .send({ cohortCode: 'PILOT-2026', rollNumber: '2021-001', studentName: 'Alice Example' })
      .expect(200);

    expect(response.body).toEqual({ status: 'draft' });

    // The student cookie and its signature, and pointedly not the staff one.
    expect(cookieNames(response)).toEqual(
      [STUDENT_SESSION_COOKIE, `${STUDENT_SESSION_COOKIE}.sig`].sort(),
    );
    expect(cookieNames(response)).not.toContain(STAFF_SESSION_COOKIE);

    const created = await prisma().submission.findFirstOrThrow({ where: { cohortId: cohort.id } });

    // The session is scoped to exactly the row that was resolved — this is what makes the id the
    // student never sees the only id their session can reach.
    const probe = await agent.get('/api/probe/whoami').expect(200);
    expect(probe.body).toEqual({ session: { submissionId: created.id } });
  });

  it('resolves an existing submission and reports its status instead of starting a new attempt', async () => {
    const cohort = await createCohort({ code: 'PILOT-2026' });
    const existing = await createSubmission(cohort.id, {
      rollNumberRaw: '2021-001',
      rollNumberNormalized: '2021-001',
      studentName: 'Alice Example',
      status: 'submitted',
    });
    const agent = request.agent(createTestApp());

    const response = await agent
      .post('/api/session/student-verify')
      .send({ cohortCode: 'PILOT-2026', rollNumber: '2021-001', studentName: 'Alice Example' })
      .expect(200);

    // FR-STU-006: a returning student is sent to their report, not a fresh assessment.
    expect(response.body).toEqual({ status: 'submitted' });

    const probe = await agent.get('/api/probe/whoami').expect(200);
    expect(probe.body).toEqual({ session: { submissionId: existing.id } });
    await expect(prisma().submission.count()).resolves.toBe(1);
  });

  it('re-issues a session for a returning student, so the report stays reachable', async () => {
    // Section 9: identity verification is trivially repeatable, and it is the only way back in.
    const cohort = await createCohort({ code: 'PILOT-2026' });
    await createSubmission(cohort.id, {
      rollNumberRaw: '2021-001',
      rollNumberNormalized: '2021-001',
      studentName: 'Alice Example',
      status: 'submitted',
    });

    const app = createTestApp();
    const first = await request(app)
      .post('/api/session/student-verify')
      .send({ cohortCode: 'PILOT-2026', rollNumber: '2021-001', studentName: 'Alice Example' })
      .expect(200);

    expect(first.body).toEqual({ status: 'submitted' });
    expect(cookieNames(first)).toContain(STUDENT_SESSION_COOKIE);
  });
});

describe('POST /api/session/student-verify — refusals', () => {
  it('refuses an identity that does not resolve and issues no session', async () => {
    await createCohort({ code: 'PILOT-2026' });

    const response = await request(createTestApp())
      .post('/api/session/student-verify')
      .send({ cohortCode: 'NOT-A-COHORT', rollNumber: '2021-001', studentName: 'Alice Example' })
      .expect(400);

    expect(response.body).toEqual(REFUSAL);
    // No cookie at all: a failed attempt must leave the caller exactly as unauthenticated as
    // they were, and must not hand out a session scoped to nothing.
    expect(cookieNames(response)).toEqual([]);
    await expect(prisma().submission.count()).resolves.toBe(0);
  });

  it('gives a byte-identical refusal whichever field is wrong', async () => {
    const cohort = await createCohort({ code: 'PILOT-2026' });
    await createSubmission(cohort.id, {
      rollNumberRaw: '2021-001',
      rollNumberNormalized: '2021-001',
      studentName: 'Alice Example',
    });

    const app = createTestApp();

    const unknownCohort = await request(app)
      .post('/api/session/student-verify')
      .send({ cohortCode: 'WRONG-COHORT', rollNumber: '2021-001', studentName: 'Alice Example' })
      .expect(400);

    const wrongName = await request(app)
      .post('/api/session/student-verify')
      .send({ cohortCode: 'PILOT-2026', rollNumber: '2021-001', studentName: 'Someone Else' })
      .expect(400);

    expect(unknownCohort.body).toEqual(wrongName.body);
    expect(unknownCohort.body).toEqual(REFUSAL);

    // And the refusal names no field, so it cannot be used to work out which one was right.
    const body = JSON.stringify(unknownCohort.body);
    for (const field of ['cohortCode', 'rollNumber', 'studentName', 'cohort', 'roll', 'name']) {
      expect(body).not.toContain(field);
    }
  });

  it('does not create a submission for a refused identity', async () => {
    const cohort = await createCohort({ code: 'PILOT-2026' });
    await createSubmission(cohort.id, {
      rollNumberRaw: '2021-001',
      rollNumberNormalized: '2021-001',
      studentName: 'Alice Example',
    });

    await request(createTestApp())
      .post('/api/session/student-verify')
      .send({ cohortCode: 'PILOT-2026', rollNumber: '2021-001', studentName: 'Someone Else' })
      .expect(400);

    await expect(prisma().submission.count()).resolves.toBe(1);
  });
});

describe('POST /api/session/student-verify — malformed bodies', () => {
  it('rejects a blank field before the identity service runs', async () => {
    // The conclusive case: without validation this body would have resolved a real cohort and
    // created a submission whose normalized roll number is the empty string. Nothing being created
    // is the evidence that `StudentIdentityService` was never reached.
    await createCohort({ code: 'PILOT-2026' });

    const response = await request(createTestApp())
      .post('/api/session/student-verify')
      .send({ cohortCode: 'PILOT-2026', rollNumber: '2021-001', studentName: '   ' })
      .expect(400);

    expect(response.body).toEqual({
      error: 'Invalid request body',
      details: [{ field: 'studentName', message: 'studentName must not be blank' }],
    });
    await expect(prisma().submission.count()).resolves.toBe(0);
  });

  it('rejects a missing field before the identity service runs', async () => {
    await createCohort({ code: 'PILOT-2026' });

    const response = await request(createTestApp())
      .post('/api/session/student-verify')
      .send({ cohortCode: 'PILOT-2026', rollNumber: '2021-001' })
      .expect(400);

    expect(response.body.details).toEqual([
      { field: 'studentName', message: 'studentName is required' },
    ]);
    await expect(prisma().submission.count()).resolves.toBe(0);
  });

  it('rejects a wrong-typed field rather than failing inside the service', async () => {
    await createCohort({ code: 'PILOT-2026' });

    const response = await request(createTestApp())
      .post('/api/session/student-verify')
      .send({ cohortCode: 'PILOT-2026', rollNumber: 2021001, studentName: 'Alice Example' })
      .expect(400);

    expect(response.body.details).toEqual([
      { field: 'rollNumber', message: 'rollNumber must be a string' },
    ]);
  });

  it('distinguishes a malformed body from an identity that does not resolve', async () => {
    // Both are 400s, and a client has to be able to tell them apart: one is "fix your form", the
    // other is "we could not find you", and only the second should be reported as a mismatch
    // without field detail.
    await createCohort({ code: 'PILOT-2026' });
    const app = createTestApp();

    const malformed = await request(app)
      .post('/api/session/student-verify')
      .send({ cohortCode: 'PILOT-2026', rollNumber: '', studentName: 'Alice Example' })
      .expect(400);

    const unresolved = await request(app)
      .post('/api/session/student-verify')
      .send({ cohortCode: 'NO-SUCH-COHORT', rollNumber: '2021-001', studentName: 'Alice Example' })
      .expect(400);

    expect(malformed.body).toHaveProperty('details');
    expect(unresolved.body).toEqual(REFUSAL);
    expect(unresolved.body).not.toHaveProperty('details');
  });
});

describe('app assembly', () => {
  it('serves student-verify from the assembled application', async () => {
    // Guards the mount in `createApp()` itself — the tests above build their own app.
    await createCohort({ code: 'PILOT-2026' });

    const response = await request(createApp())
      .post('/api/session/student-verify')
      .send({ cohortCode: 'PILOT-2026', rollNumber: '2021-001', studentName: 'Alice Example' })
      .expect(200);

    expect(response.body).toEqual({ status: 'draft' });
    expect(cookieNames(response)).toContain(STUDENT_SESSION_COOKIE);
  });

  it('marks the session cookie Secure only when the deployment proxy reports TLS', async () => {
    // `src/app.ts` sets `trust proxy: 1`, which is what makes `req.protocol` report the original
    // scheme rather than the proxy's plain-HTTP hop. Both halves matter: without the first, the
    // Secure attribute Section 13 requires never appears in production; without the second
    // holding, the same setting would break local development over http://localhost.
    await createCohort({ code: 'PILOT-2026' });
    const app = createApp();

    const overTls = await request(app)
      .post('/api/session/student-verify')
      .set('X-Forwarded-Proto', 'https')
      .send({ cohortCode: 'PILOT-2026', rollNumber: '2021-001', studentName: 'Alice Example' })
      .expect(200);

    expect(setCookieFor(overTls, STUDENT_SESSION_COOKIE)).toContain('; secure');

    const direct = await request(app)
      .post('/api/session/student-verify')
      .send({ cohortCode: 'PILOT-2026', rollNumber: '2021-002', studentName: 'Bob Example' })
      .expect(200);

    expect(setCookieFor(direct, STUDENT_SESSION_COOKIE)).not.toContain('secure');
  });
});
