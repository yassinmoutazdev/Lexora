import type { Submission } from '@prisma/client';
import { getContentLoader, type ContentLoader } from '../../content/ContentLoader.ts';
import { cohortRepository, type CohortRepository } from '../../data/CohortRepository.ts';
import {
  submissionRepository,
  type SubmissionRepository,
} from '../../data/SubmissionRepository.ts';

/**
 * Student identity resolution (ARCHITECTURE Section 1, Section 18 — canonical location for
 * "Student identity verification & session issuance").
 *
 * There are no student accounts (FR-STU-004), so this is the whole of what stands in for one: a
 * student identifies themselves by knowing a cohort code, a roll number, and the name recorded
 * against it, and what they get back is the single `Submission` row that identity owns. The
 * session that authorizes the assessment and the report is built on that reference (T3.2.2); this
 * service issues nothing itself.
 *
 * ## What "verify against stored records" means when a first visit has no record to check
 *
 * PRD Section 8.1 is explicit that a first-time student types their details and starts the
 * assessment — there is nothing yet to check them against. So the check has two shapes:
 *
 * - **No submission yet for (cohort, roll number):** the cohort code must name a real cohort, and
 *   the submission is created from what the student typed. Registration and identity verification
 *   are the same step, which is what "no accounts" costs.
 * - **A submission already exists:** the supplied name must agree with the name stored on it. This
 *   is the case Section 13 describes — the protection against one student reading another's report
 *   is the *combination* of cohort + roll number + name, not the roll number alone.
 *
 * A mismatch of any of the three produces the same answer, so a caller can never learn which field
 * was wrong (Section 11).
 *
 * ## Comparing the name
 *
 * The roll number is normalized to trimmed-and-lowercased before it is used as a key, which the
 * schema itself documents (`rollNumberNormalized`) and which is what makes the one-submission
 * guarantee hold across "2021-001" and "2021-001 ".
 *
 * The name is compared the same way — trimmed, case-insensitively — while being *stored* exactly
 * as typed. FR-STU-003 makes the roll number the primary separator and the name supporting
 * information, and the stricter reading costs a real lockout: FR-STU-006/007 together mean a
 * student whose name is on file can see their report and cannot start a new attempt, so a
 * returning student who capitalizes differently would be permanently unable to reach their own
 * work. Matching case-insensitively still requires knowing the name, so it takes nothing away from
 * the combination that is doing the protecting.
 */

/** What a student types on the entry page (PRD Section 8.1). */
export type StudentIdentityInput = {
  cohortCode: string;
  /** As typed. Stored verbatim for display; normalized only for lookup. */
  rollNumber: string;
  /** As typed. Stored verbatim for display; normalized only for comparison. */
  studentName: string;
};

/**
 * Either the submission this identity owns, or a refusal.
 *
 * A discriminated union rather than an exception: "no match" is an ordinary product outcome
 * (Section 11 gives it its own generic message and its own rate limit), not a failure, and the
 * caller has to handle it either way. Spelling it as a return value also means a route cannot
 * forget to.
 */
export type StudentIdentityResolution =
  | { outcome: 'resolved'; submission: Submission }
  | { outcome: 'no_match' };

export type StudentIdentityDeps = {
  cohorts: CohortRepository;
  submissions: SubmissionRepository;
  content: ContentLoader;
};

const NO_MATCH: StudentIdentityResolution = { outcome: 'no_match' };

/**
 * The lookup key for a roll number: trimmed and lowercased (ARCHITECTURE Section 6).
 *
 * Exported because this is the single definition of the uniqueness key. `SubmissionRepository`
 * takes the normalized value as a given rather than deriving it from the raw one, so that this
 * computation exists once and cannot drift from what the database constraint compares.
 */
export function normalizeRollNumber(rollNumber: string): string {
  return rollNumber.trim().toLowerCase();
}

/** The form in which two names count as the same name. */
function nameComparisonKey(studentName: string): string {
  return studentName.trim().toLowerCase();
}

export class StudentIdentityService {
  private readonly deps: StudentIdentityDeps;

  constructor(deps: StudentIdentityDeps) {
    this.deps = deps;
  }

  /**
   * Resolves an identity to the submission it owns, creating a draft when it owns none yet.
   *
   * Idempotent by construction: resolving the same identity twice finds the row the first call
   * created rather than making a second one, and two calls that arrive together are settled by the
   * database's unique constraint rather than by luck (see `createDraftIfAbsent`).
   */
  async resolve(input: StudentIdentityInput): Promise<StudentIdentityResolution> {
    const cohort = await this.deps.cohorts.findByCode(input.cohortCode.trim());

    // An unrecognized cohort code is indistinguishable, to the caller, from an unrecognized roll
    // number or name — one refusal, one message (Section 11).
    if (!cohort) return NO_MATCH;

    const rollNumberNormalized = normalizeRollNumber(input.rollNumber);
    const existing = await this.deps.submissions.findByCohortAndRollNumber(
      cohort.id,
      rollNumberNormalized,
    );

    if (existing) return this.matchAgainst(existing, input.studentName);

    // No row for this identity yet, so this is a first visit, and it starts a draft under the
    // version that is current *now* — frozen there for the life of the submission (Section 12).
    const submission = await this.deps.submissions.createDraftIfAbsent({
      cohortId: cohort.id,
      rollNumberRaw: input.rollNumber,
      rollNumberNormalized,
      studentName: input.studentName,
      contentVersion: this.deps.content.getCurrentVersion(),
    });

    // Checked here as well as above, and not skipped for the newly created row: if two first
    // visits raced, the row that came back may be the other caller's, in which case this name is
    // not the name on file and the answer is the same refusal.
    return this.matchAgainst(submission, input.studentName);
  }

  /** The name check, applied identically to a found row and a raced one. */
  private matchAgainst(submission: Submission, studentName: string): StudentIdentityResolution {
    if (nameComparisonKey(submission.studentName) !== nameComparisonKey(studentName)) {
      return NO_MATCH;
    }

    return { outcome: 'resolved', submission };
  }
}

let instance: StudentIdentityService | undefined;

/**
 * The process-wide service, wired to the shared repositories and content loader.
 *
 * Lazy rather than constructed at module load, so that importing this module does not read the
 * content tree — the same property `getContentLoader()` keeps, and the reason a unit test can
 * import the service without depending on the repository's content files.
 */
export function getStudentIdentityService(): StudentIdentityService {
  instance ??= new StudentIdentityService({
    cohorts: cohortRepository,
    submissions: submissionRepository,
    content: getContentLoader(),
  });

  return instance;
}
