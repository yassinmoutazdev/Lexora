import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { normaliseCohortCode } from '../../../../src/shared/cohortCode';
import type { StaffCohort } from '../../../../src/shared/types/staff';
import { ApiError, createStaffCohort, getStaffCohorts } from '../../api/client';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { SkeletonCard, SkeletonStatus } from '../../components/Skeleton';
import { StaffLayout } from '../../components/StaffLayout';
import { navigate } from '../../router';

/**
 * Cohort provisioning (FR-STU-001, ARCHITECTURE Section 9).
 *
 * ## What this page is for
 *
 * Every student reaches the assessment by typing an access code (PRD Section 8.1 step 2). Before
 * this page there was no way to create one outside a development seed script — and production runs
 * migrations and nothing else, so a deployed instance had no cohorts at all and every student would
 * have been told "we couldn't find a matching record". This is the screen that makes a deployment
 * usable.
 *
 * ## Create and read, and nothing else
 *
 * There is no edit and no delete, following the routes. Changing a `code` locks out every student
 * already given it, and deleting a cohort either cascades into immutable submissions or has to
 * refuse — neither is a button worth putting on a screen until its guardrails have been thought
 * through. What a staff member needs at provisioning time is to make a code and to see the ones
 * that exist.
 *
 * ## Why the confirmation shows the code rather than describing it
 *
 * Codes are stored upper-cased and trimmed (`src/shared/cohortCode.ts`), and students have to type
 * the stored form exactly — `CohortRepository.findByCode` matches character for character. So a
 * staff member who types `autumn-2026` is about to hand out `AUTUMN-2026`, and the one moment that
 * is worth saying is before the row exists. The dialog renders the preview using the same function
 * the server stores with, so it cannot promise one thing and write another.
 *
 * The success notice repeats the server's returned code rather than the preview, because the
 * response is what actually exists and the code is the thing being handed out.
 */

/** Inserts a created cohort in the order the server lists them — by code, ascending. */
function withCohortInserted(current: StaffCohort[], cohort: StaffCohort): StaffCohort[] {
  return [...current, cohort].sort((a, b) => a.code.localeCompare(b.code));
}

export function CohortsPage() {
  const [cohorts, setCohorts] = useState<StaffCohort[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    getStaffCohorts()
      .then(({ cohorts: loaded }) => {
        if (cancelled) return;

        setCohorts(loaded);
        setLoadError(null);
      })
      .catch((error: unknown) => {
        if (cancelled) return;

        // A lost staff session is a navigation rather than a message, as on every other staff page.
        if (error instanceof ApiError && error.status === 401) {
          navigate('/staff/login', { replace: true });
          return;
        }

        setLoadError(error instanceof ApiError ? error.message : 'Something went wrong');
      });

    return () => {
      cancelled = true;
    };
  }, []);

  // Inside the shell, so a failure does not also take away the navigation — the same note
  // `DashboardPage` carries about its own shell states.
  if (loadError !== null && cohorts === null) {
    return (
      <StaffLayout activeItem="cohorts" title="Cohorts">
        <div className="card">
          <h2>We could not load the cohorts</h2>
          <div className="notice" role="alert">
            <p>{loadError}</p>
          </div>
          <p className="hint">
            Your session is still active, and nothing has been lost. Reloading usually fixes this.
          </p>
          <div className="button-row">
            <button type="button" onClick={() => window.location.reload()}>
              Reload
            </button>
          </div>
        </div>
      </StaffLayout>
    );
  }

  if (cohorts === null) {
    return (
      <StaffLayout activeItem="cohorts" title="Cohorts">
        <SkeletonStatus label="Loading the cohorts" />
        <SkeletonCard lines={3} />
        <SkeletonCard lines={4} />
      </StaffLayout>
    );
  }

  return (
    <CohortsBody
      cohorts={cohorts}
      onCreated={(cohort) => setCohorts((current) => withCohortInserted(current ?? [], cohort))}
    />
  );
}

/**
 * The page's contents, given the cohorts that exist.
 *
 * Split from the component above for the reason `DashboardBody` records: the shell owns *when* to
 * fetch and what to do when the fetch is refused, and this owns what the page looks like — which
 * keeps the rendering a pure function of what it is handed.
 */
