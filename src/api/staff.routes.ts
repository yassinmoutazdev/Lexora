import express from 'express';
import { stringify } from 'csv-stringify';
import { z } from 'zod';
import type { Cohort, Submission } from '@prisma/client';
import type { StudentProblemsCategory, WritingCorrection } from '../ai/AIEvaluationService.ts';
import {
  clearStaffSession,
  getStaffSession,
  issueStaffSession,
  staffSessionMiddleware,
} from '../auth/session.ts';
import { logger } from '../config/logger.ts';
import { getContentLoader, type ContentLoader, type ContentBundle } from '../content/ContentLoader.ts';
import { cohortRepository } from '../data/CohortRepository.ts';
import {
  submissionRepository,
  type ExportSubmission,
} from '../data/SubmissionRepository.ts';
import { getDashboardService } from '../domain/staff/DashboardService.ts';
import { getStaffAuthService } from '../domain/staff/StaffAuthService.ts';
import type { DraftAnswers } from '../shared/types/draft.ts';
import type {
  StaffProblemResponse,
  StaffSubmissionDetail,
  StaffWritingCriterion,
  StaffWritingFeedback,
} from '../shared/types/staff.ts';
import { staffLoginRateLimit } from './middleware/rateLimit.ts';
import { requireStaffSession } from './middleware/requireStaffSession.ts';
import { invalidRequestErrorBody, requiredText, validateBody } from './middleware/validateBody.ts';

/**
 * The staff router — login, logout, and (from E8) the dashboard, submission detail, and CSV export
 * (ARCHITECTURE Section 10, Section 18).
 *
 * `staffSessionMiddleware` is mounted on this router and `requireStaffSession` on each route that
 * needs it, rather than a session guard across the whole app. Section 9 requires that: the staff
 * and student access boundaries are separate, and a guard mounted globally is one refactor away
 * from protecting — or failing to protect — both at once. Login is the one route here that is
 * deliberately public, which is exactly why the guard is per route and not a router-level `use`.
 *
 * This file is also where staff data-access logging lives (Section 13, Section 18 — canonical
 * location for "Staff data-access logging"): `GET /submissions/:id` emits the one structured `pino`
 * line the architecture specifies. Nothing else here is logged, and deliberately so — Section 13
 * defines exactly one access line, and the export endpoint is not it.
 *
 * The `pino` instance it writes through is not created here. E8 created a local one, with a note
 * saying the project-wide logging task would decide where it lives; T9.2.1 decided, and it is now the
 * single process-wide logger in `src/config/logger.ts`. One instance means a redaction path is set
 * everywhere or nowhere — a second one carrying only this route's needs is the one way to end up with
 * `apiKey` redacted in some log lines and not others, which is the property Section 13's defence in
 * depth is worth having.
 */

/**
 * The refusal for a failed login.
 *
 * Deliberately does not say *which* of the two was wrong. `StaffAuthService` already refuses to
 * distinguish a wrong password from an email with no account behind it, and this message is the
 * other half of that: the response must not put back the distinction the service was careful not
 * to make.
 */
const INVALID_CREDENTIALS_MESSAGE = 'Invalid email or password';

const staffLoginBodySchema = z.object({
  email: requiredText('email'),
  password: requiredText('password'),
});

/**
 * The refusal for a cohort filter that names a cohort which does not exist.
 *
 * Names no secret — the caller is an authenticated staff member and a cohort code is a cohort
 * identifier, not a credential (NFR-SEC-002) — so it can say plainly what is wrong. It exists so
 * the SPA clears a stale filter rather than rendering a table of zeroes under a cohort heading,
 * which is indistinguishable from a cohort that genuinely has no submissions.
 */
const UNKNOWN_COHORT_MESSAGE = 'That cohort does not exist';

/**
 * The refusal for a submission id that resolves to no row.
 *
 * Generic, and names nothing about what might exist — a staff member is authenticated, so this is
 * not an enumeration defence, but there is also nothing useful to say beyond "that id is not a
 * submission".
 */
