import { useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { ApiError, describeRefusal, verifyStudentIdentity } from '../../api/client';
import { ThemeToggle } from '../../components/ThemeToggle';
import { Link, navigate } from '../../router';

/**
 * The entry page — the first thing a student sees (PRD Section 8.1 steps 1–6, FR-STU-001/002).
 *
 * Three fields and one button, because there is nothing else to ask: no account, no password
 * (FR-STU-004), just the cohort code, the roll number, and the name that together identify them.
 *
 * ## The one decision this page makes
 *
 * What the server answered with. `draft` means the assessment is theirs to start; `submitted` means
 * it is already finished and the report is the only thing left to see (FR-STU-006, Section 8.2).
 * The page routes on that and does not attempt to work it out for itself — it has no access to the
 * submission and could not check if it wanted to.
 *
 * ## Two kinds of refusal, told apart
 *
 * Section 11 gives this endpoint two different 400s, and they mean opposite things to the person
 * typing. A body the schema rejected comes back with `details`, one per field, because the caller
 * already knows what they sent and the fix is in their own form — those are shown against the
 * fields. An identity that does not resolve comes back with a single generic message and *no*
 * details, naming nothing, because naming the wrong field would turn this page into a way to
 * discover the other two (Section 13). Both are surfaced as the server worded them: there is one
 * copy of that message and it lives on the server.
 */

/** One entry-page field, so resetting and reading issues does not repeat the field names. */
type FieldName = 'cohortCode' | 'rollNumber' | 'studentName';

/**
 * The fields, in the order they are asked.
 *
 * `first` marks the one the cursor starts in. The page has exactly one purpose and one field to
 * start with, so on a phone — where this form is most often filled in — landing in the field saves
 * a tap that has no decision behind it.
 */
const FIELDS: {
  name: FieldName;
  label: string;
  hint?: string;
  autoComplete?: string;
  first?: boolean;
}[] = [
  { name: 'cohortCode', label: 'Cohort code', hint: 'The access code given to your group', first: true },
  { name: 'rollNumber', label: 'University roll number' },
  { name: 'studentName', label: 'Your name', hint: 'As it appears on your university record' },
];

type Values = Record<FieldName, string>;

const EMPTY: Values = { cohortCode: '', rollNumber: '', studentName: '' };

/** Field-level issues keyed by field name, from a validation refusal. */
type FieldIssues = Partial<Record<string, string>>;

export function EntryPage() {
  const [values, setValues] = useState<Values>(EMPTY);
  const [fieldIssues, setFieldIssues] = useState<FieldIssues>({});
  const [refusal, setRefusal] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  /** The notice, so a refusal can be moved to rather than only announced. */
  const notice = useRef<HTMLDivElement>(null);
  /** The form, so a validation refusal can find the field it belongs to. */
  const form = useRef<HTMLFormElement>(null);

  function update(name: FieldName, value: string) {
    setValues((current) => ({ ...current, [name]: value }));

    // Clearing as the student types, so a corrected field stops looking wrong immediately rather
    // than only after the next attempt.
    setFieldIssues((current) => {
      if (!(name in current)) return current;
      const { [name]: _cleared, ...rest } = current;
      return rest;
    });
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    setSubmitting(true);
    setRefusal(null);
    setFieldIssues({});

    try {
      const { status } = await verifyStudentIdentity(values);

      // `replace` rather than `push`: the entry form is behind them now, and stepping back into it
      // from the assessment would only re-verify and bounce them forward again.
      navigate(status === 'draft' ? '/assessment' : '/report', { replace: true });
    } catch (error) {
      if (error instanceof ApiError && error.details.length > 0) {
        setFieldIssues(
          Object.fromEntries(error.details.map((issue) => [issue.field, issue.message])),
        );
      } else if (error instanceof ApiError) {
        setRefusal(describeRefusal(error));
      } else {
        // Nothing in this page should throw anything else; if something does, the student still
        // gets a sentence rather than a blank screen.
        setRefusal('Something went wrong — please try again');
      }

      setSubmitting(false);

      /*
        Move the reader to the refusal.

        `role="alert"` announces it, and that is enough for a screen reader — but the notice renders
        above the form while focus stays on the submit button at the bottom, so a keyboard user has
        to reverse-tab back up to reach the message they were just told about. A validation refusal
        goes to the field it is about; an identity refusal has no field to belong to, so it goes to
        the notice itself.

        Deferred a frame because both of those elements are rendered by the state updates above, and
        the one to focus does not exist until React has committed them.
      */
      window.requestAnimationFrame(() => {
        const firstInvalid = form.current?.querySelector<HTMLInputElement>('[aria-invalid="true"]');

        if (firstInvalid) {
          firstInvalid.focus();
          return;
        }

        notice.current?.focus();
      });
    }
  }

  return (
    <main className="page page--toggle">
      <ThemeToggle variant="floating" />
      <div className="card">
        <h1>English assessment</h1>
        <p className="lede">
          Enter the details below to begin. You can leave and come back at any time before you
          submit, and your progress will be saved.
        </p>

        {refusal !== null && (
          // `tabIndex={-1}` so a refusal with no field to belong to can be focused and read from.
          <div className="notice" role="alert" ref={notice} tabIndex={-1}>
            <p>{refusal}</p>
          </div>
        )}

        {/* `aria-busy` says the form is working, which the disabled controls alone only imply. */}
        <form onSubmit={handleSubmit} noValidate ref={form} aria-busy={submitting}>
          {FIELDS.map((field) => {
            const issue = fieldIssues[field.name];

            return (
              <div key={field.name} className={`field${issue ? ' field--invalid' : ''}`}>
                <label htmlFor={field.name}>{field.label}</label>
                <input
                  id={field.name}
                  name={field.name}
                  value={values[field.name]}
                  onChange={(event) => update(field.name, event.target.value)}
                  aria-describedby={issue ? `${field.name}-error` : undefined}
                  aria-invalid={issue ? true : undefined}
                  autoFocus={field.first}
                  autoComplete="off"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  disabled={submitting}
                />
                {field.hint && !issue && <p className="hint">{field.hint}</p>}
                {issue && (
                  <p className="field-error" id={`${field.name}-error`}>
                    {issue}
                  </p>
                )}
              </div>
            );
          })}

          <div className="button-row">
            <button type="submit" disabled={submitting}>
              {submitting ? 'Checking…' : 'Begin assessment'}
            </button>
          </div>
        </form>
      </div>

      {/* PRD Section 8.1 / FR-STU-008: a small, clearly labeled Staff login link — the page behind
          it is built in E8 (T8.3.2), so for now this points at the route it will live on. */}
      <Link to="/staff/login" className="staff-link">
        Staff login
      </Link>
    </main>
  );
}
