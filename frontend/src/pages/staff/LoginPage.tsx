import { useState } from 'react';
import type { FormEvent } from 'react';
import { ApiError, staffLogin } from '../../api/client';
import { Link, navigate } from '../../router';

/**
 * The staff login page — the only public staff route (PRD Section 9.7, FR-STAFF-001).
 *
 * Two fields and one button. The page's whole job is to exchange them for a session cookie and get
 * out of the way: it renders no staff data, because there is none it could render without a
 * session, and it offers no account creation, because NFR-SEC-004 provisions staff manually and
 * there is deliberately no self-service path to build a link to.
 *
 * ## One refusal, worded by the server
 *
 * Section 11 gives this endpoint two different answers, and only one of them is about the form.
 * A body the schema rejected comes back with `details`, one per field, and those are shown against
 * the fields the caller can fix. A credential that does not resolve comes back with a single
 * generic message and *no* details — Section 13 requires that a failed login never reveal which of
 * the two was wrong, so there is no field to attach it to and it is shown once, above the form.
 * Both are rendered exactly as the server worded them: the message lives on the server, and a
 * second copy here would be a second thing to keep in step with it.
 *
 * ## Where success goes
 *
 * `/staff/dashboard`, the first route in Section 9's staff table, and `replace` rather than `push`
 * for the reason `EntryPage` gives: the form is behind them now, and stepping back into it would
 * only offer a login they are already holding. The page does not verify the session it just
 * obtained — a second request to prove the first one worked would be the SPA second-guessing the
 * server about its own authority, and the dashboard's own 401 handling is what turns "the session
 * did not stick" into a return to this page (T8.3.1).
 */

/** One login field, so reading and clearing the two does not repeat their names. */
type FieldName = 'email' | 'password';

const FIELDS: { name: FieldName; label: string; type: string; autoComplete: string }[] = [
  { name: 'email', label: 'Email', type: 'email', autoComplete: 'username' },
  { name: 'password', label: 'Password', type: 'password', autoComplete: 'current-password' },
];

type Values = Record<FieldName, string>;

const EMPTY: Values = { email: '', password: '' };

/** Field-level issues keyed by field name, from a validation refusal. */
type FieldIssues = Partial<Record<string, string>>;

export function LoginPage() {
  const [values, setValues] = useState<Values>(EMPTY);
  const [fieldIssues, setFieldIssues] = useState<FieldIssues>({});
  const [refusal, setRefusal] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  function update(name: FieldName, value: string) {
    setValues((current) => ({ ...current, [name]: value }));

    // Clearing as they type, so a corrected field stops looking wrong immediately rather than only
    // after the next attempt.
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
      await staffLogin(values);
      navigate('/staff/dashboard', { replace: true });
    } catch (error) {
      if (error instanceof ApiError && error.details.length > 0) {
        setFieldIssues(
          Object.fromEntries(error.details.map((issue) => [issue.field, issue.message])),
        );
      } else if (error instanceof ApiError) {
        setRefusal(error.message);
      } else {
        // Nothing on this page should throw anything else; if something does, the person still
        // gets a sentence rather than a blank screen.
        setRefusal('Something went wrong — please try again');
      }

      setSubmitting(false);
    }
  }

  return (
    <main className="page">
      <div className="card">
        <h1>Staff login</h1>
        <p className="lede">Sign in to view assessment results and export the pilot data.</p>

        {refusal !== null && (
          <div className="notice" role="alert">
            <p>{refusal}</p>
          </div>
        )}

        <form onSubmit={handleSubmit} noValidate>
          {FIELDS.map((field) => {
            const issue = fieldIssues[field.name];

            return (
              <div key={field.name} className={`field${issue ? ' field--invalid' : ''}`}>
                <label htmlFor={field.name}>{field.label}</label>
                <input
                  id={field.name}
                  name={field.name}
                  type={field.type}
                  value={values[field.name]}
                  onChange={(event) => update(field.name, event.target.value)}
                  aria-describedby={issue ? `${field.name}-error` : undefined}
                  aria-invalid={issue ? true : undefined}
                  autoComplete={field.autoComplete}
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  disabled={submitting}
                />
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
              {submitting ? 'Signing in…' : 'Sign in'}
            </button>
          </div>
        </form>
      </div>

      {/* The way back for someone who reached this page by mistake. Student-facing routes are a
          separate access boundary (NFR-SEC-005), so this is a plain link and not a session action:
          holding a staff session grants nothing on the student side, and vice versa (Section 9). */}
      <Link to="/" className="staff-link">
        Back to the student entry page
      </Link>
    </main>
  );
}
