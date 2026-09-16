import express from 'express';
import type { Express, NextFunction, Request, Response } from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  STAFF_SESSION_COOKIE,
  STAFF_SESSION_TTL_MS,
  STUDENT_SESSION_COOKIE,
  STUDENT_SESSION_IDLE_TTL_MS,
  clearStaffSession,
  clearStudentSession,
  getStaffSession,
  getStudentSession,
  issueStaffSession,
  issueStudentSession,
  staffSessionMiddleware,
  studentSessionMiddleware,
} from './session.ts';

/**
 * Unit tests for the two session types (T3.1.1).
 *
 * These are deliberately *unit* tests: no database, no domain service, just the middleware and the
 * cookie contract it produces. What they establish is the contract — distinct cookie identity,
 * distinct lifetimes, one session never readable as the other, and the two middlewares refusing to
 * share a request. Enforcement at the route level (`requireStaffSession` / `requireStudentSession`
 * rejecting the wrong session type) is T3.1.3's test, against routers that exist for it.
 *
 * Time is faked with `toFake: ['Date']` rather than full fake timers: only `Date.now()` drives the
 * cookie `expires` attribute, and supertest still needs real I/O timers to make its requests.
 */

/** A `Set-Cookie` header split into its name, value, and attributes. */
type ParsedCookie = {
  name: string;
  value: string;
  attributes: Record<string, string | true>;
  expiresAt: Date | null;
};

function parseSetCookie(header: string): ParsedCookie {
  const [pair = '', ...attributeParts] = header.split(';');
  const separator = pair.indexOf('=');
  const attributes: Record<string, string | true> = {};

  for (const part of attributeParts) {
    const attribute = part.trim();
    if (!attribute) continue;

    const index = attribute.indexOf('=');

    if (index === -1) attributes[attribute.toLowerCase()] = true;
    else attributes[attribute.slice(0, index).toLowerCase()] = attribute.slice(index + 1);
  }

  const expires = attributes['expires'];

  return {
    name: pair.slice(0, separator),
    value: pair.slice(separator + 1),
    attributes,
    expiresAt: typeof expires === 'string' ? new Date(expires) : null,
  };
}

function setCookieHeaders(response: request.Response): string[] {
  const header = response.headers['set-cookie'];
  if (!header) return [];

  return Array.isArray(header) ? header : [header];
}

function cookiesOf(response: request.Response): ParsedCookie[] {
  return setCookieHeaders(response).map(parseSetCookie);
}

function cookieNames(response: request.Response): string[] {
  return cookiesOf(response)
    .map((cookie) => cookie.name)
    .sort();
}

/**
 * The value cookie and the signature cookie it is verified with.
 *
 * `cookie-session` signs the payload rather than encrypting it, and the `cookies` library emits
 * the value and its signature as two separate `Set-Cookie` headers. Both are one session.
 */
function signedCookiePair(name: string): string[] {
  return [name, `${name}.sig`].sort();
}

function cookieNamed(response: request.Response, name: string): ParsedCookie {
  const cookie = cookiesOf(response).find((candidate) => candidate.name === name);

  if (!cookie) {
    throw new Error(
      `No ${name} cookie on the response. Set-Cookie headers were: ` +
        JSON.stringify(setCookieHeaders(response)),
    );
  }

  return cookie;
}

/**
 * A minimal app mounting the session middleware exactly as ARCHITECTURE Section 9 prescribes —
 * each on its own router path, never globally — plus routes that exercise issuance, clearing, and
 * reading so the tests can observe all three over real HTTP.
 */
function createHarness(): Express {
  const app = express();

  app.use('/staff', staffSessionMiddleware);
  app.use('/student', studentSessionMiddleware);

  app.post('/staff/login', (req, res) => {
    issueStaffSession(req, 'staff-user-1');
    res.json({ own: getStaffSession(req), other: getStudentSession(req) });
  });

  app.post('/staff/logout', (req, res) => {
    clearStaffSession(req);
    res.json({ own: getStaffSession(req) });
  });

  app.get('/staff/whoami', (req, res) => {
    res.json({ own: getStaffSession(req), other: getStudentSession(req) });
  });

  app.post('/student/verify', (req, res) => {
    issueStudentSession(req, 'submission-1');
    res.json({ own: getStudentSession(req), other: getStaffSession(req) });
  });

  app.post('/student/logout', (req, res) => {
    clearStudentSession(req);
    res.json({ own: getStudentSession(req) });
  });

  app.get('/student/whoami', (req, res) => {
    res.json({ own: getStudentSession(req), other: getStaffSession(req) });
  });

  return app;
}

