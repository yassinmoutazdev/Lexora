import type { RequestHandler } from 'express';
import { requireSession } from './requireSession.ts';

/**
 * Rejects any request that does not carry a live student session (ARCHITECTURE Section 9).
 *
 * Apply per route on the routers that mount `studentSessionMiddleware`. This is the sole access
 * mechanism for both the assessment and the report (Section 13) — there is no separate
 * "report session", and there is deliberately no ID-bearing student route to reach without it
 * (NFR-SEC-009), so this guard plus the session's `submissionId` is the whole authorization story
 * for a student endpoint.
 *
 * Route handlers read the identity with `getStudentSession(req)`; it is null-safe, but a route
 * behind this guard can rely on it being present.
 */
export const requireStudentSession: RequestHandler = requireSession('student');