export function CohortsBody({
  cohorts,
  onCreated,
}: {
  cohorts: StaffCohort[];
  onCreated: (cohort: StaffCohort) => void;
}) {
  return (
    <StaffLayout activeItem="cohorts" title="Cohorts">
      <CreateCohortCard onCreated={onCreated} />

      <div className="card">
        <h2>Access codes</h2>
        <p className="hint">
          The codes students enter on the entry page. A code is an identifier, not a secret — it
          tells the system which group a student belongs to and gates nothing on its own
          (NFR-SEC-002).
        </p>

        {cohorts.length === 0 ? (
          // The empty state says what is actually at stake rather than only that the list is empty:
          // with no cohort, the assessment cannot be taken by anybody.
          <div className="empty-state">
            <p className="empty-state-lead">No cohorts yet.</p>
            <p className="hint">
              No student can start the assessment until at least one code exists. Create one above
              and give it to the group.
            </p>
          </div>
        ) : (
          <ul className="cohort-list">
            {cohorts.map((cohort) => (
              <li key={cohort.id} className="cohort-row">
                <span className="cohort-code">{cohort.code}</span>
                <span className="cohort-name">{cohort.name}</span>
                <span className="cohort-count">
                  {cohort.submissionCount}{' '}
                  {cohort.submissionCount === 1 ? 'submission' : 'submissions'}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </StaffLayout>
  );
}

/**
 * The create form, its confirmation, and its outcome.
 *
 * `phase` is one value rather than a pair of booleans, for the reason `SubmitControl` gives: the
 * dialog being open and the request being in flight are different promises to the reader, and two
 * booleans would allow a state that means neither.
 */
function CreateCohortCard({ onCreated }: { onCreated: (cohort: StaffCohort) => void }) {
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [phase, setPhase] = useState<'idle' | 'confirming' | 'creating'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<StaffCohort | null>(null);

  const previewCode = normaliseCohortCode(code);
  const ready = code.trim().length > 0 && name.trim().length > 0;
  const busy = phase === 'creating';

  /** Opens the confirmation. The request itself waits for it. */
  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);

    if (!ready) return;

    setPhase('confirming');
  }

  async function createCohort() {
    setPhase('creating');
    setError(null);

    try {
      const { cohort } = await createStaffCohort({ code, name });

      setCreated(cohort);
      onCreated(cohort);
      setCode('');
      setName('');
      setPhase('idle');
    } catch (error: unknown) {
      // A duplicate code arrives here as the server's own words, which quote the normalised form
      // that collided — the useful half of the answer when the staff member typed lowercase.
      setError(error instanceof ApiError ? error.message : 'Something went wrong');
      setPhase('idle');
    }
  }

  return (
    <div className="card">
      <h2>Create a cohort</h2>
      <p className="hint">
        This creates one access code for one group. Students type it alongside their roll number and
        name on the entry page.
      </p>

      {created !== null && (
        <div className="notice" role="status">
          <p>
            Created. Students in <strong>{created.name}</strong> can now enter:
          </p>
          <p className="cohort-code cohort-code--notice">{created.code}</p>
        </div>
      )}

      {error !== null && (
        <div className="notice" role="alert">
          <p>{error}</p>
        </div>
      )}

      <form onSubmit={handleSubmit} noValidate aria-busy={busy}>
        <div className="field">
          <label htmlFor="cohortCode">Access code</label>
          <input
            id="cohortCode"
            name="cohortCode"
            value={code}
            onChange={(event) => setCode(event.target.value)}
            autoComplete="off"
            autoCapitalize="characters"
            autoCorrect="off"
            spellCheck={false}
            disabled={busy}
          />
          <p className="hint">
            Stored in capitals, and trimmed of surrounding spaces. Students must type it exactly.
          </p>
        </div>

        <div className="field">
          <label htmlFor="cohortName">Description</label>
          <input
            id="cohortName"
            name="cohortName"
            value={name}
            onChange={(event) => setName(event.target.value)}
            autoComplete="off"
            disabled={busy}
          />
          <p className="hint">For staff. Students never see this.</p>
        </div>

        <div className="button-row">
          <button type="submit" disabled={!ready || busy}>
            Create cohort
          </button>
        </div>
      </form>

      <ConfirmDialog
        open={phase === 'confirming' || phase === 'creating'}
        title="Create this access code?"
        confirmLabel="Create cohort"
        busyLabel="Creating…"
        busy={busy}
        onConfirm={() => void createCohort()}
        onCancel={() => setPhase('idle')}
      >
        <p>
          Students in <strong>{name.trim()}</strong> will enter this code exactly as shown:
        </p>
        <p className="cohort-code cohort-code--dialog">{previewCode}</p>
        <p>
          It is stored in capitals and cannot be changed afterwards, so the code you hand out is the
          code above.
        </p>
      </ConfirmDialog>
    </div>
  );
}
