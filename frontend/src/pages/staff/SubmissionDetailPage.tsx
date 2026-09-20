import { useEffect, useState } from 'react';
import type { StaffSubmissionDetail } from '../../../../src/shared/types/staff';
import type { ProcessingStatus } from '../../../../src/shared/types/sections';
import { ApiError, getStaffSubmissionDetail } from '../../api/client';
import { SkeletonCard, SkeletonStatus } from '../../components/Skeleton';
import { StaffLayout } from '../../components/StaffLayout';
import { Link, navigate } from '../../router';

/**
 * One submission in full, for authorized staff (T8.2.2, FR-STAFF-010).
 *
 * ## The rule this page exists to keep
 *
 * FR-PROB-011: AI-generated interpretations and categories *"must be clearly labeled as **derived
 * data** — not presented as the student's original words or as guaranteed fact."* Everything else
 * here is layout; that requirement is the reason the Student Problems panel is built the way it is.
 *
 * The API's contract already keeps the two apart — `openTextOriginal` and `textDerived` are
 * different fields and a page cannot render one where the other belongs. This page has to finish the
 * job visually: the student's own words and the model's reading of them are given different
 * containers, different headings, and an explicit "derived" tag, so a staff member skimming the page
 * cannot mistake one for the other. Two blocks that looked alike would satisfy the letter of the
 * requirement and defeat its purpose.
 *
 * ## It is not a report, and it is not the student's page
 *
 * `/report` is what the student sees: their own results, scored fresh, with every question's
 * explanation. This is the internal record — the stored columns as the database holds them, the full
 * evaluation, and the Student Problems data the student is never shown (FR-PROB-007, FR-PROB-015).
 * The page says so at the top, because a staff member reading a page that *looks* like a student
 * report should be told which one they are looking at.
 *
 * ## Every access is logged server-side (Section 13)
 *
 * The server writes a `staff_submission_access` line for each request this page makes, including the
 * ones that find nothing. Nothing about that is visible here, and nothing here could switch it off.
 */

export function SubmissionDetailPage({ submissionId }: { submissionId: string }) {
  const [submission, setSubmission] = useState<StaffSubmissionDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  /** Whether the refusal was a 404, which is a different situation from a load that merely failed. */
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    let cancelled = false;

    getStaffSubmissionDetail(submissionId)
      .then((loaded) => {
        if (!cancelled) setSubmission(loaded);
      })
      .catch((error: unknown) => {
        if (cancelled) return;

        // A lost staff session is a navigation, not a message: re-authenticating is the only way
        // back, and it is where pressing Back from here should land anyway. `replace` so the login
        // form does not sit in front of the page the reader actually wanted.
        if (error instanceof ApiError && error.status === 401) {
          navigate('/staff/login', { replace: true });
          return;
        }

        setMissing(error instanceof ApiError && error.status === 404);
        setLoadError(error instanceof ApiError ? error.message : 'Something went wrong');
      });

    return () => {
      // React 18's development StrictMode runs effects twice; without this, a stale response could
      // overwrite a fresh one.
      cancelled = true;
    };
  }, [submissionId]);

  // Inside the shell, so a failure here does not also remove the navigation the reader needs to get
  // somewhere that works. See `DashboardPage` for the full note.
  if (loadError !== null) {
    return (
      <StaffLayout activeItem="submissions" title="Submission">
        <div className="card">
          <h2>{missing ? 'That submission does not exist' : 'We could not load that submission'}</h2>
          <div className="notice" role="alert">
            <p>{loadError}</p>
          </div>

          {/*
            A 404 and a transient failure are different problems and used to read identically.

            "No such submission" covers a mistyped id, a stale bookmark, and a record that is
            genuinely gone, and it offers no way to tell them apart. What a staff member can act on
            is the difference between "this link is wrong" — where the list is the answer — and
            "this did not load", where reloading is.
          */}
          <p className="hint">
            {missing
              ? 'The link may be out of date, or the address may have been mistyped. The submissions list shows every record that exists.'
              : 'Your session is still active, and nothing has been lost. Reloading usually fixes this.'}
          </p>

          <div className="button-row">
            {!missing && (
              <button type="button" onClick={() => window.location.reload()}>
                Reload
              </button>
            )}
            <Link to="/staff/submissions">Back to submissions</Link>
          </div>
        </div>
      </StaffLayout>
    );
  }

  if (!submission) {
    return (
      <StaffLayout activeItem="submissions" title="Submission">
        <SkeletonStatus label="Loading the submission" />
        <SkeletonCard lines={3} />
        <SkeletonCard lines={4} />
      </StaffLayout>
    );
  }

  return <SubmissionDetailBody submission={submission} />;
}

/**
 * The page's contents, given a submission.
 *
 * Split from the component above so the rendering is a pure function of what it is handed — the same
 * split, for the same reason, as `ReportPage` / `ReportBody`: the shell owns *when* to fetch and
 * what to do when the fetch is refused, and this owns what a submission looks like.
 */
