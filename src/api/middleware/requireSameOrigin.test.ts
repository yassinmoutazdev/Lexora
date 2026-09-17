import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../../app.ts';
import { hashPassword } from '../../auth/passwordHasher.ts';
import { STAFF_SESSION_COOKIE, STUDENT_SESSION_COOKIE } from '../../auth/session.ts';
import { createCohort, createStaffUser, createSubmission, useCleanTestDatabase } from '../../test/fixtures.ts';

/**
 * Origin-checking for state-changing requests (T9.3.1) — ARCHITECTURE Section 13's CSRF posture.
 *
 * ## Why this file exists at all
 *
 * Section 13 specifies the posture in one sentence — *"`SameSite=Lax` plus origin-checking on
 * state-changing requests is sufficient here"* — and until this task only the first half existed. The
 * second half cannot be verified into existence: `SameSite` is enforced by the browser, so a supertest
 * request carrying a foreign `Origin` arrives *with* the session cookie no matter what `SameSite`
 * says. The server is the only party that can refuse it, and it had nothing to refuse it with.
 *
 * ## The shape of the tests
 *
 * Most of them need no database: the refusal happens before any router runs, which is itself the
 * property worth asserting — a cross-origin request is stopped before it can reach a route, a
 * session, or a query. The one that earns its fixture is the last: correct staff credentials offered
 * from a foreign origin, refused *and* issued no session. That is the attack, and it is the assertion
 * the whole task is for.
 *
 * The `Host` header is set explicitly throughout. Without it the assertion would depend on the
 * ephemeral port supertest binds, and `Origin` never carries a default port while `Host` always does.
 */

const HOST = 'lexora.test';
const STAFF_EMAIL = 'staff@lexora.test';
const STAFF_PASSWORD = 'correct horse battery staple';

useCleanTestDatabase();

/** The headers a browser sends for an ordinary same-origin form post on the deployed origin. */
const sameOrigin = { Host: HOST, Origin: `http://${HOST}` };