const UNKNOWN_SUBMISSION_MESSAGE = 'No such submission';

/**
 * The dashboard's query string.
 *
 * Validated like any other untrusted input boundary, even though the only field is a filter: an
 * unvalidated `req.query` value is `string | string[] | ParsedQs`, so `?cohortId=a&cohortId=b` would
 * otherwise reach the service as an array and be compared against a text column as one. The schema
 * turns that into a 400 at the boundary, which is where Section 11 puts it.
 *
 * Not `.strict()`, unlike the body schemas: a query string carries things this route does not own
 * (a cache-buster, a link-tracking parameter), and rejecting an unrecognised one would make the
 * endpoint brittle for no gain. The body schemas are strict because a body is a payload this API
 * defines in full; a query string is not.
 */
const dashboardQuerySchema = z.object({
  cohortId: z.string().min(1).optional(),
});

export const staffRouter = express.Router();

// Mounted before the routes so that login and logout can both read and write the cookie. Public
// routes need this as much as protected ones: issuing a session requires the session middleware to
// be in play.
staffRouter.use(staffSessionMiddleware);

/**
 * Exchanges email and password for a staff session (FR-STAFF-001).
 *
 * On success the session cookie is the response's whole payload — there is one permission level in
 * the MVP (FR-STAFF-003), so there is nothing else for the client to learn or carry. On failure the
 * caller is left exactly as authenticated as they arrived: no cookie is issued.
 *
 * `staffLoginRateLimit` runs first (T3.3.3), so an attacker burning attempts is stopped before any
 * password is verified — every blocked request is one bcrypt comparison the server does not spend.
 */
staffRouter.post('/login', staffLoginRateLimit, validateBody(staffLoginBodySchema), async (req, res, next) => {
  try {
    const authentication = await getStaffAuthService().authenticate(
      req.body.email,
      req.body.password,
    );

    if (authentication.outcome !== 'authenticated') {
      res.status(401).json({ error: INVALID_CREDENTIALS_MESSAGE });
      return;
    }

    issueStaffSession(req, authentication.staffUserId);

    res.json({ ok: true });
  } catch (error) {
    // Express 4 does not forward rejections from an async handler on its own.
    next(error);
  }
});

/**
 * Ends the staff session.
 *
 * Requires a session (Section 10), so a caller who is not logged in gets the same 401 any other
 * staff route would give them rather than a silent success. `clearStaffSession` expires the cookie
 * on the way out, so the client is not left holding a value it will keep presenting.
 */
staffRouter.post('/logout', requireStaffSession, (req, res) => {
  clearStaffSession(req);

  res.json({ ok: true });
});

/**
 * The dashboard's aggregate metrics, filterable by cohort (FR-STAFF-004–009, Section 10).
 *
 * Requires a staff session, like every staff route but login. There is no authorization decision
 * beyond that: FR-STAFF-003 gives all staff one permission level, so passing the guard is the whole
 * of the entitlement.
 *
 * The route shapes nothing. Every number in the response is computed by `DashboardService` from the
 * `contentVersion` each submission carries (Section 12), and the payload — including the reason the
 * difficulty comparison is absent (FR-STAFF-007) — is passed through as the service built it. A
 * route that reassembled it would be a second place the dashboard's shape is decided.
 *
 * The three refusals are distinguishable on purpose:
 *   - **401** — no staff session; the SPA sends the reader to the login page.
 *   - **400** — the query string is not a shape this endpoint accepts.
 *   - **404** — a well-formed filter naming a cohort that does not exist, so the SPA can clear it
 *     rather than show zeros under a heading. Section 11's "never reveal which field was wrong"
 *     rule is about *identity* refusals, where a wrong guess must not be confirmed; a cohort id is
 *     not an identity, and this caller is already authenticated as staff.
 */
