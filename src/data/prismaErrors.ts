/**
 * Recognising the database's own refusals.
 *
 * Two repositories now depend on the same one — a submission whose `(cohortId,
 * rollNumberNormalized)` pair already exists, and a cohort whose `code` already exists — and both
 * need to turn it into a domain outcome rather than a 500. It lives here rather than in either of
 * them because the alternative is the same three-line check written twice, and the day one of them
 * learns about a second constraint the other would not.
 *
 * The code is read structurally rather than by importing Prisma's error class, so this stays a
 * check on the constraint rather than a dependency on a runtime subpath — which is how
 * `SubmissionRepository` has done it since it needed to.
 */

/** Whether an error is Postgres' unique-constraint violation (`P2002`) as Prisma reports it. */
export function isUniqueConstraintViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'P2002'
  );
}
