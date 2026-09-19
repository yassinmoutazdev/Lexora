import { Eye, EyeOff } from 'lucide-react';
import { useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { ApiError, describeRefusal, staffLogin } from '../../api/client';
import { ThemeToggle } from '../../components/ThemeToggle';
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
 * ## The password visibility toggle
 *
 * `type="text"`/`type="password"` is swapped locally in this component's own state — never sent
 * anywhere, never persisted — so revealing the password on this one page has no effect beyond it.
 * The button is `tabIndex={-1}` and not part of the field's tab order: it is a convenience for
 * proofreading what was typed, not a stop on the way to the submit button, and keeping it out of
 * tab order means Enter-to-submit from the password field still works exactly as it did before.
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

const FIELDS: {
  name: FieldName;
  label: string;
  type: string;
  autoComplete: string;
  first?: boolean;
}[] = [
  { name: 'email', label: 'Email', type: 'email', autoComplete: 'username', first: true },
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
  // Off by default: a staff member's screen may be shared or glanced at, and the field should start
  // masked the same way any password field does — this only reveals it on the person's own request.
  const [passwordVisible, setPasswordVisible] = useState(false);

  /** The notice, so a credential refusal can be moved to rather than only announced. */
  const notice = useRef<HTMLDivElement>(null);
  /** The form, so a validation refusal can find the field it belongs to. */
  const form = useRef<HTMLFormElement>(null);

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
        setRefusal(describeRefusal(error));
      } else {
        // Nothing on this page should throw anything else; if something does, the person still
        // gets a sentence rather than a blank screen.
        setRefusal('Something went wrong — please try again');
      }

      setSubmitting(false);

      /*
        Move the reader to the refusal, for the reason `EntryPage` records: the notice renders above
        the form while focus stays on the submit button below it.

        The generic credential refusal has no field to belong to — Section 13 requires that it name
        neither — so focus goes to the notice. That is also why the notice is focusable at all: it is
        the only place the message exists.
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
        <h1>Staff login</h1>
        <p className="lede">Sign in to view assessment results and export the pilot data.</p>

        {refusal !== null && (
          // `tabIndex={-1}` so the credential refusal, which belongs to no field, can be focused.
          <div className="notice" role="alert" ref={notice} tabIndex={-1}>
            <p>{refusal}</p>
          </div>
        )}

        <form onSubmit={handleSubmit} noValidate ref={form} aria-busy={submitting}>
          {FIELDS.map((field) => {
            const issue = fieldIssues[field.name];

            return (
              <div key={field.name} className={`field${issue ? ' field--invalid' : ''}`}>
                <label htmlFor={field.name}>{field.label}</label>
                <div className={field.name === 'password' ? 'field-with-toggle' : undefined}>
                  <input
                    id={field.name}
                    name={field.name}
                    type={field.name === 'password' && passwordVisible ? 'text' : field.type}
                    value={values[field.name]}
                    onChange={(event) => update(field.name, event.target.value)}
                    aria-describedby={issue ? `${field.name}-error` : undefined}
                    aria-invalid={issue ? true : undefined}
                    autoFocus={field.first}
                    autoComplete={field.autoComplete}
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                    disabled={submitting}
                  />
                  {field.name === 'password' && (
                    <button
                      type="button"
                      className="field-toggle"
                      onClick={() => setPasswordVisible((visible) => !visible)}
                      disabled={submitting}
                      aria-label={passwordVisible ? 'Hide password' : 'Show password'}
                      aria-pressed={passwordVisible}
                      tabIndex={-1}
                    >
                      {passwordVisible ? <EyeOff size={18} /> : <Eye size={18} />}
                    </button>
                  )}
                </div>
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