staffRouter.get('/dashboard', requireStaffSession, async (req, res, next) => {
  try {
    const query = dashboardQuerySchema.safeParse(req.query);

    if (!query.success) {
      res.status(400).json(invalidRequestErrorBody(query.error));
      return;
    }

    const result = await getDashboardService().getDashboard(
      query.data.cohortId === undefined ? {} : { cohortId: query.data.cohortId },
    );

    if (result.outcome === 'unknown_cohort') {
      res.status(404).json({ error: UNKNOWN_COHORT_MESSAGE });
      return;
    }

    res.json(result.payload);
  } catch (error) {
    // Express 4 does not forward rejections from an async handler on its own.
    next(error);
  }
});

/**
 * One submission in full — the student's answers, its scores, and its background results
 * (FR-STAFF-010, Section 10).
 *
 * Requires a staff session, which is the whole of the authorization: FR-STAFF-003 gives all staff
 * one permission level, and there is nothing finer to check.
 *
 * ## Every access is logged (Section 13, NFR-PRIV-004)
 *
 * Section 13 is explicit about the mechanism and its limits: *"Every `GET /api/staff/submissions/:id`
 * emits one structured `pino` log entry: `{ event: 'staff_submission_access', staffUserId,
 * submissionId, timestamp, action: 'view' }`. This is an **operational log**, written to stdout …
 * it is not a database table, not an audit-event model, and nothing else in the system reads it
 * back."* There is no audit table, no audit model, and no schema change — the database is exactly
 * what Section 6 specifies.
 *
 * The line is emitted for a **refused** lookup as well as a successful one, and "Every" is the
 * reason. An access log that recorded only the requests that found something could not show a staff
 * account walking a list of ids, which is the one thing an access log exists to make visible. The
 * shape stays exactly as Section 13 fixes it; no extra field is added to distinguish the two, so
 * the line means what the document says it means.
 *
 * ## Why the id is not validated as a shape
 *
 * Unlike the cohort filter, this arrives as a path segment rather than a query value: it is always
 * a single string, and an id that names no row is answered with a 404 rather than a 400. There is
 * no array-vs-string ambiguity to close, so a schema here would add nothing.
 *
 * ## Why the content is resolved here rather than stored
 *
 * The Student Problems statements, the rubric criterion labels, and the scale's own wording are not
 * columns on the submission — they live in the content bundle, and the bundle to resolve is the
 * one the submission was taken under (Section 12). A submission from an older version shows the
 * questions that student actually answered, never today's. This is the same join
 * `src/api/student.routes.ts` performs for the student report, and Section 7 gives it as the
 * route's job: *"the endpoint simply reads the Submission row and shapes it into a response."*
 */
staffRouter.get('/submissions/:id', requireStaffSession, async (req, res, next) => {
  try {
    const submissionId = req.params.id;

    // Unreachable: the route pattern `/submissions/:id` cannot match without a segment here, and
    // `noUncheckedIndexedAccess` is what types the lookup as possibly-absent. Stated rather than
    // asserted, for the reason `assertSessionKind` throws — if a future change to the pattern ever
    // made it reachable, this fails loudly instead of logging an empty id and 404-ing.
    if (submissionId === undefined) {
      throw new Error('GET /api/staff/submissions/:id matched without a submission id');
    }

    const staff = getStaffSession(req);

    const submission = await submissionRepository.findById(submissionId);

    // Logged before the refusal is sent, so a probe is recorded in the same line shape as a view.
    logger.info({
      event: 'staff_submission_access',
      staffUserId: staff?.staffUserId,
      submissionId,
      // Carried explicitly rather than left to pino's own `time` field: Section 13 fixes the line's
      // shape, an operator greps it by these names, and two fields for one fact is the smaller
      // price than a line whose timestamp is spelled differently from the one the document names.
      timestamp: new Date().toISOString(),
      action: 'view',
    });

    if (!submission) {
      res.status(404).json({ error: UNKNOWN_SUBMISSION_MESSAGE });
      return;
    }

    const cohort = await cohortRepository.findById(submission.cohortId);

    res.json(
      toStaffSubmissionDetail(
        submission,
        cohort,
        getContentLoader().getContent(submission.contentVersion),
      ),
    );
  } catch (error) {
    // Express 4 does not forward rejections from an async handler on its own.
    next(error);
  }
});

