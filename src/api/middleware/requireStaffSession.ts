import type { RequestHandler } from 'express';
import { requireSession } from './requireSession.ts';

/**
 * Rejects any request that does not carry a live staff session (ARCHITECTURE Section 9,
 * Section 18 — canonical location for staff authentication/authorization).
 *
 * Apply per route on the staff router, which mounts `staffSessionMiddleware` itself. Every staff
 * endpoint in Section 10 except login uses it; there is one permission level in the MVP
 * (FR-STAFF-003), so there is nothing further to check once it passes.
 *
 * Route handlers read the identity with `getStaffSession(req)`, which is typed and null-safe — the
 * guard deliberately does not stash a second copy of the session on the request, because two ways
 * to read the same thing is how they end up disagreeing.
 */
export const requireStaffSession: RequestHandler = requireSession('staff');
