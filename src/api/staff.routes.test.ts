import express from 'express';
import type { Express } from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../app.ts';
import { hashPassword } from '../auth/passwordHasher.ts';
import { logger } from '../config/logger.ts';
import {
  STAFF_SESSION_COOKIE,
  STUDENT_SESSION_COOKIE,
  getStaffSession,
  getStudentSession,
  studentSessionMiddleware,
} from '../auth/session.ts';
import { createCohort, createStaffUser, createSubmission, useCleanTestDatabase } from '../test/fixtures.ts';
import { requireStaffSession } from './middleware/requireStaffSession.ts';
import { requireStudentSession } from './middleware/requireStudentSession.ts';
import { sessionRouter } from './session.routes.ts';
import { staffRouter } from './staff.routes.ts';

/**
 * Integration tests for `POST /api/staff/login` and `POST /api/staff/logout` (T3.3.2).
 *
 * Login is only worth anything if what it hands back actually opens a staff route, so the tests
 * drive the real router and then present the cookie it issued to a staff-only route, using the same
 * `requireStaffSession` guard every staff route uses (T3.1.3).
 *
 * Staff rows are created with a real bcrypt hash, so the login path under test is the real one.
 */

const EMAIL = 'staff@lexora.test';
const PASSWORD = 'correct horse battery staple';

/**
 * The router under test, plus a probe route behind `requireStaffSession`.
 *
 * The probe used to sit at `/dashboard`, standing in for the E8 route that did not exist yet. It
 * moved to `/whoami` when T8.1.3 built the real one: the probe's whole job is to answer "does this
 * session open a staff-only route", and leaving it at a path the router now serves would have made
 * it a test of the dashboard instead — passing or failing for reasons that have nothing to do with
 * logout.
 */