/**
 * The streamed CSV export (FR-STAFF-011, Section 10, PRD G5).
 *
 * Requires a staff session like every other staff route but login. The column and cell rules are
 * documented on the shaping helpers below; what belongs here is the HTTP contract.
 *
 * ## Why this is a stream and not a JSON body
 *
 * `csv-stringify` is in Section 2's dependency list for exactly this: *"Streaming CSV export for the
 * staff dashboard"*. `stringify(...)` is a Readable, so the file is written to the socket as it is
 * produced instead of being assembled into one string and handed to `res.send`. At a few hundred
 * rows the difference is small; it is the difference the architecture asked for, and it is the one
 * that does not need revisiting if the pilot grows.
 *
 * ## Why the cohort is resolved before the rows
 *
 * Two reasons and only one of them is the 404. A filter that names no cohort means the export would
 * be an *empty file* rather than a wrong one — the least useful possible answer, and one the reader
 * cannot distinguish from "this cohort has no submissions". And resolving the cohort first gives the
 * download a filename that says which cohort it holds, which matters when two exports are sitting in
 * a Downloads folder.
 *
 * ## What is deliberately not logged
 *
 * Section 13 specifies exactly one data-access log line — `staff_submission_access`, on
 * `GET /api/staff/submissions/:id`. The export is a different kind of read and the document does not
 * give it a line; inventing a second event type here would be adding to a security requirement
 * rather than implementing it. Section 13's design is a deliberately minimal one ("proportionate to
 * a two-staff, non-adversarial pilot"), and this is what that minimalism looks like from here.
 *
 * The route's path carries the `.csv` extension, matching Section 10's `/api/staff/export.csv`
 * exactly rather than a `/export` that sets a content type.
 */
staffRouter.get('/export.csv', requireStaffSession, async (req, res, next) => {
  try {
    const query = dashboardQuerySchema.safeParse(req.query);

    if (!query.success) {
      res.status(400).json(invalidRequestErrorBody(query.error));
      return;
    }

    const { cohortId } = query.data;

    // The same 404 the dashboard gives for the same reason: a filter that names no cohort is refused
    // rather than answered with an empty result the reader cannot interpret.
    const cohort = cohortId === undefined ? null : await cohortRepository.findById(cohortId);
    if (cohortId !== undefined && cohort === null) {
      res.status(404).json({ error: UNKNOWN_COHORT_MESSAGE });
      return;
    }

    const submissions = await submissionRepository.findAllForExport(cohortId);
    const content = getContentLoader();

    const columns = exportColumns(submissions, content);
    const rows = submissions.map((submission) => toExportRow(submission, content));

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${exportFilename(cohort)}"`);

    const csv = stringify(rows, { header: true, columns });

    // A failure mid-stream cannot become a 500 — the status line is long gone by then — so it ends
    // the response instead. Attaching the handler to the stream rather than wrapping the pipe in a
    // try/catch is what makes that possible: the error arrives asynchronously.
    csv.on('error', next);
    csv.pipe(res);
  } catch (error) {
    // Express 4 does not forward rejections from an async handler on its own.
    next(error);
  }
});

/**
 * The download's filename.
 *
 * Dated, so two exports of the same cohort in one sitting do not become `… (1).csv`, and carrying
 * the cohort code when the export was filtered, so a file's scope is legible without opening it.
 * The code is used rather than the cohort's name because it is the identifier the team hands out and
 * the one an analyst will recognise; it is also already constrained to be a code, so it cannot carry
 * a character that would break out of the quoted filename.
 */
function exportFilename(cohort: Cohort | null): string {
  const scope = cohort === null ? 'all-cohorts' : cohort.code;
  const date = new Date().toISOString().slice(0, 10);

  return `lexora-submissions-${scope}-${date}.csv`;
}