const T0 = new Date('2026-03-01T09:00:00.000Z');

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('session issuance', () => {
  it('issues a staff session under its own cookie, HttpOnly and SameSite=Lax, expiring in 8 hours', async () => {
    const response = await request(createHarness()).post('/staff/login').expect(200);

    // The staff session and its signature, and nothing else: the two session types never travel
    // together on one response.
    expect(cookieNames(response)).toEqual(signedCookiePair(STAFF_SESSION_COOKIE));

    const cookie = cookieNamed(response, STAFF_SESSION_COOKIE);

    expect(cookie.name).not.toBe(STUDENT_SESSION_COOKIE);
    expect(cookie.attributes['httponly']).toBe(true);
    expect(cookie.attributes['samesite']).toBe('lax');
    expect(cookie.expiresAt).toEqual(new Date(T0.getTime() + STAFF_SESSION_TTL_MS));
    expect(STAFF_SESSION_TTL_MS).toBe(8 * 60 * 60 * 1000);

    // The session is readable by its own kind, and is the identity that was issued.
    expect(response.body).toEqual({
      own: { staffUserId: 'staff-user-1' },
      other: null,
    });
  });

  it('issues a student session under a different cookie, expiring in 30 minutes', async () => {
    const response = await request(createHarness()).post('/student/verify').expect(200);

    expect(cookieNames(response)).toEqual(signedCookiePair(STUDENT_SESSION_COOKIE));

    const cookie = cookieNamed(response, STUDENT_SESSION_COOKIE);

    expect(cookie.name).not.toBe(STAFF_SESSION_COOKIE);
    expect(cookie.attributes['httponly']).toBe(true);
    expect(cookie.attributes['samesite']).toBe('lax');
    expect(cookie.expiresAt).toEqual(new Date(T0.getTime() + STUDENT_SESSION_IDLE_TTL_MS));
    expect(STUDENT_SESSION_IDLE_TTL_MS).toBe(30 * 60 * 1000);

    // Scoped to exactly one submission, and it exposes nothing else.
    expect(response.body).toEqual({
      own: { submissionId: 'submission-1' },
      other: null,
    });

    expect(STAFF_SESSION_COOKIE).not.toBe(STUDENT_SESSION_COOKIE);
  });

  it('does not mark the cookie Secure on a plain-HTTP request', async () => {
    // Local development runs over http://localhost. Forcing `secure: true` here would make the
    // underlying cookies library throw, so the attribute is set from the connection instead —
    // see the module documentation. The TLS case is covered separately below.
    const response = await request(createHarness()).post('/staff/login').expect(200);

    expect(cookieNamed(response, STAFF_SESSION_COOKIE).attributes['secure']).toBeUndefined();
  });

  it('marks the cookie Secure when the request arrived over TLS', async () => {
    const app = express();
    // Render terminates TLS at its proxy, so Express only sees the original scheme once told to
    // trust that hop. This is the deployment shape the Secure attribute depends on.
    app.set('trust proxy', 1);
    app.use('/staff', staffSessionMiddleware);
    app.post('/staff/login', (req, res) => {
      issueStaffSession(req, 'staff-user-1');
      res.json({ ok: true });
    });

    const overTls = await request(app)
      .post('/staff/login')
      .set('X-Forwarded-Proto', 'https')
      .expect(200);

    expect(cookieNamed(overTls, STAFF_SESSION_COOKIE).attributes['secure']).toBe(true);
  });
});

