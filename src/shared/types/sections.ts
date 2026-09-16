/**
 * The vocabulary the API and the SPA both name — sections, and the states a submission reports —
 * and nothing else (ARCHITECTURE Section 4 — `src/shared/types/`).
 *
 * ## Why this is a separate module from `draft.ts`
 *
 * `draft.ts` defines the zod schemas that validate the autosave request, so it imports `zod`. That
 * is correct for the API — the boundary is validated there — and pointless for the browser, which
 * sends the body and never parses one. But the SPA does need to know the section keys, at runtime,
 * to render navigation in the right order.
 *
 * When the constant and the schemas lived in one module, importing the constant pulled the
 * validator in with it: the browser bundle carried ~60KB of zod that no browser code ever called,
 * because a value import cannot be erased the way `import type` is. Keeping the zod-free things
 * here means the SPA imports a module that has no dependencies at all, and the split is structural
 * rather than a rule someone has to remember.
 *
 * `draft.ts` deliberately does **not** re-export these. A re-export would restore exactly the
 * hazard this module exists to remove — `import { SECTION_KEYS } from './draft.ts'` would still
 * resolve, and would still drag zod into the bundle.
 *
 * Nothing here may acquire a runtime import. That is the whole contract of this file.
 */

/**
 * The five sections, in the order the assessment presents them (PRD Section 10).
 *
 * Declared once as a value and derived into a type, rather than written twice, because this list is
 * load-bearing in three places that must agree: the autosave request's section key is a *closed
 * set* (Section 12 — an open one would let a caller write arbitrary top-level keys into the JSONB
 * `answers` column), the assessment UI's navigation order, and the section keys the draft response
 * may carry.
 */
export const SECTION_KEYS = ['grammar', 'vocabulary', 'reading', 'writing', 'studentProblems'] as const;

/** A section of the assessment — the unit of both autosave and navigation. */
export type SectionKey = (typeof SECTION_KEYS)[number];

/**
 * The sections with an answer key: the ones scored by comparison rather than by judgement.
 *
 * A subset of `SECTION_KEYS` rather than a second list, so Writing and Student Problems cannot be
 * added to it by accident — they are scored by a rubric-driven model and by nothing at all,
 * respectively. Declared as a value because the report has to iterate them, and derived into a type
 * because the scorer has to name one.
 */
export const DETERMINISTIC_SECTION_KEYS = ['grammar', 'vocabulary', 'reading'] as const;

/** One of the three sections `DeterministicScoringService` scores. */
export type DeterministicSectionKey = (typeof DETERMINISTIC_SECTION_KEYS)[number];

/**
 * The submission's lifecycle state, as far as a student can observe it.
 *
 * Declared here rather than imported from `@prisma/client` so the frontend can name it without
 * depending on the generated database client. The two are the same union, which is what lets the
 * server assign a `SubmissionStatus` straight into this field.
 */
export type SubmissionStatus = 'draft' | 'submitted';

/**
 * How far a piece of background evaluation has got (Section 6's `ProcessingStatus`).
 *
 * A type and not a value, because the SPA only ever compares it: `writingStatus === 'pending'` is
 * what makes the report say feedback is still being prepared (FR-FEEDBACK-004), and a string
 * comparison needs no exported constant. Keeping it a type is also what keeps this module free of
 * runtime exports beyond the section keys — see the note above about why that matters.
 *
 * `not_applicable` is not a failure state: it is what a column reads when there was never anything
 * to process, such as Student Problems text for a student who left the open question blank.
 */
export type ProcessingStatus =
  | 'not_applicable'
  | 'pending'
  | 'processing'
  | 'succeeded'
  | 'failed_needs_review';