/**
 * Shapes a submission row into the staff detail response (FR-STAFF-010).
 *
 * The join between what is stored and what the content bundle says it means, in one place. Every
 * label below is read from `bundle` — the submission's frozen `contentVersion` — and never from
 * code, for the reason Section 18 gives: the criteria, the statements, and the scale are content,
 * and a copy of any of them here would be a second definition that could drift from the one the
 * student was shown.
 *
 * ## Why every JSON column is read defensively
 *
 * `answers`, `writingCriteriaScores`, `writingFeedback`, `problemsLikertAnswers`, and
 * `problemsTextDerived` are all `Json` columns. Each is written through a schema this codebase
 * controls — `draftAutosaveBodySchema` at the API boundary, `src/ai/schemas.ts` at the AI boundary
 * — so each is the shape the reader expects. But a reader that *trusts* a JSON column has no way to
 * report the day that stops being true: it would throw somewhere inside a page instead, or render
 * `undefined`. The helpers at the bottom reduce anything unexpected to an empty list or a null, so a
 * malformed column shows as missing data rather than as a broken staff view.
 */
function toStaffSubmissionDetail(
  submission: Submission,
  cohort: Cohort | null,
  bundle: ContentBundle,
): StaffSubmissionDetail {
  return {
    id: submission.id,
    cohort: {
      id: submission.cohortId,
      // The cohort row is a foreign key that cannot dangle, so a missing one means the row was
      // deleted underneath a submission that still references it. Falling back to the id keeps the
      // response renderable rather than throwing on a caption.
      code: cohort?.code ?? submission.cohortId,
      name: cohort?.name ?? '',
    },
    rollNumber: submission.rollNumberRaw,
    studentName: submission.studentName,
    status: submission.status,
    contentVersion: submission.contentVersion,
    createdAt: submission.createdAt.toISOString(),
    submittedAt: submission.submittedAt?.toISOString() ?? null,

    answers: submission.answers as DraftAnswers,

    scores: {
      grammar: submission.grammarScore,
      vocabulary: submission.vocabularyScore,
      reading: submission.readingScore,
    },

    writing: {
      status: submission.writingStatus,
      overallScore: submission.writingOverallScore,
      criteria: writingCriteria(submission.writingCriteriaScores, bundle),
      feedback: writingFeedback(submission.writingFeedback),
    },

    studentProblems: {
      likert: problemResponses(submission.problemsLikertAnswers, bundle),
      // The column, not `answers.studentProblems.openText`: this is the one finalization wrote and
      // the one nothing may overwrite (FR-PROB-009), so it is the record. The copy inside `answers`
      // is left where it is rather than merged in, because the whole point of the invariant is that
      // there is exactly one authoritative place to read the student's words from.
      openTextOriginal: submission.problemsOpenTextOriginal,
      textStatus: submission.problemsTextStatus,
      textDerived: derivedProblemsText(submission.problemsTextDerived),
    },
  };
}

/**
 * The stored criterion judgments, labelled from the frozen rubric.
 *
 * The evaluation can only name criteria the rubric lists, since both come from the same immutable
 * version bundle (Section 2). A key with no label is therefore dropped rather than shown under a
 * bare key a reader would have to interpret; there is no wording for it that would be true.
 */
function writingCriteria(stored: unknown, bundle: ContentBundle): StaffWritingCriterion[] {
  const scores = asRecord(stored);

  return bundle.writingRubric.criteria.flatMap((criterion) => {
    const judgment = asRecord(scores?.[criterion.key]);
    const score = judgment?.['score'];
    const rationale = judgment?.['rationale'];

    if (typeof score !== 'number' || typeof rationale !== 'string') return [];

    return [{ key: criterion.key, label: criterion.label, score, rationale }];
  });
}

/**
 * The stored qualitative feedback, as the four lists the provider produced (FR-WRITE-007).
 */
