import type { Cohort } from '@prisma/client';
import {
  cohortRepository,
  type CohortRepository,
  type CohortWithSubmissionCount,
} from '../../data/CohortRepository.ts';
import { isUniqueConstraintViolation } from '../../data/prismaErrors.ts';
import { normaliseCohortCode } from '../../shared/cohortCode.ts';

/**
 * Cohort provisioning (ARCHITECTURE Section 18 — "Cohort provisioning: src/domain/staff/CohortService.ts").
 *
 * Staff create the access codes students type on the entry page (FR-STU-001). This service owns the
 * two rules that make a code usable — it has to be unique, and it has to be something a student can
 * be handed and type back exactly — and the route above it only moves values.
 *
 * ## Why the code is normalised, and where that rule lives
 *
 * `CohortRepository.findByCode` matches the stored code **exactly**, deliberately: it is an
 * identifier the team hands out, not free text, and a lenient match would let two different-looking
 * codes resolve to one cohort. That makes whatever is stored the thing every student must type
 * character for character — so a code created as `pilot-2027` would require students to type
 * lowercase, and the first person handed it would be told "we couldn't find a matching record" for
 * getting the case wrong.
 *
 * Codes are therefore stored upper-cased and trimmed — that is what the existing `PILOT-2026`
 * already looks like, and what an access code is expected to look like. The rule itself lives in
 * `src/shared/cohortCode.ts` rather than here, because the confirmation dialog in the staff form
 * has to show the same string before it is written; one definition means the preview cannot drift
 * from what the server stores.
 *
 * Because that normalisation changes what the staff member typed, the confirmation shows the
 * resulting code rather than the input. A normalisation nobody is shown is a normalisation that
 * produces a support ticket.
 *
 * ## Why a duplicate is caught rather than checked for
 *
 * `code` carries a unique constraint, so a check-then-insert would only narrow the race rather than
 * close it: two staff creating the same code at once would both pass the check and one insert would
 * still fail. The constraint is the authority, and the violation is turned into an outcome here.
 */

export type CohortServiceDeps = {
  cohorts: CohortRepository;
};

/**
 * The outcome of a creation attempt.
 *
 * `duplicate_code` is an outcome rather than an error because it is an ordinary thing to try — two
 * cohorts whose codes differ only in case, or a code already given out — and the route turns it
 * into a refusal the staff member can act on.
 */
export type CreateCohortResult =
  | { outcome: 'created'; cohort: Cohort }
  /**
   * `code` is the **normalised** code that clashed, not what the caller sent. The refusal quotes it
   * so a staff member who typed `pilot-2027` and was told it exists learns why — the same
   * normalisation that made it collide is the one they need to know about.
   */
  | { outcome: 'duplicate_code'; code: string };

export class CohortService {
  private readonly deps: CohortServiceDeps;

  constructor(deps: CohortServiceDeps) {
    this.deps = deps;
  }

  /**
   * Creates a cohort, or reports that its code is taken.
   *
   * The name is trimmed and otherwise left alone — unlike the code it is a label a staff member
   * reads, not a value a student types, so there is nothing for a normalising rule to protect.
   *
   * A violation that is *not* the code constraint is rethrown rather than reported as a duplicate,
   * for the reason `SubmissionRepository.createDraftIfAbsent` gives about its own: swallowing it
   * would hide a genuine failure behind a plausible-looking refusal.
   */
  async createCohort(input: { code: string; name: string }): Promise<CreateCohortResult> {
    const code = normaliseCohortCode(input.code);

    try {
      const cohort = await this.deps.cohorts.create({ code, name: input.name.trim() });

      return { outcome: 'created', cohort };
    } catch (error) {
      if (isUniqueConstraintViolation(error)) return { outcome: 'duplicate_code', code };

      throw error;
    }
  }

  /** Every cohort with its submission count, ordered by code. */
  async listCohorts(): Promise<CohortWithSubmissionCount[]> {
    return this.deps.cohorts.findAllWithSubmissionCounts();
  }
}

let instance: CohortService | undefined;

/** The process-wide service instance, wired the same way `getDashboardService` is. */
export function getCohortService(): CohortService {
  instance ??= new CohortService({ cohorts: cohortRepository });

  return instance;
}
