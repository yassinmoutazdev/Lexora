import express from 'express';
import type { Express } from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../app.ts';
import { hashPassword } from '../auth/passwordHasher.ts';
import {
  STAFF_SESSION_COOKIE,
  STUDENT_SESSION_COOKIE,
  getStaffSession,
  getStudentSession,
  studentSessionMiddleware,
} from '../auth/session.ts';
import { createCohort, createStaffUser, useCleanTestDatabase } from '../test/fixtures.ts';
import { requireStaffSession } from './middleware/requireStaffSession.ts';
import { requireStudentSession } from './middleware/requireStudentSession.ts';
import { sessionRouter } from './session.routes.ts';
import { staffRouter } from './staff.routes.ts';

/**
 * Integration tests for `POST /api/staff/login` and `POST /api/staff/logout` (T3.3.2).
 *
 * Login is only worth anything if what it hands back actually opens a staff route, so the tests
 * drive the real router and then present the cookie it issued to a staff-only route — a stand-in
 * for the E8 dashboard, using the same `requireStaffSession` guard those routes will use (T3.1.3).
 *
 * Staff rows are created with a real bcrypt hash, so the login path under test is the real one.
 */

const EMAIL = 'staff@lexora.test';
const PASSWORD = 'correct horse battery staple';

/** The router under test, plus a probe route standing in for the E8 staff routes. */
function createTestApp(): Express {
  const app = express();
  app.use(express.json());
  app.use('/api/staff', staffRouter);

  const probe = express.Router();
  probe.use(requireStaffSession);
  probe.get('/dashboard', (req, res) => {
    res.json({ session: getStaffSession(req) });
  });
  app.use('/api/staff', probe);

  return app;
}

/** Every cookie name on a response, sorted. */
function cookieNames(response: request.Response): string[] {
  const header = response.headers['set-cookie'];
  const headers = !header ? [] : Array.isArray(header) ? header : [header];

  return headers.map((value) => value.split('=')[0] ?? '').sort();
}

/** The `Set-Cookie` header for a named cookie, if the response carried one. */
function setCookieFor(response: request.Response, name: string): string | undefined {
  const header = response.headers['set-cookie'];
  const headers = !header ? [] : Array.isArray(header) ? header : [header];

  return headers.find((value) => value.startsWith(`${name}=`));
}

async function createStaff(email = EMAIL, password = PASSWORD) {
  return createStaffUser({ email, passwordHash: await hashPassword(password) });
}

useCleanTestDatabase();

describe('POST /api/staff/login — success', () => {
  it('issues a staff session and opens a staff-only route', async () => {
    const staff = await createStaff();
    const agent = request.agent(createTestApp());

    const response = await agent
      .post('/api/staff/login')
      .send({ email: EMAIL, password: PASSWORD })
      .expect(200);

    expect(response.body).toEqual({ ok: true });

    // The staff cookie and its signature, and pointedly not the student one.
    expect(cookieNames(response)).toEqual(
      [STAFF_SESSION_COOKIE, `${STAFF_SESSION_COOKIE}.sig`].sort(),
    );
    expect(cookieNames(response)).not.toContain(STUDENT_SESSION_COOKIE);

    const probe = await agent.get('/api/staff/dashboard').expect(200);
    expect(probe.body).toEqual({ session: { staffUserId: staff.id } });
  });

  it('accepts an email with surrounding whitespace', async () => {
    await createStaff();

    await request(createTestApp())
      .post('/api/staff/login')
      .send({ email: `  ${EMAIL} `, password: PASSWORD })
      .expect(200);
  });
});