function writingFeedback(stored: unknown): StaffWritingFeedback | null {
  const feedback = asRecord(stored);
  if (!feedback) return null;

  return {
    strengths: asStringArray(feedback['strengths']),
    weaknesses: asStringArray(feedback['weaknesses']),
    corrections: asCorrectionArray(feedback['corrections']),
    suggestions: asStringArray(feedback['suggestions']),
  };
}

/**
 * The five-point responses, joined to their statement wording (FR-PROB-005).
 *
 * Ordered by the instrument's own statement order rather than by the map's key order, so the view
 * reads as the questionnaire the student answered. A response whose statement id is not in the
 * frozen bundle is dropped: it names a question this version never asked, and printing the id where
 * the wording belongs would show a reader something that was never on the student's screen.
 */
function problemResponses(stored: unknown, bundle: ContentBundle): StaffProblemResponse[] {
  const likert = asRecord(stored);
  if (!likert) return [];

  const scaleLabel = new Map(
    bundle.studentProblems.scale.map((point) => [point.value, point.label]),
  );

  return bundle.studentProblems.statements.flatMap((statement) => {
    const value = likert[statement.id];
    if (typeof value !== 'number') return [];

    const area = bundle.studentProblems.areas.find((candidate) => candidate.id === statement.area);

    return [
      {
        statementId: statement.id,
        statement: statement.text,
        area: statement.area,
        areaLabel: area?.label ?? statement.area,
        value,
        valueLabel: scaleLabel.get(value) ?? null,
      },
    ];
  });
}

/**
 * The AI's reading of the open text, as a separate object (FR-PROB-011).
 *
 * Returns null when there is none, and never falls back to the original: a caller that finds null
 * here has found "no derived data", which is a different fact from "no response", and collapsing
 * the two is exactly how derived data comes to be presented as the student's own words.
 */
function derivedProblemsText(
  stored: unknown,
): StaffSubmissionDetail['studentProblems']['textDerived'] {
  const derived = asRecord(stored);
  if (!derived) return null;

  const normalizedText = derived['normalizedText'];
  const categories = derived['categories'];

  return {
    normalizedText: typeof normalizedText === 'string' ? normalizedText : '',
    categories: Array.isArray(categories)
      ? categories.flatMap((category): StudentProblemsCategory[] => {
          const entry = asRecord(category);
          const label = entry?.['label'];
          const evidence = entry?.['evidence'];

          return typeof label === 'string' && typeof evidence === 'string'
            ? [{ label, evidence }]
            : [];
        })
      : [],
  };
}

/**
 * Shaping and column rules for the CSV export (FR-STAFF-011, PRD G5).
 *
 * PRD Section 4's goal G5: *"Produce exportable data the team can analyze further outside the
 * application (e.g., Excel, Python)."* PRD Section 14 says the same thing from the other direction —
 * the dashboard *"must support external, deeper analysis via export rather than trying to replace
 * tools like Excel or Python within the product."* This is that boundary.
 *
 * ## Why the columns are fixed at the top and derived at the bottom
 *
 * The identity, score, and status columns are fixed because the schema fixes them (Section 6). The
 * Student Problems statements and the writing criteria are **content**, so there is one column per
 * statement id and per criterion key *as they appear in the versions actually being exported* — read
 * from the frozen bundles, never written down here (Section 18). A version with a different
 * statement set therefore produces different columns, which is correct: an analyst comparing two
 * exports is comparing two instruments, and pretending otherwise would put two different statements
 * in one column.
 *
 * A row whose version does not carry a statement contributes an empty cell, not a zero. `0` reads as
 * a value on FR-PROB-002's 1–5 scale and would be averaged as one; empty is what the CSV has for
 * "this instrument did not ask that". The same applies to a criterion a submission's evaluation does
 * not carry.
 *
 * ## The two derived columns say so in their names
 *
 * FR-PROB-011 requires derived data to be clearly labelled, and in a CSV the header is the only
 * labelling there is. `problems_open_text_normalized_derived` and `problems_categories_derived` are
 * named so that an analyst who never reads this file cannot mistake either for the student's words.
 * The student's own words are in `problems_open_text_original`, exactly as submitted (FR-PROB-009).
 *
 * ## What is deliberately not done to the values
 *
 * Nothing is escaped beyond what CSV quoting requires, and in particular a value beginning `=` is
 * left alone. Some exporters prefix such values so a spreadsheet will not evaluate them as a
 * formula; doing that here would rewrite the student's own text on its way out, which FR-PROB-009
 * forbids for the original response and which would make the export disagree with the record it
 * exports.
 */

