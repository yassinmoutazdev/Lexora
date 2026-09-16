import type { Cohort } from '@prisma/client';
import { getPrismaClient } from './prismaClient.ts';

/**
 * Data access for `Cohort` (ARCHITECTURE Section 18 — "Database access: src/data/*Repository.ts").
 *
 * Small on purpose: the only thing anything needs to do with a cohort today is turn the access
 * code a student typed into the row it identifies. Everything else about a cohort — its
 * submissions, its aggregate scores — is reached through the submission and dashboard queries that
 * already exist, so there is nothing to add here speculatively.
 */
export class CohortRepository {
  /**
   * Resolves a student-entered access code.
   *
   * `findUnique` rather than `findFirst` because `code` carries a unique constraint, so the
   * database guarantees this returns at most one row.
   *
   * The code is matched exactly as stored. It is an identifier the team hands out and the seed
   * prints, not free text, and ARCHITECTURE Section 13 is explicit that it is a cohort identifier
   * rather than a secret — so there is nothing to gain by being lenient with it, and a silent
   * case-insensitive match would make two different-looking codes resolve to one cohort.
   */
  async findByCode(code: string): Promise<Cohort | null> {
    return getPrismaClient().cohort.findUnique({ where: { code } });
  }
}

/** The process-wide repository instance. */
export const cohortRepository = new CohortRepository();
