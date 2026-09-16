/**
 * The vocabulary of the job table (ARCHITECTURE Section 6, Section 8).
 *
 * ## Why this is its own module
 *
 * `ProcessingJob.jobType` is a plain string column, so the strings are the entire contract between
 * three modules that must agree: `SubmissionService` writes them, `JobService` reads them to decide
 * what a job means, and the worker loop reads them to decide which evaluation to run. Every one of
 * those spellings is the same string, and a second spelling is not a typo — it is work that is
 * enqueued under a name the worker never looks for, which fails as *silence*: the job sits pending,
 * the student's writing status never leaves `pending`, and nothing anywhere reports an error.
 *
 * So the strings exist once, here. The alternatives were worse: leaving them in `SubmissionService`
 * would make the consumer import the producer (a domain service, and through it the content loader
 * and the scoring engine) for two string literals, and copying them into each module is exactly the
 * failure above. This mirrors `src/shared/types/sections.ts`, which is a separate module for the
 * same reason — a shared vocabulary does not belong inside one of the modules that speaks it.
 *
 * Declared as a value and derived into a type, so the type cannot drift from the strings.
 */
export const JOB_TYPES = {
  writingEvaluation: 'writing_eval',
  studentProblemsText: 'student_problems_text',
} as const;

/** One of the job types above. */
export type JobType = (typeof JOB_TYPES)[keyof typeof JOB_TYPES];

/** Every job type, for iterating — e.g. checking a stored value is one this system understands. */
export const JOB_TYPE_VALUES: readonly JobType[] = Object.values(JOB_TYPES);

/** Whether a value read out of the `jobType` column is one this system knows how to run. */
export function isJobType(value: string): value is JobType {
  return (JOB_TYPE_VALUES as readonly string[]).includes(value);
}
