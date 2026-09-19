import type { Cohort } from '@prisma/client';
import { getPrismaClient } from './prismaClient.ts';

/**
 * A cohort and how many submissions point at it.
 *
 * The count is on the read model rather than fetched per row: the cohorts list exists so a staff
 * member can see which access codes are in use, and a list of codes with no indication of whether
 * anyone has ever used one answers half the question it was opened to ask.
 */
export type CohortWithSubmissionCount = Cohort & { submissionCount: number };

/**
 * Data access for `Cohort` (ARCHITECTURE Section 18 — "Database access: src/data/*Repository.ts").
 *
 * Until cohort management was added this held only the two lookups a student's access code needs,
 * and said so: everything else about a cohort was reached through the submission and dashboard
 * queries, so there was nothing to add speculatively. `create` and `findAllWithSubmissionCounts`
 * are the two operations that turned out to be genuinely needed — creating an access code to hand
 * to a cohort, and listing the ones that exist.
 *
 * There is deliberately no `update` and no `delete`. Deleting a cohort that has submissions would
 * mean either cascading (destroying immutable submissions, which the product forbids) or refusing,
 * and changing a `code` locks out every student who was given the old one. Both need guardrails
 * designed before they need code, and neither is part of what this was built for.
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

  /**
   * Looks a cohort up by primary key.
   *
   * Distinct from `findByCode` because the two callers hold different things: a student typed a
   * code, while the staff submission view (T8.2.1) has a submission row carrying a `cohortId` and
   * needs the code and name to caption it. Resolving that through the code would mean reading the
   * id only to turn it back into the code the row already points at.
   */
  async findById(id: string): Promise<Cohort | null> {
    return getPrismaClient().cohort.findUnique({ where: { id } });
  }

  /**
   * Every cohort, with its submission count, ordered by code.
   *
   * Ordered by `code` rather than by `createdAt` because of what the list is for: a staff member
   * checking whether a code exists, or which of several they have already handed out, is looking
   * for a name they already know. Newest-first is the right order for a stream of records nobody
   * has seen before; this is a small set of identifiers being looked things up in.
   *
   * The count is a `_count` on the relation, so it is one query rather than one per row.
   */
  async findAllWithSubmissionCounts(): Promise<CohortWithSubmissionCount[]> {
    const rows = await getPrismaClient().cohort.findMany({
      orderBy: { code: 'asc' },
      include: { _count: { select: { submissions: true } } },
    });

    return rows.map(({ _count, ...cohort }) => ({
      ...cohort,
      submissionCount: _count.submissions,
    }));
  }

  /**
   * Inserts a cohort.
   *
   * No uniqueness check first. `code` carries a unique constraint, so a pre-check would only move
   * the race rather than close it — two staff members creating the same code at the same moment
   * would both pass a check and one would then fail on insert anyway. The constraint is the
   * authority, and `CohortService` turns the violation into the refusal the caller sees.
   */
  async create(input: { code: string; name: string }): Promise<Cohort> {
    return getPrismaClient().cohort.create({ data: input });
  }
}

/** The process-wide repository instance. */
export const cohortRepository = new CohortRepository();