export function SubmissionDetailBody({ submission }: { submission: StaffSubmissionDetail }) {
  return (
    <StaffLayout activeItem="submissions" title={submission.studentName}>
      <div className="card">
        <p className="lede">
          Roll number <strong>{submission.rollNumber}</strong> · {submission.cohort.code}
          {submission.cohort.name !== '' && <> ({submission.cohort.name})</>}
        </p>
        <p className="muted">
          {submission.status === 'submitted' && submission.submittedAt !== null
            ? `Submitted ${formatTimestamp(submission.submittedAt)}`
            : 'Still a draft — this student has not submitted yet.'}
          {' · '}
          Content version {submission.contentVersion}
        </p>
        <p className="hint">
          This is the internal record for one submission, visible to staff only. Opening it is
          recorded in the server log.
        </p>
        <Link to="/staff/dashboard">Back to the dashboard</Link>
      </div>

      <ScoresPanel submission={submission} />
      <WritingPanel submission={submission} />
      <StudentProblemsPanel submission={submission} />
    </StaffLayout>
  );
}

/** An ISO timestamp as a date and time a staff member reads, in their own locale. */
function formatTimestamp(iso: string): string {
  const at = new Date(iso);

  if (Number.isNaN(at.getTime())) return iso;

  return at.toLocaleString(undefined, {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * The deterministic scores, as stored.
 *
 * A dash for a null rather than a zero: a draft has no scores at all, and printing `0` would report
 * a score the student never received. The stored columns are shown rather than a recomputation —
 * these are the numbers the report was built from and the dashboard aggregates over (see
 * `StaffSubmissionDetail`).
 */
function ScoresPanel({ submission }: { submission: StaffSubmissionDetail }) {
  const sections: { label: string; score: number | null }[] = [
    { label: 'Grammar', score: submission.scores.grammar },
    { label: 'Vocabulary', score: submission.scores.vocabulary },
    { label: 'Reading', score: submission.scores.reading },
  ];

  return (
    <div className="card">
      <h2>Scores</h2>
      <ul className="metric-list">
        {sections.map((section) => (
          <li key={section.label} className="metric">
            <span className="metric-label">{section.label}</span>
            <span className="metric-value">{section.score ?? '—'}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * The writing evaluation (FR-WRITE-005/006/007, FR-WRITE-011).
 *
 * Keyed off the status, unlike the student report, which keys off whether there is feedback to show.
 * The difference is the audience: a student must never be told results that are not there
 * (FR-FEEDBACK-008), while staff need to know *which* state a submission is in — "still being
 * evaluated" and "evaluation gave up and needs review" are different facts about the pilot, and a
 * staff member is exactly who needs the second one.
 */
function WritingPanel({ submission }: { submission: StaffSubmissionDetail }) {
  const { writing } = submission;

  const statusCopy: Record<ProcessingStatus, string> = {
    not_applicable: 'No writing evaluation applies to this submission.',
    pending: 'The evaluation has not run yet.',
    processing: 'The evaluation is running.',
    succeeded: 'Evaluation complete.',
    failed_needs_review: 'Evaluation failed and needs review. The response itself is preserved.',
  };

  return (
    <div className="card">
      <h2>
        Writing{' '}
        {writing.overallScore !== null && (
          <span className="score">{writing.overallScore} / 100</span>
        )}
      </h2>

      <p className="muted">{statusCopy[writing.status]}</p>

      {writing.criteria.length > 0 && (
        <ul className="criterion-list">
          {writing.criteria.map((criterion) => (
            <li key={criterion.key} className="criterion">
              <p className="criterion-head">
                <span className="criterion-label">{criterion.label}</span>{' '}
                <span className="score">{criterion.score} / 100</span>
              </p>
              <p className="report-explanation">{criterion.rationale}</p>
            </li>
          ))}
        </ul>
      )}

      {writing.feedback !== null && (
        <>
          <FeedbackList title="Strengths" items={writing.feedback.strengths} />
          <FeedbackList title="Weaknesses" items={writing.feedback.weaknesses} />
          <div className="feedback-block">
            <h3>Corrections</h3>
            {writing.feedback.corrections.length === 0 ? (
              <p className="muted">None.</p>
            ) : (
              <ul className="correction-list">
                {writing.feedback.corrections.map((correction, index) => (
                  <li key={`${index}:${correction.original}`} className="correction">
                    <p className="correction-pair">
                      <span className="correction-original">{correction.original}</span>{' '}
                      <span className="muted">→</span>{' '}
                      <span className="correction-fixed">{correction.corrected}</span>
                    </p>
                    <p className="report-explanation">{correction.explanation}</p>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <FeedbackList title="Suggestions" items={writing.feedback.suggestions} />
        </>
      )}
    </div>
  );
}

/** One titled list of feedback strings, saying "None" rather than leaving a heading empty. */
function FeedbackList({ title, items }: { title: string; items: string[] }) {
  return (
    <div className="feedback-block">
      <h3>{title}</h3>
      {items.length === 0 ? (
        <p className="muted">None.</p>
      ) : (
        <ul>
          {/* Keyed by position: the model may return the same sentence twice. */}
          {items.map((item, index) => (
            <li key={`${index}:${item}`}>{item}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * Student Problems, in the two parts FR-PROB-005 keeps distinct (FR-PROB-011/015).
 *
 * The five-point responses are the student's own data and are shown plainly. The open text is shown
 * twice over — once exactly as the student wrote it, and once as the AI's derived reading of it —
 * and the second is the one this page has to be careful with.
 *
 * ## Why the derived block looks different rather than merely being labelled
 *
 * FR-PROB-011 forbids presenting derived data "as the student's original words". A label alone is
 * satisfied by a heading a reader skips; the two blocks here differ in border, background, and
 * placement *and* carry a tag, so the distinction survives skimming. The original is quoted as the
 * student's own writing would be; the derived text is not, because it is not theirs.
 *
 * ## Why the normalized text is shown at all
 *
 * FR-PROB-010 allows a normalization or translation for analysis, and this is the analysis view. It
 * is rendered as derived data beside its original rather than in place of it, which is the whole of
 * what FR-PROB-010 and FR-PROB-009 require together.
 */
function StudentProblemsPanel({ submission }: { submission: StaffSubmissionDetail }) {
  const { studentProblems } = submission;
  const [showNormalized, setShowNormalized] = useState(false);

  return (
    <div className="card">
      <h2>Student Problems</h2>
      <p className="hint">
        This section never affects any English score (FR-PROB-008/012). It is collected for
        curriculum analysis only, and is visible to staff alone (FR-PROB-015).
      </p>

      <div className="feedback-block">
        <h3>Their responses</h3>
        {studentProblems.likert.length === 0 ? (
          <p className="muted">No statements were answered.</p>
        ) : (
          <ul className="problem-list">
            {studentProblems.likert.map((response) => (
              <li key={response.statementId} className="problem">
                <p className="problem-statement">{response.statement}</p>
                <p className="problem-answer">
                  <span className="muted">{response.areaLabel}: </span>
                  {response.valueLabel ?? response.value}
                  {response.valueLabel !== null && <span className="muted"> ({response.value})</span>}
                </p>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="feedback-block">
        <h3>What they wrote, in their own words</h3>
        {/*
          `dir="auto"` on the blockquote below, because the student may have written in English or
          in Arabic (FR-PROB-004) and only the browser can tell which by looking at it. Without it
          the block stayed LTR and the quote bar drew on the left of Arabic text: `styles.css`'s RTL
          rule keys on a *resolved* direction, and nothing was setting one. The same mechanism the
          student's own textarea uses (see `StudentProblemsSection`), for the same reason.
        */}
        {studentProblems.openTextOriginal === null ? (
          <p className="muted">No open-ended response was given.</p>
        ) : (
          <blockquote className="original-text" dir="auto">
            {studentProblems.openTextOriginal}
          </blockquote>
        )}
        <p className="muted">
          {describeTextStatus(studentProblems.textStatus)}
        </p>
      </div>

      {studentProblems.textDerived !== null && (
        <div className="derived">
          <p className="derived-head">
            <span className="derived-tag">Derived data</span>{' '}
            <span className="muted">— produced by AI from the response above</span>
          </p>
          <p className="hint">
            This is the system's interpretation, not the student's words. It is not a clinical or
            diagnostic assessment (FR-PROB-006), and it may be wrong.
          </p>

          {studentProblems.textDerived.categories.length === 0 ? (
            <p className="muted">No difficulty categories were identified.</p>
          ) : (
            <ul className="category-list">
              {studentProblems.textDerived.categories.map((category, index) => (
                <li key={`${index}:${category.label}`} className="category">
                  <p className="category-label">{category.label}</p>
                  {/* The wording the model based the category on, so a reader can judge it. */}
                  <p className="report-explanation">“{category.evidence}”</p>
                </li>
              ))}
            </ul>
          )}

          {/*
            Collapsed by default, because it is the field most likely to be mistaken for the
            student's own words: it reads as clean English prose and sits under a heading about what
            they wrote. A reader has to ask for it, and the surrounding block already says what it
            is.
          */}
          <p>
            <button
              type="button"
              className="secondary"
              onClick={() => setShowNormalized((current) => !current)}
              aria-expanded={showNormalized}
            >
              {showNormalized ? 'Hide normalized text' : 'Show normalized text'}
            </button>
          </p>
          {showNormalized && (
            <p className="derived-text derived-text--open">
              {studentProblems.textDerived.normalizedText}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

/** What the Student Problems processing status means for a reader looking at this page. */
function describeTextStatus(status: ProcessingStatus): string {
  const copy: Record<ProcessingStatus, string> = {
    not_applicable: 'No open-ended response was given, so there is nothing to process.',
    pending: 'This response has not been analysed yet.',
    processing: 'This response is being analysed.',
    succeeded: 'An analysis of this response is shown below.',
    failed_needs_review:
      'The analysis of this response failed and needs review. The response above is preserved exactly as written.',
  };

  return copy[status];
}