describe('session lifetimes', () => {
  it('renews the student session on use but leaves the staff session absolute', async () => {
    const app = createHarness();
    const staff = request.agent(app);
    const student = request.agent(app);

    const staffLogin = await staff.post('/staff/login').expect(200);
    const studentVerify = await student.post('/student/verify').expect(200);

    expect(cookieNamed(staffLogin, STAFF_SESSION_COOKIE).expiresAt).toEqual(
      new Date(T0.getTime() + STAFF_SESSION_TTL_MS),
    );
    expect(cookieNamed(studentVerify, STUDENT_SESSION_COOKIE).expiresAt).toEqual(
      new Date(T0.getTime() + STUDENT_SESSION_IDLE_TTL_MS),
    );

    // Ten minutes of activity, still well inside the student's window.
    const tenMinutesLater = new Date(T0.getTime() + 10 * 60 * 1000);
    vi.setSystemTime(tenMinutesLater);

    const staffRead = await staff.get('/staff/whoami').expect(200);
    const studentRead = await student.get('/student/whoami').expect(200);

    expect(staffRead.body).toEqual({ own: { staffUserId: 'staff-user-1' }, other: null });
    expect(studentRead.body).toEqual({ own: { submissionId: 'submission-1' }, other: null });

    // Staff is absolute: an authenticated read does not re-issue the cookie at all, so the
    // 8-hour window cannot be extended by using the dashboard.
    expect(setCookieHeaders(staffRead)).toEqual([]);

    // Student is idle-based: the cookie comes back with a full window measured from *now*.
    expect(cookieNamed(studentRead, STUDENT_SESSION_COOKIE).expiresAt).toEqual(
      new Date(tenMinutesLater.getTime() + STUDENT_SESSION_IDLE_TTL_MS),
    );
  });
});

describe('session isolation', () => {
  it('does not let a staff session be read as a student session', async () => {
    const app = createHarness();
    const staff = request.agent(app);
    await staff.post('/staff/login').expect(200);

    // The same client now presents its staff cookie to a student route. It carries no student
    // session, so neither accessor yields anything — holding one session grants nothing of the
    // other, which is Section 9's "neither session type grants access to the other's routes" as
    // it is expressed in this module.
    const response = await staff.get('/student/whoami').expect(200);

    expect(response.body).toEqual({ own: null, other: null });
  });

  it('does not let a student session be read as a staff session', async () => {
    const app = createHarness();
    const student = request.agent(app);
    await student.post('/student/verify').expect(200);

    const response = await student.get('/staff/whoami').expect(200);

    expect(response.body).toEqual({ own: null, other: null });
  });

  it('refuses to run both session middlewares on one request', async () => {
    // The mis-configuration ARCHITECTURE Section 9 warns about: mounting the sessions globally
    // instead of per router. `cookie-session` would silently discard the outer session, so this
    // is turned into an explicit failure instead.
    const app = express();
    const captured: Error[] = [];

    app.use(staffSessionMiddleware);
    app.use(studentSessionMiddleware);
    app.get('/both', (_req, res) => {
      res.json({ ok: true });
    });
    app.use((error: Error, _req: Request, res: Response, _next: NextFunction) => {
      captured.push(error);
      res.status(500).json({ error: error.message });
    });

    const response = await request(app).get('/both').expect(500);

    expect(captured).toHaveLength(1);
    expect(response.body.error).toMatch(/both ran on one request/);
  });

  it('refuses to issue a session of a kind this request is not scoped to', async () => {
    // A router that forgot its session middleware: issuing would silently write to a plain
    // request property and the resulting "logged in" student would keep being rejected. Throwing
    // makes the mis-mount visible at the moment it is exercised.
    const app = express();
    app.post('/unscoped', (req, res) => {
      issueStudentSession(req, 'submission-1');
      res.json({ ok: true });
    });

    await request(app).post('/unscoped').expect(500);
  });
});

describe('session clearing', () => {
  it('clears the staff session and stops reading it', async () => {
    const app = createHarness();
    const staff = request.agent(app);
    await staff.post('/staff/login').expect(200);
    await staff.get('/staff/whoami').expect(200, { own: { staffUserId: 'staff-user-1' }, other: null });

    const logout = await staff.post('/staff/logout').expect(200);

    expect(logout.body).toEqual({ own: null });
    // cookie-session expires the cookie rather than leaving a readable value behind.
    expect(cookieNamed(logout, STAFF_SESSION_COOKIE).expiresAt).toEqual(new Date(0));
    await staff.get('/staff/whoami').expect(200, { own: null, other: null });
  });

  it('clears the student session and stops reading it', async () => {
    const app = createHarness();
    const student = request.agent(app);
    await student.post('/student/verify').expect(200);

    const logout = await student.post('/student/logout').expect(200);

    expect(logout.body).toEqual({ own: null });
    expect(cookieNamed(logout, STUDENT_SESSION_COOKIE).expiresAt).toEqual(new Date(0));
    await student.get('/student/whoami').expect(200, { own: null, other: null });
  });
});
