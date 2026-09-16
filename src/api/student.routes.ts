import express from 'express';
import { getStudentSession, studentSessionMiddleware } from '../auth/session.ts';
import { getContentLoader, type ContentBundle } from '../content/ContentLoader.ts';
import { submissionRepository } from '../data/SubmissionRepository.ts';
import {
  SECTION_KEYS,
  draftAutosaveBodySchema,
  type AssessmentContent,
  type DraftAnswers,
  type DraftAutosaveBody,
} from '../shared/types/draft.ts';
import { requireStudentSession } from './middleware/requireStudentSession.ts';
import { UNAUTHORIZED_MESSAGE } from './middleware/requireSession.ts';
import { validateBody } from './middleware/validateBody.ts';

/**
 * The student router — the assessment and the report, for the one submission the session owns
 * (ARCHITECTURE Section 10, Section 18).
 *
 * ## There is no submission id in any path here
 *
 * The route is `/api/student/draft`, not `/api/student/submissions/:id/draft`. The active
 * submission is read from the session (`getStudentSession`) and from nowhere else, so a caller
 * cannot name a record — there is no parameter to guess, swap, or share. That absence *is* the
 * implementation of NFR-SEC-009 (Section 9), and it is the reason every route on this router can
 * treat "which submission?" as an already-answered question.
 *
 * ## Two independent drafts cannot be confused
 *
 * Because the session is scoped to exactly one submission at issuance (Section 1), a session issued
 * while one draft was open cannot be spent on another. The route never has to verify that the
 * caller is entitled to the row it looks up: the row is the entitlement.
 */

/**
 * The refusal for a write that arrives against a record that is no longer a draft.
 *
 * Unlike an identity refusal this names no secret: it is the student's own submission, and the
 * fact that it is submitted is already public to them (`student-verify` reports the same status).
 * Saying so plainly is what lets the SPA explain the screen instead of showing a generic failure.
 */
const SUBMITTED_NO_EDIT_MESSAGE =
  'This assessment has already been submitted, so it can no longer be changed';

export const studentRouter = express.Router();

// Mounted on this router rather than globally, for the reason Section 9 gives: a staff session is
// meaningless on a student route and vice versa, and the two access boundaries must never merge.
studentRouter.use(studentSessionMiddleware);

/**
 * The draft, with the content it was created under.
 *
 * Returns the saved answers and the content bundle for the submission's own `contentVersion` — the
 * version frozen at draft creation, never "current" (Section 12). A student who started under `v1`
 * keeps answering `v1` questions even after `v2` becomes current, which is what makes historical
 * interpretability (FR-CONTENT-001/003) a property of the read path rather than a hopeful one: this
 * route asks `getContent(version)`, and that call *throws* for a version it does not hold instead of
 * falling back (see `ContentLoader.getContent`).
 *
 * `status` is returned rather than enforced here. A submitted student is not refused — they are
 * told, so the SPA can put them on `/report` (Section 9). Rejecting the read instead would leave a
 * returning student with an error where their report should be; rejecting *writes* to a submitted
 * record is the separate guarantee the PATCH route owns (Section 12).
 */
studentRouter.get('/draft', requireStudentSession, async (req, res, next) => {
  try {
    // `requireStudentSession` has already refused a request without one, so this cannot be null —
    // but it is read rather than asserted, so the handler stays correct if the guard is ever
    // rearranged, and the compiler is told the truth instead of being overruled.
    const session = getStudentSession(req);

    if (!session) {
      res.status(401).json({ error: UNAUTHORIZED_MESSAGE });
      return;
    }

    const submission = await submissionRepository.findById(session.submissionId);

    // The session is signed and names a row that no longer exists. Nothing deletes submissions in
    // this system, so this is a data-integrity anomaly rather than a plausible client error — but
    // from the caller's side the remedy is exactly the one for holding no session at all (verify
    // identity again), so it is answered identically rather than with a second client path.
    if (!submission) {
      res.status(401).json({ error: UNAUTHORIZED_MESSAGE });
      return;
    }

    res.json({
      status: submission.status,
      contentVersion: submission.contentVersion,
      content: toAssessmentContent(getContentLoader().getContent(submission.contentVersion)),
      answers: toDraftAnswers(submission.answers),
    });
  } catch (error) {
    // Express 4 does not forward rejections from an async handler on its own, so an unhandled
    // error here would hang the request rather than reach the error handler.
    next(error);
  }
});

