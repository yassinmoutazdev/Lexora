import type { StaffUser } from '@prisma/client';
import { getPrismaClient } from './prismaClient.ts';

/**
 * Data access for `StaffUser` (ARCHITECTURE Section 18 — "Database access: src/data/*Repository.ts").
 *
 * Read-only, and deliberately so. PRD FR-STAFF-002 and NFR-SEC-004 require staff accounts to be
 * created manually by the team, with no self-service or public registration path — so nothing in
 * the application writes this table, and there is no `create` here to be tempted into using from a
 * route. The seed script (T2.3.1) is the one thing that provisions a row, and it does so directly,
 * outside the request cycle.
 */
export class StaffUserRepository {
  /**
   * The staff row with this email, or null.
   *
   * The email is matched exactly as stored. It is an address the team provisions by hand, and
   * `email` carries a unique constraint, so `findUnique` is a genuine unique lookup rather than a
   * scan that might return one of several rows.
   */
  async findByEmail(email: string): Promise<StaffUser | null> {
    return getPrismaClient().staffUser.findUnique({ where: { email } });
  }
}

/** The process-wide repository instance. */
export const staffUserRepository = new StaffUserRepository();