/** One CSV column: the key read from each row object, and the header written for it. */
type ExportColumn = { key: string; header: string };

/** One row of the export, as a flat map of column key to cell. */
type ExportCell = string | number | null;

/**
 * The columns every export carries, whatever the content versions involved.
 *
 * `submission_id` is first because it is the only column that identifies a record rather than
 * describing it — it is what a staff member would use to open the submission in the application, and
 * what an analyst would join on.
 */
const EXPORT_IDENTITY_COLUMNS: ExportColumn[] = [
  { key: 'submission_id', header: 'submission_id' },
  { key: 'cohort_code', header: 'cohort_code' },
  { key: 'cohort_name', header: 'cohort_name' },
  { key: 'roll_number', header: 'roll_number' },
  { key: 'student_name', header: 'student_name' },
  { key: 'status', header: 'status' },
  { key: 'content_version', header: 'content_version' },
  { key: 'created_at', header: 'created_at' },
  { key: 'submitted_at', header: 'submitted_at' },
];

/** The deterministic scores, as stored (Section 6) — the same columns the dashboard aggregates. */
const EXPORT_SCORE_COLUMNS: ExportColumn[] = [
  { key: 'grammar_score', header: 'grammar_score' },
  { key: 'vocabulary_score', header: 'vocabulary_score' },
  { key: 'reading_score', header: 'reading_score' },
];

/** The Student Problems columns that do not depend on a content version. */
const EXPORT_PROBLEMS_TAIL_COLUMNS: ExportColumn[] = [
  { key: 'problems_open_text_original', header: 'problems_open_text_original' },
  {
    key: 'problems_open_text_normalized_derived',
    header: 'problems_open_text_normalized_derived',
  },
  { key: 'problems_categories_derived', header: 'problems_categories_derived' },
];

/**
 * The full column list for one export.
 *
 * Statements and criteria are collected across every content version present, in the order the
 * bundles list them, with the first version to introduce an id fixing its position. Two versions
 * that share a statement id share a column — which is right, because the id is the instrument's own
 * identity for the question, and a version that reworded a statement kept its id deliberately (the
 * content schema requires ids to be unique within a file, not across versions).
 */
function exportColumns(submissions: ExportSubmission[], content: ContentLoader): ExportColumn[] {
  const statements = new Map<string, ExportColumn>();
  const criteria = new Map<string, ExportColumn>();

  for (const version of new Set(submissions.map((submission) => submission.contentVersion))) {
    const bundle = content.getContent(version);

    for (const statement of bundle.studentProblems.statements) {
      statements.set(statement.id, {
        key: `problems_${statement.id}`,
        header: `problems_${statement.id}`,
      });
    }

    for (const criterion of bundle.writingRubric.criteria) {
      criteria.set(criterion.key, {
        key: `writing_${criterion.key}`,
        header: `writing_${criterion.key}`,
      });
    }
  }

  return [
    ...EXPORT_IDENTITY_COLUMNS,
    ...EXPORT_SCORE_COLUMNS,
    { key: 'writing_status', header: 'writing_status' },
    { key: 'writing_overall_score', header: 'writing_overall_score' },
    ...criteria.values(),
    { key: 'problems_text_status', header: 'problems_text_status' },
    ...statements.values(),
    ...EXPORT_PROBLEMS_TAIL_COLUMNS,
  ];
}

