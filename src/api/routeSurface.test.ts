import request from 'supertest';
import { describe, expect, it } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../app.ts';
import { STUDENT_SESSION_COOKIE } from '../auth/session.ts';
import { createCohort, createSubmission, useCleanTestDatabase } from '../test/fixtures.ts';

/**
 * The student route surface (T9.3.2) — ARCHITECTURE Section 9: *"There is deliberately **no**
 * `/report/:id` or any route parameter that identifies a submission — this is the direct
 * implementation of 'no predictable student report URL' (NFR-SEC-009). The only way to obtain a
 * student session — for either the assessment or the report — is through identity verification."*
 *
 * ## Why this is asserted structurally as well as behaviourally
 *
 * A behavioural probe can only try the URLs someone thought of. The guarantee Section 9 states is a
 * property of the route *table* — no student route accepts a submission identifier at all — so the
 * audit below enumerates what is actually mounted and checks the shape of every student path. The
 * behavioural tests then confirm the property that shape is for: that a submission identifier
 * supplied by a caller, in any position, cannot change whose report comes back.
 *
 * ## What this file does not do
 *
 * It does not add a report route, and it deliberately does not test one with an id. There is no
 * ID-bearing student route to test, and the correct evidence for that is the absence — which is what
 * the enumeration asserts, rather than a 404 asserted by hand at a URL someone imagined.
 */

/** Every route the assembled app registers, as `METHOD /path`. */
type RegisteredRoute = { method: string; path: string };

/**
 * Express 4's internals, typed minimally because `@types/express` does not describe them.
 *
 * Enumerating the route table requires reaching into `_router.stack`, which is private API — there is
 * no public way to ask an `Express` instance what it serves. The walk below is written so that a
 * change in that shape fails this test loudly rather than returning an empty list that would make
 * every assertion vacuous, which is the failure mode that matters: a route audit that silently
 * audits nothing.
 */
type Layer = {
  name?: string;
  route?: { path: string; methods: Record<string, boolean> };
  handle?: { stack?: Layer[] };
  regexp?: RegExp;
};