function createTestApp(): Express {
  const app = express();
  app.use(express.json());
  app.use('/api/staff', staffRouter);

  const probe = express.Router();
  probe.use(requireStaffSession);
  probe.get('/whoami', (req, res) => {
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

    const probe = await agent.get('/api/staff/whoami').expect(200);
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
    await agent.get('/api/staff/whoami').expect(200);

    const logout = await agent.post('/api/staff/logout').expect(200);

    expect(logout.body).toEqual({ ok: true });

    // A cookie expired in the past, rather than one left readable by the client.
    const cleared = setCookieFor(logout, STAFF_SESSION_COOKIE);
    expect(cleared).toBeDefined();
    expect(cleared).toContain('expires=Thu, 01 Jan 1970');
    expect(cleared).toMatch(/^lexora_staff_session=;/);

    // The point of logging out: the route that was open is now closed.
    const after = await agent.get('/api/staff/whoami').expect(401);
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

/**
 * `GET /api/staff/dashboard` (T8.1.3, Section 10).
 *
 * Driven through `createApp()` rather than a hand-built router, because the two things worth
 * proving here are properties of the *assembled* application: that the route is mounted on the
 * staff router, and that the staff session guard runs before any aggregate does. A test with its
 * own router would verify the route in a shape the server never actually has.
 *
 * The aggregates themselves are covered against seeded rows in `DashboardService.test.ts`; what is
 * asserted here is the HTTP contract over them.
 */
describe('GET /api/staff/dashboard', () => {
  /** A logged-in agent against the real app. */
  async function signedInStaff() {
    await createStaff();

    const agent = request.agent(createApp());
    await agent.post('/api/staff/login').send({ email: EMAIL, password: PASSWORD }).expect(200);

    return agent;
  }

  it('rejects an unauthenticated request before any aggregate runs', async () => {
    // A cohort with data in it, so a route that leaked without a session would have something to
    // leak rather than returning an empty payload that happens to look like a refusal.
    const cohort = await createCohort();
    await createSubmission(cohort.id, { status: 'submitted', grammarScore: 9 });

    const response = await request(createApp()).get('/api/staff/dashboard').expect(401);

    expect(response.body).toEqual({ error: 'Authentication required' });
    // Not a payload with a 401 stapled to it: nothing about the cohort came back at all.
    expect(response.body).not.toHaveProperty('counts');
  });

  it('returns the aggregate payload to an authenticated staff session', async () => {
    await createStaff();
    const cohort = await createCohort({ code: 'DASH-2026' });

    await createSubmission(cohort.id, { status: 'draft' });
    await createSubmission(cohort.id, {
      status: 'submitted',
      grammarScore: 9,
      vocabularyScore: 9,
      readingScore: 8,
      writingStatus: 'succeeded',
      writingOverallScore: 70,
      problemsLikertAnswers: { 'sp-01': 5 },
      problemsTextStatus: 'not_applicable',
    });

    const agent = request.agent(createApp());
    await agent.post('/api/staff/login').send({ email: EMAIL, password: PASSWORD }).expect(200);

    const response = await agent.get('/api/staff/dashboard').query({ cohortId: cohort.id }).expect(200);
    const body = response.body;

    expect(body.cohort).toEqual({ id: cohort.id, code: 'DASH-2026', name: cohort.name });
    expect(body.counts).toMatchObject({ submissions: 2, draft: 1, submitted: 1 });

    expect(body.sections.map((entry: { section: string }) => entry.section)).toEqual([
      'grammar',
      'vocabulary',
      'reading',
      'writing',
    ]);
    expect(body.overall.includes).toEqual(['grammar', 'vocabulary', 'reading']);
    expect(body.overall.meanPercent).toBe(100);
    expect(body.problems.statements[0].statementId).toBe('sp-01');

    // The conditional difficulty comparison is reported as omitted, with its reason, rather than
    // being silently absent from the payload (FR-STAFF-007) — the committed content is provisional.
    expect(body.difficulty).toEqual({ available: false, reason: 'content_not_approved' });

    // The way into an individual submission, on the same payload (T8.2.3, FR-STAFF-010). Section 10
    // fixes the API at ten endpoints, so the list rides here rather than at an eleventh.
    expect(body.recentSubmissions).toHaveLength(2);
    expect(body.recentSubmissions.map((row: { status: string }) => row.status).sort()).toEqual([
      'draft',
      'submitted',
    ]);
    expect(body.recentSubmissions[0].id).toMatch(/[0-9a-f-]{36}/);
  });

  it('covers every cohort when no filter is given', async () => {
    const agent = await signedInStaff();
    const first = await createCohort();
    const second = await createCohort();

    await createSubmission(first.id, { status: 'submitted' });
    await createSubmission(second.id, { status: 'submitted' });

    const response = await agent.get('/api/staff/dashboard').expect(200);

    expect(response.body.cohort).toBeNull();
    expect(response.body.counts.submitted).toBe(2);
    expect(response.body.cohorts.map((entry: { id: string }) => entry.id)).toEqual(
      expect.arrayContaining([first.id, second.id]),
    );
  });

  it('refuses a filter that names no cohort, rather than reporting every cohort as filtered', async () => {
    const agent = await signedInStaff();

    const response = await agent
      .get('/api/staff/dashboard')
      .query({ cohortId: '00000000-0000-0000-0000-000000000000' })
      .expect(404);

    expect(response.body).toEqual({ error: 'That cohort does not exist' });
  });

  it('rejects a filter that is not a single value rather than letting an array reach the query', async () => {
    const agent = await signedInStaff();

    const response = await agent
      .get('/api/staff/dashboard?cohortId=a&cohortId=b')
      .expect(400);

    expect(response.body.error).toBe('Invalid request body');
    expect(response.body.details[0].field).toBe('cohortId');
  });
});

/**
 * Runs `fn` with everything written to stdout collected.
 *
 * The log line is observed where Section 13 says it goes — stdout, so Render's log dashboard can
 * read it — rather than through a test hook the production code would have to grow. `pino` writes
 * through `process.stdout`, so intercepting that is enough, and nothing about the logger's
 * configuration has to change to make it observable.
 */
async function captureStdout<T>(fn: () => Promise<T>): Promise<{ result: T; output: string }> {
  const original = process.stdout.write.bind(process.stdout);
  let output = '';

  process.stdout.write = ((chunk: unknown, ...rest: unknown[]) => {
    output += String(chunk);
    return (original as (...args: unknown[]) => boolean)(chunk, ...rest);
  }) as typeof process.stdout.write;

  try {
    return { result: await fn(), output };
  } finally {
    process.stdout.write = original;
  }
}

/** The parsed `staff_submission_access` lines in captured output. */
function accessLines(output: string): Record<string, unknown>[] {
  return output
    .split('\n')
    .filter((line) => line.includes('staff_submission_access'))
    .map((line) => JSON.parse(line));
}
/**
 * `GET /api/staff/submissions/:id` (T8.2.1, FR-STAFF-010; ARCHITECTURE Section 13).
 *
 * Two things are under test and they are quite different. The response is the staff view of one
 * submission — its answers, its scores, its writing evaluation, and its Student Problems data in
 * both the student's own words and the AI's derived reading of them. The *log line* is the other
 * half: Section 13 requires every access to this route to emit one structured entry, and the whole
 * of its implementation is a `pino` call whose output goes to stdout.
 */
describe('GET /api/staff/submissions/:id', () => {
  async function signedInStaff() {
    await createStaff();

    const agent = request.agent(createApp());
    await agent.post('/api/staff/login').send({ email: EMAIL, password: PASSWORD }).expect(200);

    return agent;
  }


  /** A submitted row carrying every field the detail view has to render. */
  async function createDetailedSubmission(cohortId: string) {
    return createSubmission(cohortId, {
      status: 'submitted',
      studentName: 'Layla Example',
      rollNumberRaw: '2021-042',
      submittedAt: new Date('2026-03-04T10:00:00.000Z'),
      answers: {
        grammar: { 'grammar-001': 'b' },
        writing: { essayText: 'Learning a language takes patience.' },
      },
      grammarScore: 7,
      vocabularyScore: 6,
      readingScore: 5,
      writingStatus: 'succeeded',
      writingOverallScore: 72,
      writingCriteriaScores: {
        grammarAccuracy: { score: 4, rationale: 'Mostly accurate.' },
        vocabulary: { score: 3, rationale: 'Adequate range.' },
        sentenceStructure: { score: 4, rationale: 'Varied.' },
        coherence: { score: 4, rationale: 'Well organized.' },
        taskCompletion: { score: 3, rationale: 'Addresses the task.' },
      },
      writingFeedback: {
        strengths: ['Clear structure'],
        weaknesses: ['Limited vocabulary'],
        corrections: [
          { original: 'take patience', corrected: 'take patience', explanation: 'Example.' },
        ],
        suggestions: ['Read more'],
      },
      problemsLikertAnswers: { 'sp-01': 5, 'sp-02': 2 },
      problemsOpenTextOriginal: 'I find listening to fast speech difficult.',
      problemsTextStatus: 'succeeded',
      problemsTextDerived: {
        normalizedText: 'I find listening to fast speech difficult.',
        categories: [{ label: 'Listening speed', evidence: 'fast speech' }],
      },
    });
  }

  it('rejects an unauthenticated request, and logs nothing for it', async () => {
    const cohort = await createCohort();
    const submission = await createDetailedSubmission(cohort.id);

    const { result: response, output } = await captureStdout(() =>
      request(createApp()).get(`/api/staff/submissions/${submission.id}`).expect(401),
    );

    expect(response.body).toEqual({ error: 'Authentication required' });

    // No staff member was identified and no record was read, so the access log correctly has
    // nothing to say. An entry here would be an entry that cannot name who made the request.
    expect(accessLines(output)).toEqual([]);
  });

  it('returns the submission in full, with content-resolved labels', async () => {
    await createStaff();
    const cohort = await createCohort({ code: 'DETAIL-2026', name: 'Detail Cohort' });
    const submission = await createDetailedSubmission(cohort.id);

    const agent = request.agent(createApp());
    await agent.post('/api/staff/login').send({ email: EMAIL, password: PASSWORD }).expect(200);

    const response = await agent.get(`/api/staff/submissions/${submission.id}`).expect(200);
    const body = response.body;

    expect(body.id).toBe(submission.id);
    expect(body.cohort).toEqual({ id: cohort.id, code: 'DETAIL-2026', name: 'Detail Cohort' });
    expect(body.rollNumber).toBe('2021-042');
    expect(body.studentName).toBe('Layla Example');
    expect(body.status).toBe('submitted');
    expect(body.contentVersion).toBe('v1');
    expect(body.submittedAt).toBe('2026-03-04T10:00:00.000Z');

    // The answers exactly as stored, so a disputed score can be checked against them.
    expect(body.answers.writing.essayText).toBe('Learning a language takes patience.');

    // The stored columns, not recomputed (see `StaffSubmissionDetail`).
    expect(body.scores).toEqual({ grammar: 7, vocabulary: 6, reading: 5 });

    expect(body.writing.status).toBe('succeeded');
    expect(body.writing.overallScore).toBe(72);
    // Five criteria, in the rubric's own order, each labelled from the frozen rubric rather than
    // from the key.
    expect(body.writing.criteria.map((c: { key: string }) => c.key)).toEqual([
      'grammarAccuracy',
      'vocabulary',
      'sentenceStructure',
      'coherence',
      'taskCompletion',
    ]);
    expect(body.writing.criteria[0]).toEqual({
      key: 'grammarAccuracy',
      label: 'Grammar accuracy',
      score: 4,
      rationale: 'Mostly accurate.',
    });
    expect(body.writing.feedback.strengths).toEqual(['Clear structure']);

    // The Likert responses joined to the statement wording the student actually saw.
    expect(body.studentProblems.likert).toHaveLength(2);
    expect(body.studentProblems.likert[0]).toMatchObject({
      statementId: 'sp-01',
      areaLabel: 'Speaking and confidence',
      value: 5,
      valueLabel: 'Strongly agree',
    });
    expect(typeof body.studentProblems.likert[0].statement).toBe('string');
  });

  it('keeps the student\'s own words and the AI\'s derived reading in separate fields', async () => {
    await createStaff();
    const cohort = await createCohort();
    const submission = await createDetailedSubmission(cohort.id);

    const agent = request.agent(createApp());
    await agent.post('/api/staff/login').send({ email: EMAIL, password: PASSWORD }).expect(200);

    const body = (await agent.get(`/api/staff/submissions/${submission.id}`).expect(200)).body;
    const problems = body.studentProblems;

    // FR-PROB-009/FR-PROB-011: the original is the record and the derived data is a separate thing
    // — a page cannot render one in place of the other, because they do not share a field.
    expect(problems.openTextOriginal).toBe('I find listening to fast speech difficult.');
    expect(problems.textStatus).toBe('succeeded');
    expect(problems.textDerived).toEqual({
      normalizedText: 'I find listening to fast speech difficult.',
      categories: [{ label: 'Listening speed', evidence: 'fast speech' }],
    });

    // Both are present in the response. FR-PROB-015 restricts them to authorized staff rather than
    // withholding them from staff, and this route is behind a staff session.
    expect(problems.textDerived).not.toBe(problems.openTextOriginal);
  });

  it('reports a submission whose background work has not produced anything yet', async () => {
    await createStaff();
    const cohort = await createCohort();
    const submission = await createSubmission(cohort.id, {
      status: 'submitted',
      writingStatus: 'pending',
      problemsTextStatus: 'not_applicable',
      problemsLikertAnswers: { 'sp-01': 3 },
    });

    const agent = request.agent(createApp());
    await agent.post('/api/staff/login').send({ email: EMAIL, password: PASSWORD }).expect(200);

    const body = (await agent.get(`/api/staff/submissions/${submission.id}`).expect(200)).body;

    expect(body.writing.status).toBe('pending');
    expect(body.writing.overallScore).toBeNull();
    expect(body.writing.criteria).toEqual([]);
    expect(body.writing.feedback).toBeNull();

    // No open text was given, so there is no derived data — and `null` says that, rather than an
    // empty object that would read as "the AI looked and found nothing".
    expect(body.studentProblems.openTextOriginal).toBeNull();
    expect(body.studentProblems.textDerived).toBeNull();
  });

  it('refuses an id that names no submission', async () => {
    await createStaff();
    const agent = request.agent(createApp());
    await agent.post('/api/staff/login').send({ email: EMAIL, password: PASSWORD }).expect(200);

    const response = await agent
      .get('/api/staff/submissions/00000000-0000-0000-0000-000000000000')
      .expect(404);

    expect(response.body).toEqual({ error: 'No such submission' });
  });

  it('emits one structured staff-access log line per access', async () => {
    const staff = await createStaff();
    const cohort = await createCohort();
    const submission = await createDetailedSubmission(cohort.id);

    const agent = request.agent(createApp());
    await agent.post('/api/staff/login').send({ email: EMAIL, password: PASSWORD }).expect(200);

    const { output } = await captureStdout(() =>
      agent.get(`/api/staff/submissions/${submission.id}`).expect(200),
    );

    const lines = accessLines(output);
    expect(lines).toHaveLength(1);

    // Section 13 fixes this shape exactly:
    // { event: 'staff_submission_access', staffUserId, submissionId, timestamp, action: 'view' }
    expect(lines[0]).toMatchObject({
      event: 'staff_submission_access',
      staffUserId: staff.id,
      submissionId: submission.id,
      action: 'view',
    });
    expect(typeof lines[0]?.['timestamp']).toBe('string');
    expect(Number.isNaN(Date.parse(String(lines[0]?.['timestamp'])))).toBe(false);
  });

  it('logs a refused access too, so probing ids is visible', async () => {
    await createStaff();
    const agent = request.agent(createApp());
    await agent.post('/api/staff/login').send({ email: EMAIL, password: PASSWORD }).expect(200);

    const missing = '11111111-1111-1111-1111-111111111111';
    const { output } = await captureStdout(() =>
      agent.get(`/api/staff/submissions/${missing}`).expect(404),
    );

    const lines = accessLines(output);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      event: 'staff_submission_access',
      submissionId: missing,
      action: 'view',
    });
  });

  it('never logs the Ollama API key, even if one reaches a log call (Section 13)', async () => {
    // Defence in depth: the key is read only inside `OllamaProvider` and never passed here, so this
    // exercises the redaction configuration itself rather than a code path that could leak it.
    //
    // Against the *application's* logger, not a local `pino` instance carrying a copy of the same
    // options. E8's version of this test constructed its own instance, which meant it would keep
    // passing if `src/config/logger.ts` lost its `redact` block entirely — it proved the copy. Now
    // that the configuration lives in exactly one place (T9.2.1), the test reads that place.
    const { output } = await captureStdout(async () => {
      logger.info(
        { apiKey: 'sk-live-secret', nested: { authorization: 'Bearer sk-live-secret' } },
        'probe',
      );
    });

    expect(output).not.toContain('sk-live-secret');
    expect(output).toContain('[Redacted]');
  });
});

/**
 * `GET /api/staff/export.csv` (T8.4.1, FR-STAFF-011, PRD G5).
 *
 * The export is the product's boundary with real analysis tools — PRD Section 14: *"support external,
 * deeper analysis via export rather than trying to replace tools like Excel or Python within the
 * product"* — so the tests are about the file being *usable* rather than merely present: the columns
 * an analyst needs, one row per submission, empty cells where an instrument did not ask something,
 * and a filter that actually filters.
 *
 * The CSV is parsed back rather than string-matched, so the assertions are about cells and not about
 * quoting. A hand-rolled parser is enough here and keeps the dependency set exactly as Section 2
 * specifies — there is no CSV *parsing* library in it, only `csv-stringify`.
 */
describe('GET /api/staff/export.csv', () => {
  async function signedInStaff() {
    await createStaff();

    const agent = request.agent(createApp());
    await agent.post('/api/staff/login').send({ email: EMAIL, password: PASSWORD }).expect(200);

    return agent;
  }

  /**
   * Parses CSV text into header-keyed records.
   *
   * Handles the one thing quoting exists for here: a quoted field containing a comma or a newline —
   * both of which appear in student free text, and both of which would otherwise split a row.
   */
  function parseCsv(text: string): Record<string, string>[] {
    const rows: string[][] = [];
    let row: string[] = [];
    let field = '';
    let quoted = false;

    for (let index = 0; index < text.length; index += 1) {
      const char = text[index];

      if (quoted) {
        if (char === '"') {
          if (text[index + 1] === '"') {
            field += '"';
            index += 1;
          } else {
            quoted = false;
          }
        } else {
          field += char;
        }
        continue;
      }

      if (char === '"') quoted = true;
      else if (char === ',') {
        row.push(field);
        field = '';
      } else if (char === '\n') {
        row.push(field);
        rows.push(row);
        row = [];
        field = '';
      } else if (char !== '\r') field += char;
    }

    if (field !== '' || row.length > 0) {
      row.push(field);
      rows.push(row);
    }

    const [header, ...body] = rows;
    if (!header) return [];

    return body
      .filter((values) => values.length === header.length)
      .map((values) => Object.fromEntries(header.map((key, index) => [key, values[index] ?? ''])));
  }

  /** A submission carrying a value in every column family the export covers. */
  async function createExportableSubmission(cohortId: string, rollNumber: string, name: string) {
    return createSubmission(cohortId, {
      status: 'submitted',
      rollNumberRaw: rollNumber,
      studentName: name,
      submittedAt: new Date('2026-03-04T10:00:00.000Z'),
      grammarScore: 7,
      vocabularyScore: 6,
      readingScore: 5,
      writingStatus: 'succeeded',
      writingOverallScore: 72,
      writingCriteriaScores: {
        grammarAccuracy: { score: 4, rationale: 'Mostly accurate.' },
        vocabulary: { score: 3, rationale: 'Adequate.' },
      },
      problemsLikertAnswers: { 'sp-01': 5, 'sp-02': 2 },
      problemsOpenTextOriginal: 'Listening to fast speech is hard, and I lose the thread.',
      problemsTextStatus: 'succeeded',
      problemsTextDerived: {
        normalizedText: 'Listening to fast speech is difficult.',
        categories: [{ label: 'Listening speed', evidence: 'fast speech' }, { label: 'Confidence', evidence: 'lose the thread' }],
      },
    });
  }

  it('rejects an unauthenticated request', async () => {
    const cohort = await createCohort();
    await createExportableSubmission(cohort.id, 'R-1', 'Alice');

    const response = await request(createApp()).get('/api/staff/export.csv').expect(401);

    expect(response.body).toEqual({ error: 'Authentication required' });
  });

  it('exports one row per submission with the columns an analyst needs', async () => {
    const agent = await signedInStaff();
    const cohort = await createCohort({ code: 'EXPORT-2026', name: 'Export Cohort' });
    const submission = await createExportableSubmission(cohort.id, '2021-042', 'Layla Example');

    const response = await agent.get('/api/staff/export.csv').expect(200);

    expect(response.headers['content-type']).toContain('text/csv');
    expect(response.headers['content-disposition']).toBe(
      'attachment; filename="lexora-submissions-all-cohorts-' +
        new Date().toISOString().slice(0, 10) +
        '.csv"',
    );

    const [row, ...rest] = parseCsv(response.text);
    expect(rest).toHaveLength(0);
    expect(row).toBeDefined();

    expect(row?.['submission_id']).toBe(submission.id);
    expect(row?.['cohort_code']).toBe('EXPORT-2026');
    expect(row?.['cohort_name']).toBe('Export Cohort');
    expect(row?.['roll_number']).toBe('2021-042');
    expect(row?.['student_name']).toBe('Layla Example');
    expect(row?.['status']).toBe('submitted');
    expect(row?.['content_version']).toBe('v1');
    expect(row?.['submitted_at']).toBe('2026-03-04T10:00:00.000Z');

    expect(row?.['grammar_score']).toBe('7');
    expect(row?.['vocabulary_score']).toBe('6');
    expect(row?.['reading_score']).toBe('5');

    expect(row?.['writing_status']).toBe('succeeded');
    expect(row?.['writing_overall_score']).toBe('72');

    // One column per rubric criterion, keyed by the rubric's own key — content, not a hardcoded list.
    expect(row?.['writing_grammarAccuracy']).toBe('4');
    expect(row?.['writing_vocabulary']).toBe('3');
    expect(row?.['writing_sentenceStructure']).toBe('');

    // One column per Student Problems statement, plus the three text columns.
    expect(row?.['problems_sp-01']).toBe('5');
    expect(row?.['problems_sp-02']).toBe('2');
    expect(row?.['problems_sp-03']).toBe('');
    expect(row?.['problems_text_status']).toBe('succeeded');

    // FR-PROB-009: the student's own words, exactly as submitted — including the comma, which is why
    // the field is quoted on the wire.
    expect(row?.['problems_open_text_original']).toBe(
      'Listening to fast speech is hard, and I lose the thread.',
    );
    // FR-PROB-011: the derived columns say so in their headers, so a header line alone is enough to
    // tell an analyst which cells are not the student's words.
    expect(row?.['problems_open_text_normalized_derived']).toBe(
      'Listening to fast speech is difficult.',
    );
    expect(row?.['problems_categories_derived']).toBe('Listening speed; Confidence');
  });

  it('respects the cohort filter, and names the cohort in the filename', async () => {
    const agent = await signedInStaff();
    const first = await createCohort({ code: 'FILTER-A' });
    const second = await createCohort({ code: 'FILTER-B' });

    await createExportableSubmission(first.id, 'A-1', 'First Student');
    await createExportableSubmission(second.id, 'B-1', 'Second Student');

    const all = parseCsv((await agent.get('/api/staff/export.csv').expect(200)).text);
    expect(all.map((row) => row['roll_number'])).toEqual(['A-1', 'B-1']);

    const filtered = await agent.get('/api/staff/export.csv').query({ cohortId: first.id }).expect(200);
    const rows = parseCsv(filtered.text);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.['roll_number']).toBe('A-1');
    expect(filtered.headers['content-disposition']).toBe(
      `attachment; filename="lexora-submissions-FILTER-A-${new Date().toISOString().slice(0, 10)}.csv"`,
    );
  });

  it('leaves empty cells for a submission whose background work has not finished', async () => {
    const agent = await signedInStaff();
    const cohort = await createCohort();

    await createSubmission(cohort.id, {
      status: 'submitted',
      rollNumberRaw: 'P-1',
      // No open text at all, and no evaluation yet. `not_applicable` is not a failure.
      problemsTextStatus: 'not_applicable',
      writingStatus: 'pending',
    });

    const [row] = parseCsv((await agent.get('/api/staff/export.csv').expect(200)).text);

    expect(row?.['writing_status']).toBe('pending');
    expect(row?.['writing_overall_score']).toBe('');
    expect(row?.['problems_open_text_original']).toBe('');
    expect(row?.['problems_open_text_normalized_derived']).toBe('');
    expect(row?.['problems_categories_derived']).toBe('');
    // Empty, not `0`: a Likert zero would be averaged as a real answer on the 1–5 scale.
    expect(row?.['problems_sp-01']).toBe('');
  });

  it('exports the header alone when nothing matches, rather than refusing', async () => {
    const agent = await signedInStaff();
    const cohort = await createCohort();

    const response = await agent.get('/api/staff/export.csv').query({ cohortId: cohort.id }).expect(200);
    const rows = parseCsv(response.text);

    // An empty cohort is a cohort with no submissions — a real answer, not an error.
    expect(rows).toEqual([]);
    expect(response.text.split('\n')[0]).toContain('submission_id');
  });

  it('refuses a filter that names no cohort', async () => {
    const agent = await signedInStaff();

    const response = await agent
      .get('/api/staff/export.csv')
      .query({ cohortId: '00000000-0000-0000-0000-000000000000' })
      .expect(404);

    expect(response.body).toEqual({ error: 'That cohort does not exist' });
  });

  it('rejects a filter that is not a single value', async () => {
    const agent = await signedInStaff();

    const response = await agent.get('/api/staff/export.csv?cohortId=a&cohortId=b').expect(400);

    expect(response.body.error).toBe('Invalid request body');
    expect(response.body.details[0].field).toBe('cohortId');
  });

  it('logs no staff-access line, because Section 13 defines exactly one and this is not it', async () => {
    await createStaff();
    const cohort = await createCohort();
    await createExportableSubmission(cohort.id, 'L-1', 'Log Student');

    const agent = request.agent(createApp());
    await agent.post('/api/staff/login').send({ email: EMAIL, password: PASSWORD }).expect(200);

    const { output } = await captureStdout(() => agent.get('/api/staff/export.csv').expect(200));

    expect(accessLines(output)).toEqual([]);
  });
});

