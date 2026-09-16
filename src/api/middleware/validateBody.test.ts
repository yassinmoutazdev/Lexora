import express from 'express';
import type { Express } from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { requiredText, validateBody } from './validateBody.ts';

/**
 * Tests for the request-body validation middleware (T3.2.3).
 *
 * These exercise the middleware's own contract — reject with a field-level 400, strip unknown
 * keys, leave accepted values alone — against a throwaway route, so the behaviour is pinned down
 * independently of any one endpoint. The endpoint-level consequence (`student-verify` refusing a
 * malformed body before the identity service runs) is covered in `session.routes.test.ts`.
 */

const schema = z.object({
  cohortCode: requiredText('cohortCode'),
  rollNumber: requiredText('rollNumber'),
  studentName: requiredText('studentName'),
});

/** A route behind the middleware that records the exact body it was handed. */
function createProbeApp(): { app: Express; reached: unknown[] } {
  const app = express();
  const reached: unknown[] = [];

  app.use(express.json());
  app.post('/probe', validateBody(schema), (req, res) => {
    reached.push(req.body);
    res.json({ body: req.body });
  });

  return { app, reached };
}

describe('validateBody — accepted requests', () => {
  it('passes a well-formed body through to the handler', async () => {
    const { app, reached } = createProbeApp();

    const response = await request(app)
      .post('/probe')
      .send({ cohortCode: 'PILOT-2026', rollNumber: '2021-001', studentName: 'Alice Example' })
      .expect(200);

    expect(response.body).toEqual({
      body: { cohortCode: 'PILOT-2026', rollNumber: '2021-001', studentName: 'Alice Example' },
    });
    expect(reached).toHaveLength(1);
  });

  it('leaves accepted values exactly as they arrived', async () => {
    // The schemas behind this middleware deliberately do not transform. The service stores the
    // roll number as typed for display and normalizes only what it compares, so a middleware that
    // trimmed here would record a "raw" value nobody typed.
    const { app } = createProbeApp();

    const response = await request(app)
      .post('/probe')
      .send({ cohortCode: '  PILOT-2026 ', rollNumber: '  CS-2021-001  ', studentName: ' Alice ' })
      .expect(200);

    expect(response.body.body).toEqual({
      cohortCode: '  PILOT-2026 ',
      rollNumber: '  CS-2021-001  ',
      studentName: ' Alice ',
    });
  });

  it('drops fields the schema does not declare', async () => {
    const { app } = createProbeApp();

    const response = await request(app)
      .post('/probe')
      .send({
        cohortCode: 'PILOT-2026',
        rollNumber: '2021-001',
        studentName: 'Alice Example',
        // A request must not be able to smuggle anything past the schema into a service.
        submissionId: 'somebody-elses-id',
        status: 'submitted',
      })
      .expect(200);

    expect(response.body.body).toEqual({
      cohortCode: 'PILOT-2026',
      rollNumber: '2021-001',
      studentName: 'Alice Example',
    });
  });
});

describe('validateBody — rejected requests', () => {
  it('rejects a missing field with a field-level message and does not reach the handler', async () => {
    const { app, reached } = createProbeApp();

    const response = await request(app)
      .post('/probe')
      .send({ cohortCode: 'PILOT-2026', rollNumber: '2021-001' })
      .expect(400);

    expect(response.body).toEqual({
      error: 'Invalid request body',
      details: [{ field: 'studentName', message: 'studentName is required' }],
    });
    // Section 10: malformed input never reaches business logic.
    expect(reached).toEqual([]);
  });

  it('rejects a non-string field rather than letting it through as a wrong type', async () => {
    const { app, reached } = createProbeApp();

    const response = await request(app)
      .post('/probe')
      .send({ cohortCode: 'PILOT-2026', rollNumber: 2021001, studentName: 'Alice Example' })
      .expect(400);

    expect(response.body.details).toEqual([
      { field: 'rollNumber', message: 'rollNumber must be a string' },
    ]);
    expect(reached).toEqual([]);
  });

  it('rejects a field that is present but blank', async () => {
    // A whitespace-only roll number would otherwise be a valid key, and would create a submission
    // that could never be looked up again.
    const { app, reached } = createProbeApp();

    const response = await request(app)
      .post('/probe')
      .send({ cohortCode: 'PILOT-2026', rollNumber: '   ', studentName: 'Alice Example' })
      .expect(400);

    expect(response.body.details).toEqual([
      { field: 'rollNumber', message: 'rollNumber must not be blank' },
    ]);
    expect(reached).toEqual([]);
  });

  it('reports every malformed field at once', async () => {
    // One round trip should be enough to learn everything wrong with a body, rather than the
    // frontend discovering the problems one rejection at a time.
    const { app } = createProbeApp();

    const response = await request(app).post('/probe').send({}).expect(400);

    expect(response.body.details).toEqual([
      { field: 'cohortCode', message: 'cohortCode is required' },
      { field: 'rollNumber', message: 'rollNumber is required' },
      { field: 'studentName', message: 'studentName is required' },
    ]);
  });

  it('rejects a body that is not an object, naming the body itself as the problem', async () => {
    // A bare scalar never gets this far — `express.json()` runs in strict mode and rejects a
    // top-level string or number before any route middleware sees it. An array does get through,
    // so this is the case the schema has to handle, and `(root)` is the field name it reports.
    const { app, reached } = createProbeApp();

    const response = await request(app).post('/probe').send([]).expect(400);

    expect(response.body).toEqual({
      error: 'Invalid request body',
      details: [{ field: '(root)', message: 'Expected object, received array' }],
    });
    expect(reached).toEqual([]);
  });
});
