import type {
  DraftAutosaveBody,
  SectionKey,
  StudentDraft,
  SubmissionStatus,
} from '../../../src/shared/types/draft';

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
