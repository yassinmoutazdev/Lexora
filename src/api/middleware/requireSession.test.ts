import express from 'express';
import type { Express } from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import {
  STAFF_SESSION_COOKIE,
  getStaffSession,
  getStudentSession,
  issueStaffSession,
  issueStudentSession,
  staffSessionMiddleware,
  studentSessionMiddleware,
} from '../../auth/session.ts';
import { requireStaffSession } from './requireStaffSession.ts';
import { requireStudentSession } from './requireStudentSession.ts';

/**
 * Integration tests for the two session guards (T3.1.3), driven over real HTTP.
 *
 * The routers here are throwaway, built inside this file: the real student routes arrive in E4 and
 * the real staff routes in T3.3.2, and the guards are worth pinning down before either exists.
 * What they are assembled from is exactly what the real routers will be — an Express router per
 * session type, `staffSessionMiddleware`/`studentSessionMiddleware` on the router, and the guard
 * on each protected route rather than across the whole app (ARCHITECTURE Section 9).
 *
 * No database is involved: a session lives entirely in a signed cookie, so this file stays a fast
 * middleware test rather than an integration test needing fixtures.
 */

const STAFF_USER_ID = 'staff-user-1';
const SUBMISSION_ID = 'submission-1';
const UNAUTHORIZED = { error: 'Authentication required' };

/**
 * The throwaway app. `reached` records which protected handlers actually ran, which is how the
 * tests show the guard rejects *before* any domain logic rather than after it.
 */
function createThrowawayApp(): { app: Express; reached: string[] } {
  const reached: string[] = [];
  const app = express();

  const staffRouter = express.Router();
  staffRouter.use(staffSessionMiddleware);
  staffRouter.post('/login', (req, res) => {
    issueStaffSession(req, STAFF_USER_ID);
    res.json({ ok: true });
  });
  staffRouter.get('/protected', requireStaffSession, (req, res) => {
    reached.push('staff');
    res.json({ session: getStaffSession(req) });
  });
  app.use('/staff', staffRouter);

  const studentRouter = express.Router();
  studentRouter.use(studentSessionMiddleware);
  studentRouter.post('/verify', (req, res) => {
    issueStudentSession(req, SUBMISSION_ID);
    res.json({ ok: true });
  });
  studentRouter.get('/protected', requireStudentSession, (req, res) => {
    reached.push('student');
    res.json({ session: getStudentSession(req) });
  });
  app.use('/student', studentRouter);

  return { app, reached };
}

/** A client holding a live staff session. */
async function staffClient(app: Express) {
  const agent = request.agent(app);
  await agent.post('/staff/login').expect(200);
  return agent;
}

/** A client holding a live student session. */
async function studentClient(app: Express) {
  const agent = request.agent(app);
  await agent.post('/student/verify').expect(200);
  return agent;
}

describe('requireStaffSession', () => {
  it('admits a request carrying a staff session', async () => {
    const { app, reached } = createThrowawayApp();
    const staff = await staffClient(app);

    const response = await staff.get('/staff/protected').expect(200);

    expect(response.body).toEqual({ session: { staffUserId: STAFF_USER_ID } });
    expect(reached).toEqual(['staff']);
  });

  it('rejects a request carrying no session at all', async () => {
    const { app, reached } = createThrowawayApp();

    const response = await request(app).get('/staff/protected').expect(401);

    expect(response.body).toEqual(UNAUTHORIZED);
    expect(reached).toEqual([]);
  });

  it('rejects a request carrying a student session', async () => {
    // The direction the task calls out: a valid student session is still not a staff session.
    const { app, reached } = createThrowawayApp();
    const student = await studentClient(app);

    const response = await student.get('/staff/protected').expect(401);

    expect(response.body).toEqual(UNAUTHORIZED);
    expect(reached).toEqual([]);
  });

  it('rejects a hand-written staff cookie that was never signed', async () => {
    // The cookie is signed, not encrypted, so its contents are readable — and forgeable-looking.
    // Minting one without SESSION_SECRET must be worth exactly as much as sending nothing.
    const { app, reached } = createThrowawayApp();
    const forged = Buffer.from(JSON.stringify({ staffUserId: 'attacker' })).toString('base64');

    const response = await request(app)
      .get('/staff/protected')
      .set('Cookie', `${STAFF_SESSION_COOKIE}=${forged}`)
      .expect(401);

    expect(response.body).toEqual(UNAUTHORIZED);
    expect(reached).toEqual([]);
  });
});

describe('requireStudentSession', () => {
  it('admits a request carrying a student session', async () => {
    const { app, reached } = createThrowawayApp();
    const student = await studentClient(app);

    const response = await student.get('/student/protected').expect(200);

    expect(response.body).toEqual({ session: { submissionId: SUBMISSION_ID } });
    expect(reached).toEqual(['student']);
  });

  it('rejects a request carrying no session at all', async () => {
    const { app, reached } = createThrowawayApp();

    const response = await request(app).get('/student/protected').expect(401);

    expect(response.body).toEqual(UNAUTHORIZED);
    expect(reached).toEqual([]);
  });

  it('rejects a request carrying a staff session', async () => {
    const { app, reached } = createThrowawayApp();
    const staff = await staffClient(app);

    const response = await staff.get('/student/protected').expect(401);

    expect(response.body).toEqual(UNAUTHORIZED);
    expect(reached).toEqual([]);
  });
});

describe('session guards and session isolation together', () => {
  it('lets each session keep working on its own routes after being refused by the other', async () => {
    // A refusal must be a decision about that one request, not a side effect that damages the
    // session the client legitimately holds.
    const { app, reached } = createThrowawayApp();
    const staff = await staffClient(app);
    const student = await studentClient(app);

    await staff.get('/student/protected').expect(401);
    await student.get('/staff/protected').expect(401);

    await staff.get('/staff/protected').expect(200, { session: { staffUserId: STAFF_USER_ID } });
    await student.get('/student/protected').expect(200, { session: { submissionId: SUBMISSION_ID } });

    expect(reached).toEqual(['staff', 'student']);
  });
});