/**
 * Autosave: merge **one** section's answers into the draft (ARCHITECTURE Section 12).
 *
 * The body names a single section and carries only that section's answers — never the whole
 * `answers` object. That restriction is the entire design: a request that could send the whole
 * document would make every save a full overwrite, and two tabs open on different sections would
 * silently clobber one another. Under a section-keyed merge they cannot, because the two writes
 * touch different keys (Section 12, and the concurrency cases it enumerates).
 *
 * The refusal for a non-draft record is a 409 *and not a no-op success*. Section 11 treats a
 * duplicate **submit** as success — the student clicked twice and should see their report — but a
 * write that arrives after submission is a different thing: it is either a stale tab that has been
 * open since before the student submitted, or an attempt to edit an immutable record. Silently
 * accepting it would leave a client believing unsaved work had been stored. The status is reported
 * so the SPA can move that tab to the report (Section 9).
 *
 * `validateBody` runs first, so by the time the merge is reached the section key is one of the five
 * and the answers match that section's shape (Section 10 — "malformed input never reaches business
 * logic"). This is not a formality for this endpoint: the section key becomes a *key* in the JSONB
 * column, so an unchecked one would not be a bad value in a field, it would be a new field.
 */
studentRouter.patch(
  '/draft',
  requireStudentSession,
  validateBody(draftAutosaveBodySchema),
  async (req, res, next) => {
    try {
      const session = getStudentSession(req);

      if (!session) {
        res.status(401).json({ error: UNAUTHORIZED_MESSAGE });
        return;
      }

      // `validateBody` replaced `req.body` with the schema's output, so this is the parsed body and
      // not the raw payload: `section` is one of the five real keys and `sectionAnswers` carries
      // that section's shape. No re-checking below, and no second opinion about the request's shape.
      const { section, sectionAnswers } = req.body as DraftAutosaveBody;

      const result = await submissionRepository.mergeSectionAnswers(
        session.submissionId,
        section,
        sectionAnswers,
      );

      if (result.outcome === 'not_found') {
        res.status(401).json({ error: UNAUTHORIZED_MESSAGE });
        return;
      }

      if (result.outcome === 'not_draft') {
        res.status(409).json({ error: SUBMITTED_NO_EDIT_MESSAGE });
        return;
      }

      // The section is echoed back so a client can tell which save it is looking at the result of —
      // with several sections autosaving through one endpoint, "saved" without a subject is exactly
      // the acknowledgement a debounce bug would hide behind.
      res.json({ status: 'saved', section });
    } catch (error) {
      next(error);
    }
  },
);

/** The student-facing projection of a content bundle. See `AssessmentContent` for what is left out. */
function toAssessmentContent(bundle: ContentBundle): AssessmentContent {
  return {
    grammar: bundle.grammar,
    vocabulary: bundle.vocabulary,
    reading: bundle.reading,
    writing: bundle.writingPrompt,
    studentProblems: bundle.studentProblems,
  };
}

/**
 * Narrows the stored `answers` to the section-keyed contract the client is written against.
 *
 * Two things happen here, and only the first is a guarantee.
 *
 * **The guarantee:** the response is an object carrying only section keys, with nothing invented
 * for a section that has never been saved. The column is JSONB, so what comes back is whatever was
 * last written into it; the section filter is what stops a key written by some future code path
 * from reaching a frontend that believes the key set is closed.
 *
 * **The assertion:** the *values* are typed as the section answer shapes rather than as `unknown`.
 * That rests on one fact — `draftAutosaveBodySchema` validates every write to this column — and
 * this cast is the single place in the codebase where that assumption is made, so it is visible
 * rather than repeated at every reader. Nothing here re-validates our own writes: deep-checking
 * data on the way out of the database it was validated into would buy nothing and cost a parse per
 * section per page load.
 */
function toDraftAnswers(answers: unknown): DraftAnswers {
  if (typeof answers !== 'object' || answers === null || Array.isArray(answers)) return {};

  const stored = answers as Record<string, unknown>;
  const selected: Record<string, unknown> = {};

  for (const key of SECTION_KEYS) {
    if (key in stored) selected[key] = stored[key];
  }

  return selected as DraftAnswers;
}
