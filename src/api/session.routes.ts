import express from 'express';
import { z } from 'zod';
import { issueStudentSession, studentSessionMiddleware } from '../auth/session.ts';
import { getStudentIdentityService } from '../domain/identity/StudentIdentityService.ts';
import { studentVerifyRateLimit } from './middleware/rateLimit.ts';
import { requiredText, validateBody } from './middleware/validateBody.ts';

/**
 * The session router — the one public endpoint that turns typed-in details into a student session
 * (ARCHITECTURE Section 10, Section 18).
 *
 * `POST /api/session/student-verify` is the only way to obtain a student session, and therefore
 * the only way into the assessment or the report (Section 9). There is no companion endpoint that
 * re-issues a session from an id, and no route anywhere that takes a submission id in its path —
 * that absence is the implementation of NFR-SEC-009, not an oversight to be filled in later.
 *
 * The router owns request parsing and session issuance. The decision about who a student *is*
 * belongs to `StudentIdentityService` (Section 1 — the API layer "never contains scoring logic or
 * SQL directly"), and this file must not grow a second opinion about it.
 */

/**
 * The refusal message for an identity that does not resolve (Section 11).
 *
 * Deliberately says nothing about *which* of the cohort code, roll number, or name was wrong. The
 * three are checked as a combination (Section 13), so any field-level detail would turn this
 * response into an oracle a student could use to discover the other two.
 */
const IDENTITY_NOT_FOUND_MESSAGE = "We couldn't find a matching record — check your details";

/**
 * The entry-page form (PRD Section 8.1): cohort access code, roll number, name.
 *
 * `requiredText` rather than a bare `z.string()` because a blank field is not a detail a student
 * is allowed to leave out — a whitespace-only roll number would otherwise be a valid key and could
 * create a submission nobody could ever look up again. It rejects blanks without rewriting the
 * values, so the service still receives them exactly as typed.
 */
const studentVerifyBodySchema = z.object({
  cohortCode: requiredText('cohortCode'),
  rollNumber: requiredText('rollNumber'),
  studentName: requiredText('studentName'),
});

export const sessionRouter = express.Router();

// Mounted on this router rather than globally: a student session is meaningless on a staff route
// and vice versa, and Section 9 requires the two access boundaries to stay separate. This is what
// lets the route below issue the cookie at all — `cookie-session` has to be in play before a
// handler can write a session.
sessionRouter.use(studentSessionMiddleware);

/**
 * Resolves an identity and issues the student session scoped to the submission it owns.
 *
 * The response is the submission's status and nothing else (Section 10): a `draft` sends the
 * student into the assessment, a `submitted` sends them to their report instead of a new attempt
 * (FR-STU-006, EDGE-003). The frontend decides the route to take; the server decides the status.
 *
 * `studentVerifyRateLimit` runs first (T3.3.3), so it counts every attempt against this route —
 * including malformed ones — before validation or the identity lookup. Then `validateBody`, so the
 * three fields are known to be present and non-blank by the time the service sees them (Section 10).
 */
sessionRouter.post('/student-verify', studentVerifyRateLimit, validateBody(studentVerifyBodySchema), async (req, res, next) => {
  try {
    // `req.body` is the schema's output by the time this runs, so the three fields are present,
    // non-blank strings — no re-checking here, and no second opinion about the request's shape.
    const resolution = await getStudentIdentityService().resolve({
      cohortCode: req.body.cohortCode,
      rollNumber: req.body.rollNumber,
      studentName: req.body.studentName,
    });

    if (resolution.outcome === 'no_match') {
      // A refusal issues no session: the student stays exactly as authenticated as they arrived.
      res.status(400).json({ error: IDENTITY_NOT_FOUND_MESSAGE });
      return;
    }

    issueStudentSession(req, resolution.submission.id);

    res.json({ status: resolution.submission.status });
  } catch (error) {
    // Express 4 does not forward rejections from an async handler on its own, so an unhandled
    // error here would hang the request rather than reach the error handler.
    next(error);
  }
});
