import type { DashboardPayload } from '../../../src/domain/staff/DashboardService';
import type { DraftAutosaveBody, StudentDraft, StudentReport } from '../../../src/shared/types/draft';
import type { SectionKey, SubmissionStatus } from '../../../src/shared/types/sections';
import type { StaffSubmissionDetail } from '../../../src/shared/types/staff';

/**
 * The frontend's typed wrapper over `fetch` (ARCHITECTURE Section 4 — `frontend/src/api/client.ts`).
 *
 * Every request the SPA makes goes through here, for two reasons. The wire types come from
 * `src/shared/types`, which the *server* also imports, so a change to a response shape breaks the
 * build on whichever side did not keep up rather than surfacing as `undefined` in a running page.
 * And failures arrive as one shape — an `ApiError` carrying the status and whatever the API said —
 * so a page decides how to react in one place instead of re-parsing responses.
 *
 * ## What it deliberately does not do
 *
 * It does not retry, queue, cache, or hold state. Section 5 rules out a global client store: pages
 * fetch what they need on mount, and the only piece of client state with behaviour is `useAutosave`
 * (Section 5), which owns exactly one section. A client that quietly retried would also hide the
 * autosave failures the student needs to see.
 */

/** One field-level complaint from the API's validation middleware (Section 11). */
export type ApiFieldIssue = {
  field: string;
  message: string;
};

/**
 * A failed request — an HTTP error status, or no response at all.
 *
 * `status` is 0 when the request never completed (offline, DNS, connection reset). That is not an
 * HTTP status and is deliberately not faked as one: a page that wants to say "check your
 * connection" can tell the two apart, and one that does not care can treat any `ApiError` alike.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly details: ApiFieldIssue[];

  constructor(message: string, status: number, details: ApiFieldIssue[] = []) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.details = details;
  }
}

/**
 * The `error` string the API sent, or a status-appropriate fallback.
 *
 * Section 11 makes the API responsible for the wording of every refusal it can foresee, so the
 * server's message is preferred whenever there is one. The fallback exists for the cases it cannot
 * word: a proxy's HTML error page, a response that is not JSON, or no response at all.
 */
const FALLBACK_MESSAGES: Record<number, string> = {
  0: 'We could not reach the server — please check your connection and try again',
  401: 'Your session has ended — please enter your details again',
  403: 'You do not have access to this page',
  404: 'That page was not found',
  429: 'Too many attempts — please wait a moment and try again',
};

function fallbackMessage(status: number): string {
  return FALLBACK_MESSAGES[status] ?? 'Something went wrong — please try again';
}

type ErrorBody = {
  error?: unknown;
  details?: unknown;
};

/** Reads the API's error body without trusting it — it may be absent, HTML, or the wrong shape. */
function readErrorBody(body: unknown): { message?: string; details: ApiFieldIssue[] } {
  if (typeof body !== 'object' || body === null) return { details: [] };

  const { error, details } = body as ErrorBody;

  const parsedDetails: ApiFieldIssue[] = Array.isArray(details)
    ? details.flatMap((detail) => {
        if (typeof detail !== 'object' || detail === null) return [];
        const { field, message } = detail as { field?: unknown; message?: unknown };
        return typeof field === 'string' && typeof message === 'string'
          ? [{ field, message }]
          : [];
      })
    : [];

  return {
    ...(typeof error === 'string' ? { message: error } : {}),
    details: parsedDetails,
  };
}

/**
 * Performs a JSON request and returns the parsed body, or throws `ApiError`.
 *
 * `credentials: 'same-origin'` is explicit rather than assumed: the student and staff sessions are
 * cookies (Section 13), and in development the SPA is served by Vite while the API lives in the
 * Express process — kept on one origin by the dev proxy, so same-origin is the whole story in both
 * environments and nothing needs to be sent cross-origin.
 */
async function requestJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  let response: Response;

  try {
    response = await fetch(path, {
      ...init,
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json',
        ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...init.headers,
      },
    });
  } catch {
    throw new ApiError(fallbackMessage(0), 0);
  }

  const raw = await response.text();

  let body: unknown;
  try {
    body = raw.length > 0 ? JSON.parse(raw) : undefined;
  } catch {
    body = undefined;
  }

  if (!response.ok) {
    const { message, details } = readErrorBody(body);
    throw new ApiError(message ?? fallbackMessage(response.status), response.status, details);
  }

  return body as T;
}