describe('POST /api/staff/login — refusal', () => {
  it('refuses a wrong password without issuing a session', async () => {
    await createStaff();

    const response = await request(createTestApp())
      .post('/api/staff/login')
      .send({ email: EMAIL, password: 'not-the-password' })
      .expect(401);

    expect(response.body).toEqual({ error: 'Invalid email or password' });
    expect(cookieNames(response)).toEqual([]);
  });

  it('gives a byte-identical refusal for an unknown email', async () => {
    // No user-enumeration signal: the response must not say which of the two was wrong.
    await createStaff();

    const app = createTestApp();

    const wrongPassword = await request(app)
      .post('/api/staff/login')
      .send({ email: EMAIL, password: 'not-the-password' })
      .expect(401);

    const unknownEmail = await request(app)
      .post('/api/staff/login')
      .send({ email: 'someone-else@lexora.test', password: PASSWORD })
      .expect(401);

    expect(unknownEmail.body).toEqual(wrongPassword.body);
    expect(JSON.stringify(unknownEmail.body)).toBe(JSON.stringify(wrongPassword.body));

    // The message names both fields and singles out neither, so it cannot be read as "the password
    // was wrong" or "that email does not exist". There is also no field-level detail to inspect.
    expect(unknownEmail.body).toEqual({ error: 'Invalid email or password' });
    expect(unknownEmail.body).not.toHaveProperty('details');
  });

  it('rejects a malformed body before the auth service runs', async () => {
    await createStaff();

    const response = await request(createTestApp())
      .post('/api/staff/login')
      .send({ email: EMAIL })
      .expect(400);

    expect(response.body).toEqual({
      error: 'Invalid request body',
      details: [{ field: 'password', message: 'password is required' }],
    });
    expect(cookieNames(response)).toEqual([]);
  });
});

describe('POST /api/staff/logout', () => {
  it('clears the session and closes the route it had opened', async () => {
    await createStaff();
    const agent = request.agent(createTestApp());

    await agent.post('/api/staff/login').send({ email: EMAIL, password: PASSWORD }).expect(200);
    await agent.get('/api/staff/dashboard').expect(200);

    const logout = await agent.post('/api/staff/logout').expect(200);

    expect(logout.body).toEqual({ ok: true });

    // A cookie expired in the past, rather than one left readable by the client.
    const cleared = setCookieFor(logout, STAFF_SESSION_COOKIE);
    expect(cleared).toBeDefined();
    expect(cleared).toContain('expires=Thu, 01 Jan 1970');
    expect(cleared).toMatch(/^lexora_staff_session=;/);

    // The point of logging out: the route that was open is now closed.
    const after = await agent.get('/api/staff/dashboard').expect(401);
    expect(after.body).toEqual({ error: 'Authentication required' });
  });

  it('refuses to log out a caller who is not logged in', async () => {
    const response = await request(createTestApp()).post('/api/staff/logout').expect(401);

    expect(response.body).toEqual({ error: 'Authentication required' });
  });

  it('does not end a student session held by the same client', async () => {
    // One browser can hold both sessions at once. They are independent cookies and independent
    // access boundaries (Section 9), so ending the staff one must leave the student one working.
    await createCohort({ code: 'PILOT-2026' });
    await createStaff();

    const app = express();
    app.use(express.json());
    app.use('/api/session', sessionRouter);
    app.use('/api/staff', staffRouter);

    const studentProbe = express.Router();
    studentProbe.use(studentSessionMiddleware);
    studentProbe.get('/whoami', requireStudentSession, (req, res) => {
      res.json({ session: getStudentSession(req) });
    });
    app.use('/api/student', studentProbe);

    const agent = request.agent(app);

    await agent
      .post('/api/session/student-verify')
      .send({ cohortCode: 'PILOT-2026', rollNumber: '2021-001', studentName: 'Alice Example' })
      .expect(200);
    await agent.post('/api/staff/login').send({ email: EMAIL, password: PASSWORD }).expect(200);

    const beforeLogout = await agent.get('/api/student/whoami').expect(200);
    const submissionId = beforeLogout.body.session.submissionId;

    const logout = await agent.post('/api/staff/logout').expect(200);

    // The logout touches the staff cookie only.
    expect(cookieNames(logout)).toEqual(
      [STAFF_SESSION_COOKIE, `${STAFF_SESSION_COOKIE}.sig`].sort(),
    );
    expect(cookieNames(logout)).not.toContain(STUDENT_SESSION_COOKIE);

    // And the student session, which was never part of that decision, still authorizes its route.
    const afterLogout = await agent.get('/api/student/whoami').expect(200);
    expect(afterLogout.body).toEqual({ session: { submissionId } });
  });
});

describe('app assembly', () => {
  it('serves staff login and logout from the assembled application', async () => {
    // Guards the mount in `createApp()` itself — the tests above build their own app.
    await createStaff();

    await request(createApp())
      .post('/api/staff/login')
      .send({ email: EMAIL, password: PASSWORD })
      .expect(200);

    await request(createApp()).post('/api/staff/logout').expect(401);
  });
});