/**
 * One submission as a CSV row.
 *
 * Every cell is either the stored value or empty. Nothing is defaulted to `0` and nothing is
 * computed: the export's contract is that a reader can find each number in the database, and a
 * derived figure that exists only in the CSV would be a number nobody could check.
 */
function toExportRow(
  submission: ExportSubmission,
  content: ContentLoader,
): Record<string, ExportCell> {
  const bundle = content.getContent(submission.contentVersion);
  const likert = asRecord(submission.problemsLikertAnswers);
  const criteriaScores = asRecord(submission.writingCriteriaScores);

  const row: Record<string, ExportCell> = {
    submission_id: submission.id,
    cohort_code: submission.cohort.code,
    cohort_name: submission.cohort.name,
    roll_number: submission.rollNumberRaw,
    student_name: submission.studentName,
    status: submission.status,
    content_version: submission.contentVersion,
    created_at: submission.createdAt.toISOString(),
    submitted_at: submission.submittedAt?.toISOString() ?? null,

    grammar_score: submission.grammarScore,
    vocabulary_score: submission.vocabularyScore,
    reading_score: submission.readingScore,

    writing_status: submission.writingStatus,
    writing_overall_score: submission.writingOverallScore,

    problems_text_status: submission.problemsTextStatus,
    problems_open_text_original: submission.problemsOpenTextOriginal,
    // Derived, and named so in the header (FR-PROB-011). Read from `problemsTextDerived`, the column
    // the AI writes, never from the original.
    problems_open_text_normalized_derived: derivedNormalizedText(submission.problemsTextDerived),
    problems_categories_derived: derivedCategoryLabels(submission.problemsTextDerived),
  };

  for (const statement of bundle.studentProblems.statements) {
    const value = likert?.[statement.id];
    row[`problems_${statement.id}`] = typeof value === 'number' ? value : null;
  }

  for (const criterion of bundle.writingRubric.criteria) {
    const judgment = asRecord(criteriaScores?.[criterion.key]);
    const score = judgment?.['score'];
    row[`writing_${criterion.key}`] = typeof score === 'number' ? score : null;
  }

  return row;
}

/** The derived normalization, or null when there is none (FR-PROB-010, FR-PROB-011). */
function derivedNormalizedText(stored: unknown): string | null {
  const derived = asRecord(stored);
  const normalized = derived?.['normalizedText'];

  return typeof normalized === 'string' ? normalized : null;
}

/**
 * The derived categories as one cell, semicolon-separated.
 *
 * Not a JSON array: the point of this column is to be read and pivoted in a spreadsheet (PRD G5),
 * and a JSON blob in a CSV cell is a string an analyst has to parse before they can count anything.
 * Semicolons rather than commas so the cell does not need to be split into multiple CSV fields,
 * which would make the number of columns depend on how many categories a student happened to
 * describe.
 */
function derivedCategoryLabels(stored: unknown): string | null {
  const derived = asRecord(stored);
  const categories = derived?.['categories'];

  if (!Array.isArray(categories)) return null;

  const labels = categories.flatMap((category) => {
    const label = asRecord(category)?.['label'];
    return typeof label === 'string' ? [label] : [];
  });

  return labels.length === 0 ? null : labels.join('; ');
}

/** A stored JSON column as a plain object, or undefined when it holds anything else. */function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;

  return value as Record<string, unknown>;
}

/** The strings in a stored list, with anything that is not one dropped. */
function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : [];
}

/** The well-formed corrections in a stored list, with anything else dropped. */
function asCorrectionArray(value: unknown): WritingCorrection[] {
  if (!Array.isArray(value)) return [];

  return value.flatMap((entry): WritingCorrection[] => {
    const correction = asRecord(entry);
    const original = correction?.['original'];
    const corrected = correction?.['corrected'];
    const explanation = correction?.['explanation'];

    return typeof original === 'string' &&
      typeof corrected === 'string' &&
      typeof explanation === 'string'
      ? [{ original, corrected, explanation }]
      : [];
  });
}