/** What a student types on the entry page (PRD Section 8.1). */
export type StudentIdentityInput = {
  cohortCode: string;
  rollNumber: string;
  studentName: string;
};

/**
 * Resolves an identity and opens a student session (Section 10).
 *
 * The response is the submission's status and nothing else — the server names none of the record's
 * identifiers, so there is nothing here to remember or attach to a later request. The session
 * cookie the response sets is what carries the identity, and `draft` versus `submitted` is the
 * whole routing decision for the entry page (FR-STU-006).
 */
export async function verifyStudentIdentity(
  input: StudentIdentityInput,
): Promise<{ status: SubmissionStatus }> {
  return requestJson<{ status: SubmissionStatus }>('/api/session/student-verify', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

/**
 * Fetches the draft and the content it was created under (Section 10).
 *
 * No id is passed, and none could be: the session cookie names the submission, which is why there
 * is nothing here for a page to get wrong. `content` resolves against the draft's own frozen
 * `contentVersion`, so a student who started under an older version keeps being asked the questions
 * they started on rather than today's.
 */
export async function getDraft(): Promise<StudentDraft> {
  return requestJson<StudentDraft>('/api/student/draft');
}

/**
 * Saves one section's answers (Section 10, Section 12).
 *
 * The body names a single section and carries only that section's answers, because that is the unit
 * the server merges on: a request that could send the whole `answers` object would make every save
 * a full overwrite and two tabs on different sections would clobber each other. Keeping the type
 * narrow here is what makes that hard to get wrong at a call site.
 */
export async function saveSection(
  body: DraftAutosaveBody,
): Promise<{ status: 'saved'; section: SectionKey }> {
  return requestJson<{ status: 'saved'; section: SectionKey }>('/api/student/draft', {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
}

/**
 * Finalizes the submission (Section 10, FR-ASSESS-008).
 *
 * Sends no body: there is nothing for the client to say. The server reads the answers it already
 * holds for the session's submission and re-checks completeness itself (T5.2.1) — a client that
 * could assert its own completeness could also lie about it (Section 12).
 *
 * The endpoint is implemented in T5.2.2; until it exists this call is refused, and the submit
 * control reports that refusal rather than pretending the submission happened. The call is written
 * here because this is where the student's submit action lives — T5.2.2 is a server-side task with
 * no frontend counterpart in the plan.
 */
export async function submitAssessment(): Promise<void> {
  await requestJson<unknown>('/api/student/submit', { method: 'POST' });
}

/** What a staff member types on the login page (FR-STAFF-001). */
export type StaffCredentials = {
  email: string;
  password: string;
};

/**
 * Exchanges staff credentials for a staff session (Section 10, FR-STAFF-001).
 *
 * The response carries no payload beyond success, and there is nothing else it could carry: one
 * permission level exists in the MVP (FR-STAFF-003), so the cookie the response sets is the whole
 * of what the SPA gains. It does not return the cookie or read it — it is httpOnly (Section 13),
 * so the browser holds it and this module never sees it.
 *
 * A refusal arrives as an `ApiError` carrying the server's own message, and Section 11 makes that
 * message the same one for a wrong password and for an email with no account behind it. So this
 * call cannot be made to tell the two apart even by a caller who wanted to — the distinction is
 * refused on the server, not merely left unrendered here.
 */
export async function staffLogin(credentials: StaffCredentials): Promise<void> {
  await requestJson<{ ok: true }>('/api/staff/login', {
    method: 'POST',
    body: JSON.stringify(credentials),
  });
}

/**
 * The dashboard's aggregate metrics (Section 10, FR-STAFF-004–009).
 *
 * `cohortId` is omitted rather than sent empty for "all cohorts", because that is what the server
 * treats as unfiltered: omitting the parameter and sending an empty string are different requests,
 * and only the first means "everything". The server refuses an id that names no cohort with a 404
 * rather than answering with an empty payload, so a stale filter cannot be mistaken for a cohort
 * with no data.
 *
 * The return type is imported from `DashboardService` — `import type`, so nothing of that module
 * reaches the browser bundle. It lives there rather than in `src/shared/types` because the dashboard
 * payload is the service's own answer, passed through by the route unchanged; see the note in
 * `src/shared/types/staff.ts`.
 */
export async function getStaffDashboard(cohortId?: string): Promise<DashboardPayload> {
  const query = cohortId === undefined ? '' : `?cohortId=${encodeURIComponent(cohortId)}`;

  return requestJson<DashboardPayload>(`/api/staff/dashboard${query}`);
}

/**
 * One submission in full, for authorized staff (Section 10, FR-STAFF-010).
 *
 * The id goes in the path, which is the one place in this application where a record is named by a
 * URL — and it is a *staff* route behind a staff session, deliberately unlike the student side,
 * where Section 9 has no ID-bearing route at all (NFR-SEC-009). The two are not in tension: a
 * student session is scoped to exactly one submission by the cookie, while a staff session is a
 * credential and the id is a parameter of the request it authorizes.
 *
 * A `401` means the staff session has ended and the page belongs back at the login form; a `404`
 * means the id names no submission, which is a state the page reports rather than redirects on.
 */
export async function getStaffSubmissionDetail(submissionId: string): Promise<StaffSubmissionDetail> {
  return requestJson<StaffSubmissionDetail>(
    `/api/staff/submissions/${encodeURIComponent(submissionId)}`,
  );
}

/**
 * Downloads the CSV export as a file (Section 10, FR-STAFF-011).
 *
 * The one call in this module that does not go through `requestJson`, because its success response
 * is not JSON. Its *failures* still are — every refusal this API produces is the `{ error, details }`
 * shape Section 11 defines — so those are parsed exactly as `requestJson` parses them and thrown as
 * the same `ApiError`, and a page handles a refused export the way it handles every other refusal.
 *
 * The filename comes from the server's `Content-Disposition` rather than being rebuilt here. The
 * server is what decided to date the file and to name the cohort in it; a second construction of the
 * same name would be a second place for it to differ.
 *
 * Fetched into a blob rather than triggered by an `<a href download>`, which would be shorter. A
 * plain anchor cannot see a 401 — the browser would save the error body as a `.csv` file and the
 * staff member would open a one-line JSON document believing it was their data. Fetching lets the
 * page recognise an ended session and send them to the login form instead.
 */
export async function downloadStaffExportCsv(
  cohortId?: string,
): Promise<{ blob: Blob; filename: string }> {
  const query = cohortId === undefined ? '' : `?cohortId=${encodeURIComponent(cohortId)}`;

  let response: Response;
  try {
    response = await fetch(`/api/staff/export.csv${query}`, {
      credentials: 'same-origin',
      headers: { Accept: 'text/csv' },
    });
  } catch {
    throw new ApiError(fallbackMessage(0), 0);
  }

  if (!response.ok) {
    let body: unknown;
    try {
      body = JSON.parse(await response.text());
    } catch {
      body = undefined;
    }

    const { message, details } = readErrorBody(body);
    throw new ApiError(message ?? fallbackMessage(response.status), response.status, details);
  }

  return {
    blob: await response.blob(),
    filename: filenameFrom(response) ?? 'lexora-submissions.csv',
  };
}

/**
 * The `filename="…"` the server set, if it set one.
 *
 * Read defensively because a `Content-Disposition` header is a string this code did not compose: it
 * may be absent (a proxy stripped it), or shaped differently than expected. A missing name falls back
 * to a generic one at the call site rather than throwing — the download is still correct, and a
 * filename is not worth failing it over.
 */
function filenameFrom(response: Response): string | undefined {
  const disposition = response.headers.get('content-disposition');

  return disposition?.match(/filename="([^"]*)"/)?.[1];
}

/**
 * Fetches the report for the session's submission (Section 10).
 *
 * The same response `submitAssessment` produces, which is the point: submitting and returning later
 * are the same read of the same stored state (FR-FEEDBACK-005), so a student who reloads sees what
 * they saw, and the page polls this one call while writing evaluation is still running (Section 5).
 *
 * A `409` means the assessment has not been submitted, and a `401` means the session is gone. Both
 * are states the page acts on rather than messages it renders — see `ReportPage`.
 */
export async function getReport(): Promise<StudentReport> {
  return requestJson<StudentReport>('/api/student/report');
}