/**
 * The staff session cookie's attributes, asserted end to end (T9.3.1).
 *
 * ARCHITECTURE Section 13: *"httpOnly, `Secure`, `SameSite=Lax` cookies for both staff and student
 * sessions."* `src/auth/session.test.ts` proves the configuration on a hand-built harness; this proves
 * it survives the real router — the global origin check (T9.3.1), the body validation, the auth
 * service, and `issueStaffSession` — because a cookie attribute that only holds in a harness is not a
 * property of the application.
 *
 * The Secure half is the one that cannot be checked locally and must be checked through the proxy
 * shape: `Secure` is set from `req.protocol`, which reports `https` only because `src/app.ts` sets
 * `trust proxy: 1` (T9.4.1). Without that setting the attribute would silently vanish in production
 * while every local test kept passing.
 */
describe('the staff session cookie (Section 13)', () => {
  it('is HttpOnly and SameSite=Lax', async () => {
    await createStaff();

    const response = await request(createApp())
      .post('/api/staff/login')
      .send({ email: EMAIL, password: PASSWORD })
      .expect(200);

    const cookie = setCookieFor(response, STAFF_SESSION_COOKIE);

    expect(cookie).toBeDefined();
    expect(cookie).toContain('httponly');
    expect(cookie?.toLowerCase()).toContain('samesite=lax');
  });

  it('is Secure when the proxy reports TLS, and not before', async () => {
    await createStaff();
    const app = createApp();

    const overTls = await request(app)
      .post('/api/staff/login')
      .set('X-Forwarded-Proto', 'https')
      .send({ email: EMAIL, password: PASSWORD })
      .expect(200);

    expect(setCookieFor(overTls, STAFF_SESSION_COOKIE)).toContain('; secure');

    // Plain HTTP is local development. Forcing `secure: true` here would make the cookies library
    // throw outright, which is why the attribute is derived from the connection instead.
    const direct = await request(app)
      .post('/api/staff/login')
      .send({ email: EMAIL, password: PASSWORD })
      .expect(200);

    expect(setCookieFor(direct, STAFF_SESSION_COOKIE)).not.toContain('secure');
  });
});