function registeredRoutes(app: Express): RegisteredRoute[] {
  const routes: RegisteredRoute[] = [];

  const walk = (stack: Layer[], prefix: string): void => {
    for (const layer of stack) {
      if (layer.route) {
        for (const [method, enabled] of Object.entries(layer.route.methods)) {
          if (enabled) routes.push({ method: method.toUpperCase(), path: `${prefix}${layer.route.path}` });
        }
        continue;
      }

      const nested = layer.handle?.stack;
      if (!nested) continue;

      // A mounted router's own path is not recorded on the layer, so it is recovered from the mount
      // call's regular expression — `app.use('/api/student', …)` produces the source
      // `^\/api\/student\/?(?=\/|$)`, whose captured middle is the mount path. Two details make this
      // easy to get silently wrong, and both are asserted by the staff-route test below rather than
      // trusted: the capture is raw regex source, so its escaped slashes have to be unescaped, and
      // the pattern is deliberately not anchored, because the source's own leading `^` is a character
      // in it rather than an anchor this pattern should match at position zero.
      const mount = /\\\/(.*?)\\\/\?\(\?=/.exec(layer.regexp?.source ?? '');
      const segment = mount?.[1]?.replace(/\\\//g, '/');

      walk(nested, segment === undefined ? prefix : `${prefix}/${segment}`);
    }
  };

  const router = (app as unknown as { _router?: { stack?: Layer[] } })._router;

  if (!router?.stack) {
    throw new Error(
      'Could not read the Express route table (app._router.stack). The route audit in this file ' +
        'cannot run, and a silent empty result would make every assertion below pass for no reason.',
    );
  }

  walk(router.stack, '');

  return routes.sort((a, b) => `${a.path} ${a.method}`.localeCompare(`${b.path} ${b.method}`));
}

useCleanTestDatabase();

describe('the student route surface carries no submission identifier (Section 9, NFR-SEC-009)', () => {
  it('registers exactly the routes Section 10 specifies, and no others', () => {
    // A closed list rather than a spot check. Section 10 fixes the API at ten endpoints; a route
    // that appears here without appearing there is either an unapproved addition or a contract the
    // document has not been told about, and both should stop a build.
    const studentRoutes = registeredRoutes(createApp()).filter((route) =>
      route.path.startsWith('/api/student'),
    );

    expect(studentRoutes).toEqual([
      { method: 'GET', path: '/api/student/draft' },
      { method: 'PATCH', path: '/api/student/draft' },
      { method: 'GET', path: '/api/student/report' },
      { method: 'POST', path: '/api/student/submit' },
    ]);
  });

  it('has no student path with a parameter of any kind', () => {
    // The generalisation of "no `/report/:id`": not just that *that* route is absent, but that no
    // student path has a slot for a caller to fill in. A parameter anywhere on this router is the
    // thing NFR-SEC-009 is about, whatever it is named.
    const parameterised = registeredRoutes(createApp()).filter(
      (route) => route.path.startsWith('/api/student') && route.path.includes(':'),
    );

    expect(parameterised).toEqual([]);
  });

  it('still registers the staff route that does take an id, so the audit is not matching nothing', () => {
    // The complement. Without it, a walk that returned only top-level routes — missing nested
    // routers entirely — would satisfy both assertions above by finding no student routes at all,
    // and the audit would be worthless. `/api/staff/submissions/:id` is the one ID-bearing route
    // Section 10 allows, so its presence proves the walk descends into mounted routers.
    const staffRoutes = registeredRoutes(createApp()).filter((route) =>
      route.path.startsWith('/api/staff/submissions'),
    );

    expect(staffRoutes).toEqual([{ method: 'GET', path: '/api/staff/submissions/:id' }]);
  });
});

describe('report access is by session, never by identifier (Section 9)', () => {
  /** A verified student, and the submission their session is scoped to. */
  async function verifiedStudent(rollNumber: string, studentName: string) {
    const agent = request.agent(createApp());

    await agent
      .post('/api/session/student-verify')
      .send({ cohortCode: 'PILOT-2026', rollNumber, studentName })
      .expect(200);

    return agent;
  }

  /** Two students in one cohort, each with their own session. */
  async function twoStudents() {
    const cohort = await createCohort({ code: 'PILOT-2026' });
    // Distinct, fixed submission times rather than `new Date()`: the two reports are otherwise
    // identical (both submitted, both with no answers), and the assertion below needs to say *whose*
    // report came back. A timestamp two milliseconds apart would make that a race.
    const alice = await createSubmission(cohort.id, {
      rollNumberRaw: '2021-001',
      studentName: 'Alice Example',
      status: 'submitted',
      submittedAt: new Date('2026-01-01T00:00:00.000Z'),
    });
    const bob = await createSubmission(cohort.id, {
      rollNumberRaw: '2021-002',
      studentName: 'Bob Example',
      status: 'submitted',
      submittedAt: new Date('2026-01-02T00:00:00.000Z'),
    });

    return { alice, bob, aliceAgent: await verifiedStudent('2021-001', 'Alice Example') };
  }

  it('refuses a report to a caller with no session', async () => {
    const response = await request(createApp()).get('/api/student/report').expect(401);

    expect(response.body).toEqual({ error: 'Authentication required' });
  });

  it('has no report route that takes an id, so there is nothing to guess', async () => {
    // The URL NFR-SEC-009 exists to prevent. It is a 404 because the route does not exist, which is
    // a different and stronger statement than a refusal would be.
    const { bob } = await twoStudents();

    for (const path of [
      `/api/student/report/${bob.id}`,
      `/api/student/reports/${bob.id}`,
      `/api/student/report/${bob.rollNumberNormalized}`,
    ]) {
      await request(createApp()).get(path).expect(404);
    }
  });

  it('ignores a submission id supplied as a query parameter', async () => {
    // The other way a caller might try to name someone else's record: no path segment, so no route
    // parameter to reject — the id simply is not read by anything. Asserted with a live session, so
    // the response is a report and the only question is *whose*.
    const { alice, bob, aliceAgent } = await twoStudents();

    for (const query of [
      `?submissionId=${bob.id}`,
      `?id=${bob.id}`,
      `?submission=${bob.id}`,
    ]) {
      const response = await aliceAgent.get(`/api/student/report${query}`).expect(200);

      expect(response.body.deterministic).toBeDefined();

      // Alice's own report either way — but the assertion that matters is that it is not Bob's, and
      // that it is the same report with and without the parameter.
      const clean = await aliceAgent.get('/api/student/report').expect(200);
      expect(response.body).toEqual(clean.body);
      expect(alice.id).not.toBe(bob.id);
    }
  });

  it('keeps serving Alice her own report while Bob holds a session of his own', async () => {
    // The end-to-end shape of the guarantee: two live sessions, one cookie each, and neither can be
    // pointed at the other because there is no request shape that names a submission. The assertion
    // is *whose* report came back, not merely that a report did.
    const { alice, bob, aliceAgent } = await twoStudents();

    const bobAgent = await verifiedStudent('2021-002', 'Bob Example');
    const aliceSession = await aliceAgent.get('/api/student/report').expect(200);
    const bobSession = await bobAgent.get('/api/student/report').expect(200);

    expect(aliceSession.body.submittedAt).toBe(alice.submittedAt?.toISOString() ?? null);
    expect(bobSession.body.submittedAt).toBe(bob.submittedAt?.toISOString() ?? null);
    expect(aliceSession.body.submittedAt).not.toBe(bobSession.body.submittedAt);

    // And no session at all is no report: the cookie is the only thing that says whose it is, so
    // there is nothing else a caller could supply to get one.
    const noCookie = await request(createApp()).get('/api/student/report').expect(401);
    expect(noCookie.body).toEqual({ error: 'Authentication required' });
    expect(STUDENT_SESSION_COOKIE).toBe('lexora_student_session');
  });

  it('requires identity re-verification to reach a report again, which is the only entry point', async () => {
    // Section 9: *"the only way to obtain a student session — for either the assessment or the
    // report — is through identity verification."* A returning student re-verifies and is handed a
    // session scoped to the submission their identity owns; there is no shortcut that skips it.
    const { alice } = await twoStudents();

    const fresh = await verifiedStudent('2021-001', 'Alice Example');
    const report = await fresh.get('/api/student/report').expect(200);

    expect(report.body.submittedAt).toBe(alice.submittedAt?.toISOString() ?? null);

    // And the identity must still match: right cohort and roll number with the wrong name is a
    // refusal, which is the combination requirement doing its work (Section 13).
    await request(createApp())
      .post('/api/session/student-verify')
      .send({ cohortCode: 'PILOT-2026', rollNumber: '2021-001', studentName: 'Not Alice' })
      .expect(400);
  });
});
