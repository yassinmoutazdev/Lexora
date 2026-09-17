import express from 'express';
import { logger } from '../config/logger.ts';
import { pingDatabase } from '../data/prismaClient.ts';

/**
 * `GET /health` — the keep-warm ping target (T9.2.2).
 *
 * ARCHITECTURE Section 16: *"an external free scheduled ping (e.g., a GitHub Actions workflow hitting
 * a `/health` endpoint — which itself performs a trivial DB query — every ~10 minutes) keeps both
 * Render and Supabase warm at no additional cost."* The query is what makes the endpoint worth
 * pinging: Render sleeps after 15 minutes of inactivity and Supabase pauses after 7 days, so a ping
 * that only proved Express was awake would keep the web service up while the database it needs went
 * cold — leaving a student's first request to pay both wake-up costs and fail if the database was
 * still resuming.
 *
 * ## This is not an API endpoint, and Section 10's table is not missing a row
 *
 * It is deliberately **not** under `/api`. Section 10 fixes the API at ten endpoints, each one a real
 * user action with a zod-validated body and a session contract; this is an operational probe with no
 * session, no body, and no client. Giving it a contract row would invite a caller to treat it as one.
 *
 * ## Why the failure is answered here instead of delegated to `errorHandler`
 *
 * Every other route ends with `next(error)`, and this one deliberately does not. A failed ping is not
 * this *request* going wrong — it is the answer the request asked for, and the monitor reading it
 * needs a status that says "this instance cannot serve", not Express's generic 500 body for an
 * unexpected failure. So the refusal is 503 Service Unavailable, and it is generic per Section 11:
 * a caller outside the deployment learns that the service is unavailable and nothing about the
 * connection string, the driver, or the schema. The full detail goes to the log, which is where
 * Section 11's table puts it.
 *
 * ## The 200 body is deliberately thin
 *
 * `{ status: 'ok' }` and nothing else. An uptime check reads the status code; anything richer would
 * be an unauthenticated description of the deployment (version, uptime, dependency states) on a
 * route that anyone can reach.
 */

/**
 * The 503 body — generic, per Section 11, and phrased for the operator reading a monitor's alert
 * rather than for a student, because no student has any reason to be here.
 */
const UNAVAILABLE_MESSAGE = 'Service unavailable';

export const healthRouter = express.Router();

/**
 * Answers 200 only when the database actually answered.
 *
 * `pingDatabase` runs a trivial query through the same Prisma client the application uses, so a 200
 * means the process is up *and* the pool can reach Postgres — the two things a keep-warm ping exists
 * to keep true.
 */
healthRouter.get('/', async (_req, res) => {
  try {
    await pingDatabase();

    res.json({ status: 'ok' });
  } catch (error) {
    logger.error({ event: 'health_check_failed', err: error }, 'health check failed');

    res.status(503).json({ error: UNAVAILABLE_MESSAGE });
  }
});
