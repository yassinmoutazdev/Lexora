import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ZodError } from 'zod';
import { createApp } from '../../app.ts';
import { submissionRepository } from '../../data/SubmissionRepository.ts';
import { createCohort, createSubmission, useCleanTestDatabase } from '../../test/fixtures.ts';
import { UNAUTHORIZED_MESSAGE } from './requireSession.ts';

/**
 * The error-handling mapping (T9.1.1) — every failure class in ARCHITECTURE Section 11, driven
 * through the real assembled application.
 *
 * ## What is being tested, and why it is one file rather than five
 *
 * Section 11's table is a contract between a failure and what a browser is allowed to learn from it,
 * and its rows are answered in different places: a malformed body is refused by `validateBody` at the
 * boundary, an unauthenticated request by `requireSession`, a duplicate submit by the service that
 * treats it as success. What they share is the rule the table's closing principle states — nothing
 * internal reaches the browser — and that is a property of the *system*, not of any one middleware.
 * So it is asserted once, here, across every row, which is also what makes an accidental regression
 * in one of them visible as a failure of the mapping rather than only as a failure of that route.
 *
 * Every request goes through `createApp()`, so what is under test is the assembled application with
 * its real middleware order. The one row a request cannot produce by itself is an *unexpected*
 * failure, which is what `errorHandler` exists for; it is reached by making a real repository call
 * reject, so the error travels the path a genuine failure does — through the route's `catch`, into
 * `next(error)`, and into the handler.
 */

const COHORT_CODE = 'ERROR-MAPPING-COHORT';
const ROLL_NUMBER = '2021-001';
const STUDENT_NAME = 'Alice Example';

useCleanTestDatabase();

// The 500 cases replace a repository method for the duration of one test. Restored after every test
// so a spy cannot leak into the next one — an un-restored rejection mock would turn a real database
// call into a silent failure in a test that never asked for one.
afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * A client holding a live student session, and the draft that session names.
 *
 * The session is obtained the only way one can be — through `POST /api/session/student-verify` — so
 * the failure paths below are reached with the same middleware chain a real request traverses.
 * Without a session the student routes answer 401 in `requireStudentSession` and never reach a
 * handler at all, which would make an "unexpected failure" test pass for the wrong reason.
 */
async function verifiedStudent() {
  const cohort = await createCohort({ code: COHORT_CODE });
  await createSubmission(cohort.id, {
    rollNumberRaw: ROLL_NUMBER,
    studentName: STUDENT_NAME,
  });

  const agent = request.agent(createApp());

  await agent
    .post('/api/session/student-verify')
    .send({ cohortCode: COHORT_CODE, rollNumber: ROLL_NUMBER, studentName: STUDENT_NAME })
    .expect(200);

  return agent;
}