describe('origin checking on state-changing requests', () => {
  it('refuses a cross-origin POST before it reaches a route', async () => {
    const response = await request(createApp())
      .post('/api/session/student-verify')
      .set({ Host: HOST, Origin: 'https://evil.example' })
      .send({ cohortCode: 'PILOT-2026', rollNumber: '2021-001', studentName: 'Alice Example' })
      .expect(403);

    expect(response.body).toEqual({ error: 'Cross-origin request refused' });
    // No session, even though the body was well-formed and would have resolved a real cohort.
    expect(response.headers['set-cookie']).toBeUndefined();
    expect(JSON.stringify(response.body)).not.toContain('PILOT-2026');
  });

  it('refuses a cross-origin PATCH, so autosave is covered too and not only login', async () => {
    // The state-changing methods are enumerated in the middleware; this is the check that the
    // enumeration is applied rather than the middleware being a POST-only guard.
    await request(createApp())
      .patch('/api/student/draft')
      .set({ Host: HOST, Origin: 'https://evil.example' })
      .send({ section: 'grammar', sectionAnswers: {} })
      .expect(403);
  });

  it('lets a same-origin state-changing request through to the route', async () => {
    // 401 from `requireStudentSession`, not 403 — which is the assertion: the request reached the
    // router and was refused for the reason a sessionless request is always refused.
    const response = await request(createApp())
      .post('/api/student/submit')
      .set(sameOrigin)
      .expect(401);

    expect(response.body.error).toBe('Authentication required');
  });

  it('lets a state-changing request with no Origin through, for non-browser clients', async () => {
    // The keep-warm ping is a GET, but any operational script posting from a container presents no
    // Origin at all. An attacker who can send raw requests already has no victim cookie to abuse;
    // `SameSite` was never the control against them, and neither is this.
    const response = await request(createApp())
      .post('/api/student/submit')
      .set('Host', HOST)
      .expect(401);

    expect(response.body.error).toBe('Authentication required');
  });

  it('does not check safe methods, so ordinary navigation still works', async () => {
    // A link from another site to the assessment is a legitimate cross-origin GET. Refusing it would
    // break the product to defend against a request that cannot change anything (Section 10 gives no
    // reading endpoint a side effect).
    const response = await request(createApp())
      .get('/api/student/draft')
      .set({ Host: HOST, Origin: 'https://evil.example' })
      .expect(401);

    expect(response.status).toBe(401); // not 403
  });

  it('compares against the scheme Express sees, which on Render means trusting the proxy', async () => {
    // The deployment case, and the reason `trust proxy` (T9.4.1) is load-bearing here: TLS terminates
    // at Render's proxy, so `req.protocol` is `https` only because Express was told to read
    // `X-Forwarded-Proto`. A same-origin post from an `https://` page is refused as cross-origin
    // without it — loudly, which is the opposite of how the same omission fails for cookies.
    await request(createApp())
      .post('/api/student/submit')
      .set({ Host: HOST, 'X-Forwarded-Proto': 'https', Origin: `https://${HOST}` })
      .expect(401);

    // And with the proxy header, an `http://` page is the mismatch instead.
    await request(createApp())
      .post('/api/student/submit')
      .set({ Host: HOST, 'X-Forwarded-Proto': 'https', Origin: `http://${HOST}` })
      .expect(403);
  });

  it('refuses an Origin that is not a URL, including the literal null', async () => {
    // A sandboxed frame sends `Origin: null`. It is not a URL, so it cannot name this origin, and the
    // safe reading of "cannot be shown to be same-origin" is refusal rather than an accident.
    for (const origin of ['null', '', 'not a url']) {
      await request(createApp())
        .post('/api/student/submit')
        .set({ Host: HOST, Origin: origin })
        .expect(403);
    }
  });

  it('refuses correct staff credentials offered from another origin, and issues no session', async () => {
    // The attack itself. Every other control in this system is defeated here — the password is right,
    // the body is valid, the route is public by design — so what stops it is this middleware refusing
    // before the route that would check the password is reached.
    await createStaffUser({ email: STAFF_EMAIL, passwordHash: await hashPassword(STAFF_PASSWORD) });

    const response = await request(createApp())
      .post('/api/staff/login')
      .set({ Host: HOST, Origin: 'https://evil.example' })
      .send({ email: STAFF_EMAIL, password: STAFF_PASSWORD })
      .expect(403);

    expect(response.headers['set-cookie']).toBeUndefined();
    expect(cookiesIn(response)).not.toContain(STAFF_SESSION_COOKIE);
  });

  it('still issues the session to the same credentials from this origin', async () => {
    // The complement, and the reason the test above means something: without this, a middleware that
    // refused every login would satisfy it.
    await createStaffUser({ email: STAFF_EMAIL, passwordHash: await hashPassword(STAFF_PASSWORD) });

    const response = await request(createApp())
      .post('/api/staff/login')
      .set(sameOrigin)
      .send({ email: STAFF_EMAIL, password: STAFF_PASSWORD })
      .expect(200);

    expect(cookiesIn(response)).toContain(STAFF_SESSION_COOKIE);
  });

  it('leaves the student session cookie reachable from this origin', async () => {
    // The student path end to end, through the real route, so the check is not proved only against
    // the staff login.
    const cohort = await createCohort({ code: 'PILOT-2026' });
    await createSubmission(cohort.id, { rollNumberRaw: '2021-001', studentName: 'Alice Example' });

    const response = await request(createApp())
      .post('/api/session/student-verify')
      .set(sameOrigin)
      .send({ cohortCode: 'PILOT-2026', rollNumber: '2021-001', studentName: 'Alice Example' })
      .expect(200);

    expect(cookiesIn(response)).toContain(STUDENT_SESSION_COOKIE);
  });
});

/** The cookie names in a response's `Set-Cookie` headers. */
function cookiesIn(response: request.Response): string[] {
  const header = response.headers['set-cookie'];
  const cookies = Array.isArray(header) ? header : header === undefined ? [] : [header];

  return cookies.map((cookie) => cookie.split('=')[0] ?? '');
}
