/**
 * The one form a cohort access code is stored in.
 *
 * ## Why this is shared rather than living in the service that owns it
 *
 * `CohortRepository.findByCode` matches the stored code **exactly**, deliberately — it is an
 * identifier the team hands out, not free text, and a lenient match would let two different-looking
 * codes resolve to one cohort. So whatever is stored is what every student must type character for
 * character, and a code stored as `pilot-2027` would require students to type lowercase.
 *
 * That makes normalisation a rule with two callers: the staff route, which stores the code, and the
 * confirmation dialog, which has to show the staff member the exact string students will be given
 * *before* they commit to it. A second copy in the browser would be a preview that can drift from
 * what the server actually writes — and a preview that lies is worse than no preview, because the
 * dialog exists precisely to be believed.
 *
 * `src/shared/` is where the codebase already puts values both sides need (`SECTION_KEYS` in
 * `types/sections.ts` is imported by the SPA as a value, not a type), so this is an existing
 * arrangement rather than a new one.
 */

/**
 * The stored form of an access code: trimmed, and upper-cased.
 *
 * Trimmed because a pasted code carries whitespace that no student would type; upper-cased because
 * that is what an access code looks like and what the existing `PILOT-2026` already is. The two
 * together mean a code only ever has one spelling, which is what makes it safe to hand out.
 */
export function normaliseCohortCode(code: string): string {
  return code.trim().toUpperCase();
}