/**
 * Runs `fn` with everything written to stdout collected.
 *
 * The log line is observed where Section 16 says it goes — stdout, so Render's log dashboard can
 * read it — rather than through a test hook the production code would have to grow. `pino` writes
 * through `process.stdout` and `src/config/logger.ts` names that stream explicitly, so intercepting
 * it is enough and nothing about the logger's configuration changes to make it observable.
 *
 * This is a stdout interceptor rather than a spy on the call, which is what an earlier revision of
 * this file used while the handler still logged via `console.error`: vitest replaces `console` with
 * its own buffering object, so a `console.error` never reaches the stream underneath. `pino` does not
 * go through `console` at all, so there is nothing between this test and the real write.
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

/** The parsed JSON objects in captured output, one per log line. */
function logLines(output: string): Record<string, unknown>[] {
  return output
    .split('\n')
    .filter((line) => line.trim().startsWith('{'))
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe('failure classes in ARCHITECTURE Section 11', () => {
  it('answers a validation error with 400 and the field that is wrong', async () => {
    // Section 11, "Validation error": "400 with field-level message". This refusal is deliberately
    // specific where an identity refusal is not — see `validateBody` for why the two 400s say
    // different things.
    const response = await request(createApp())
      .post('/api/session/student-verify')
      .send({ cohortCode: COHORT_CODE, rollNumber: '   ', studentName: STUDENT_NAME })
      .expect(400);

    expect(response.body.error).toBe('Invalid request body');
    expect(response.body.details).toEqual([
      { field: 'rollNumber', message: 'rollNumber must not be blank' },
    ]);
  });

  it('answers an unmatched identity identically whichever field was actually wrong', async () => {
    // Section 11, "Student identity not found": the refusal "never reveals *which* field was wrong,
    // to avoid aiding guesswork against NFR-SEC-009". Identity here is a combination (Section 13), so
    // the two requests below are refused for genuinely different reasons — one names no cohort, the
    // other names a student whose name does not match the record — and the test is that the caller
    // cannot tell them apart.
    const cohort = await createCohort({ code: COHORT_CODE });
    await createSubmission(cohort.id, { rollNumberRaw: ROLL_NUMBER, studentName: STUDENT_NAME });

    const wrongCohort = await request(createApp())
      .post('/api/session/student-verify')
      .send({ cohortCode: 'NOT-A-COHORT', rollNumber: ROLL_NUMBER, studentName: STUDENT_NAME })
      .expect(400);

    const wrongName = await request(createApp())
      .post('/api/session/student-verify')
      .send({ cohortCode: COHORT_CODE, rollNumber: ROLL_NUMBER, studentName: 'Someone Else' })
      .expect(400);

    expect(wrongCohort.body).toEqual(wrongName.body);
    expect(wrongCohort.body).toEqual({
      error: "We couldn't find a matching record — check your details",
    });
  });

  it('answers a body the parser could not read with 400, not 500', async () => {
    // `express.json()` raises this one itself, before any route runs, and marks it as the caller's
    // fault. Section 11's table calls a malformed payload a validation error, so it has to keep its
    // 400: a handler that answered every unexpected error with a 500 would quietly reclassify a
    // client mistake as a server failure. There are no `details` here — there is no schema to name a
    // field from, because the body never parsed far enough to be checked against one.
    const response = await request(createApp())
      .post('/api/session/student-verify')
      .set('Content-Type', 'application/json')
      .send('{"cohortCode": "PILOT-2026", ')
      .expect(400);

    expect(response.headers['content-type']).toMatch(/application\/json/);
    expect(response.body).toEqual({ error: 'Invalid request body' });
  });

  it('answers a request with no session on a student route with 401', async () => {    const response = await request(createApp()).get('/api/student/draft').expect(401);

    expect(response.body).toEqual({ error: UNAUTHORIZED_MESSAGE });
  });

  it('answers a request with no session on a staff route with 401, and says nothing about the route', async () => {
    const response = await request(createApp()).get('/api/staff/dashboard').expect(401);

    // A staff refusal and a student refusal are the same response, so an unauthenticated caller
    // cannot learn which kind of route they found (Section 9).
    expect(response.body).toEqual({ error: UNAUTHORIZED_MESSAGE });
  });

  it('answers an unexpected failure with 500, a generic message, and JSON rather than HTML', async () => {
    // Section 11, "Database error": "500 with a generic 'something went wrong, your answers are
    // saved' … never leaks SQL/stack traces to the client". Before `errorHandler` existed this
    // response came from Express's built-in handler: `text/html`, with the stack embedded outside
    // production.
    const agent = await verifiedStudent();

    vi.spyOn(submissionRepository, 'findById').mockRejectedValue(
      new Error(
        'PrismaClientKnownRequestError: connection to 127.0.0.1:5432 refused — ' +
          'SELECT "public"."Submission"."id" FROM "public"."Submission" WHERE 1=1',
      ),
    );

    const response = await agent.get('/api/student/draft').expect(500);

    expect(response.headers['content-type']).toMatch(/application\/json/);
    expect(response.body).toEqual({
      error: 'Something went wrong — your answers are saved',
    });

    // Nothing about the failure itself survives into the body — not the driver, not the address, not
    // the statement, not a stack frame.
    const body = JSON.stringify(response.body);
    for (const leak of [
      'PrismaClientKnownRequestError',
      '127.0.0.1',
      'SELECT',
      'Submission',
      '.ts:',
    ]) {
      expect(body).not.toContain(leak);
    }
  });

  it('retains the full detail server-side, which is what makes the generic message a reduction', async () => {
    // The other half of the same contract: the browser is told nothing, the operator is told
    // everything — Section 11's Internal-handling column, "logged with full detail server-side".
    const agent = await verifiedStudent();

    vi.spyOn(submissionRepository, 'findById').mockRejectedValue(
      new Error('connect ECONNREFUSED 127.0.0.1:5432'),
    );

    const { result: response, output } = await captureStdout(() =>
      agent.get('/api/student/draft'),
    );

    expect(response.status).toBe(500);

    const [line] = logLines(output);

    // Which request failed.
    expect(line).toMatchObject({
      event: 'request_failed',
      method: 'GET',
      url: '/api/student/draft',
    });

    // And how — pino's `err` serializer, so the type, message and stack survive as fields. The body
    // the browser received contains none of this, which is the whole point of the pair of tests.
    expect(line?.['err']).toMatchObject({ type: 'Error', message: 'connect ECONNREFUSED 127.0.0.1:5432' });
    expect(String((line?.['err'] as Record<string, unknown>)['stack'])).toContain(
      'errorHandler.test.ts',
    );
  });

  it('refuses a schema failure that reaches it from outside validateBody with 400, not 500', async () => {
    // `validateBody` answers its own 400 before any handler runs; this is the backstop for a `zod`
    // parse failure raised *after* the boundary. Section 11 still calls that class "Validation
    // error", so it gets that row's status and field-level body rather than a 500 that would hide
    // what the caller got wrong.
    const agent = await verifiedStudent();

    vi.spyOn(submissionRepository, 'findById').mockRejectedValue(
      new ZodError([
        {
          code: 'invalid_type',
          expected: 'string',
          received: 'number',
          path: ['submissionId'],
          message: 'Expected string, received number',
        },
      ]),
    );

    const response = await agent.get('/api/student/draft').expect(400);

    expect(response.body.details).toEqual([
      { field: 'submissionId', message: 'Expected string, received number' },
    ]);
  });
});
