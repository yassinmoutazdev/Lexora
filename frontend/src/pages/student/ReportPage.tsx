import { useEffect, useState } from 'react';
import type { ReportQuestion, ReportSection, StudentReport } from '../../../../src/shared/types/draft';
import {
  DETERMINISTIC_SECTION_KEYS,
  type ProcessingStatus,
} from '../../../../src/shared/types/sections';
import { ApiError, getReport } from '../../api/client';
import { navigate } from '../../router';

/**
 * The report — what the student sees after submitting, and what they come back to (T5.3.2).
 *
 * PRD Section 8.1 step 9 is the specification: *"Student sees the report page immediately, with
 * deterministic results shown and a 'Writing feedback is still being prepared' status if the LLM
 * evaluation has not yet completed. The report is not necessarily complete at this point."* Three
 * things follow from that sentence, and they shape this page.
 *
 * ## It shows results now, and says what is still coming
 *
 * Grammar, Vocabulary, and Reading are scored at submission (FR-FEEDBACK-001), so they are on screen
 * the moment this page loads — no spinner, no waiting on a model. Writing is not, and the page says
 * so in as many words rather than leaving a blank panel that reads as "nothing to see". A page that
 * looked finished while a section was still missing would misrepresent the report (FR-FEEDBACK-008).
 *
 * ## It polls, but only while there is something to wait for
 *
 * Section 5 fixes the mechanism: poll this page's own endpoint every ~10s *only* while writing
 * evaluation is outstanding, and stop once it settles. A page that polled forever would spend a
 * student's data allowance on an answer that stopped changing; one that never polled would make
 * them reload to see feedback that had already arrived (FR-FEEDBACK-003).
 *
 * ## It never shows Student Problems results
 *
 * The report response carries `problemsTextStatus`, and this page does not render it. FR-PROB-007
 * puts a student-facing Learning Difficulties report out of MVP scope — that data is for internal
 * analysis, and FR-PROB-015 restricts it to staff. The field is in the response because the report
 * describes the submission; not rendering it is a product decision, not an oversight.
 *
 * ## Where the student is sent when this is not their page
 *
 * Both refusals are navigations rather than messages. A `409` means the assessment is still a draft:
 * there is no report to show (PRD Section 13 lists a draft as "not a 'result' state"), and the
 * student belongs back in the assessment — which is also where pressing Back from here should land
 * them, so it `replace`s. A `401` means the session is gone, and identity verification is the only
 * way back in (Section 9).
 */

/** How often to re-read the report while writing evaluation is outstanding (Section 5). */
const POLL_INTERVAL_MS = 10_000;

/**
 * Whether writing evaluation has stopped changing.
 *
 * `succeeded` and `failed_needs_review` are terminal — nothing will move either without a human, and
 * `not_applicable` means there was never anything to evaluate. The other two are the states worth
 * waiting on.
 *
 * `processing` is grouped with `pending` rather than treated as settled: it is a non-terminal state
 * by definition, and the poll exists to catch the transition out of it. Today a submission's
 * `writingStatus` goes `pending → succeeded`, so the two spellings behave identically; stopping the
 * poll on a non-terminal state is the kind of bug that would only appear once it did not.
 */
function isWritingSettled(status: ProcessingStatus): boolean {
  return status === 'succeeded' || status === 'failed_needs_review' || status === 'not_applicable';
}

export function ReportPage() {
  const [report, setReport] = useState<StudentReport | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    getReport()
      .then((loaded) => {
        if (!cancelled) setReport(loaded);
      })
      .catch((error: unknown) => {
        if (cancelled) return;

        if (error instanceof ApiError && (error.status === 401 || error.status === 409)) {
          navigate(error.status === 401 ? '/' : '/assessment', { replace: true });
          return;
        }

        setLoadError(error instanceof ApiError ? error.message : 'Something went wrong');
      });

    return () => {
      // React 18's development StrictMode runs effects twice; without this, a stale response could
      // overwrite a fresh one.
      cancelled = true;
    };
  }, []);

  const writingStatus = report?.writingStatus;

  useEffect(() => {
    if (writingStatus === undefined || isWritingSettled(writingStatus)) return;

    const timer = window.setInterval(() => {
      getReport()
        .then(setReport)
        .catch((error: unknown) => {
          // A poll that fails is not worth interrupting the student for — the report they are
          // reading is still on screen and the next tick retries. A lost session is different: it
          // is not a blip, and continuing to poll would only produce the same 401.
          if (error instanceof ApiError && error.status === 401) navigate('/', { replace: true });
        });
    }, POLL_INTERVAL_MS);

    return () => window.clearInterval(timer);
  }, [writingStatus]);

  if (loadError !== null) {
    return (
      <main className="page">
        <div className="card">
          <h1>We could not load your report</h1>
          <div className="notice" role="alert">
            <p>{loadError}</p>
          </div>
          <p className="hint">Reload this page to try again.</p>
        </div>
      </main>
    );
  }

  if (!report) {
    return (
      <main className="page">
        <div className="card">
          <p className="lede">Loading your report…</p>
        </div>
      </main>
    );
  }

  return <ReportBody report={report} />;
}

/**
 * The report itself, given one.
 *
 * Split from the component above for the same reason `AssessmentWorkspace` is split from
 * `AssessmentPage`: the shell owns "may this student see a report, and which one", and this owns
 * what a report looks like. The shell's two responsibilities are both about *when* — fetch on
 * mount, poll while writing is outstanding — and neither is a rendering concern.
 *
 * The split also makes the rendering checkable without a browser. Everything here is a pure
 * function of the report it is handed, so it can be rendered to markup and read, which is the only
 * kind of frontend verification this repository has (Section 2 pins no DOM testing library, and
 * Section 15's frontend coverage is manual).
 */
export function ReportBody({ report }: { report: StudentReport }) {
  return (
    <main className="page page--wide">
      <div className="card">
        <h1>Your report</h1>
        <p className="lede">
          You have submitted this assessment, so your answers are final and cannot be changed or
          taken again.
          {report.submittedAt !== null && <> Submitted on {formatSubmittedAt(report.submittedAt)}.</>}
        </p>
      </div>

      <WritingPanel status={report.writingStatus} />

      {DETERMINISTIC_SECTION_KEYS.map((section) => (
        <SectionCard key={section} section={report.deterministic[section]} />
      ))}

      <div className="card">
        <p className="hint">
          These results are yours alone, and they are reached by entering your own details. Nobody
          else can open this page.
        </p>
      </div>
    </main>
  );
}

/** An ISO timestamp as a date a student reads, in their own locale and time zone. */
function formatSubmittedAt(iso: string): string {
  const submitted = new Date(iso);

  if (Number.isNaN(submitted.getTime())) return iso;

  return submitted.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

/**
 * Where the Writing evaluation has got to (FR-FEEDBACK-002/003/004/007).
 *
 * Four states, and each says something different, because collapsing them would either promise
 * feedback that has not arrived or imply failure where there is none. The two waiting states use
 * PRD Section 8.1's own wording — "still being prepared".
 *
 * `succeeded` has no results to show yet: T7.3.3 owns adding the criterion scores and written
 * feedback to this panel once E7 produces them. The status is reported honestly in the meantime
 * rather than the panel claiming a report it cannot render.
 */
function WritingPanel({ status }: { status: ProcessingStatus }) {
  const content: Record<ProcessingStatus, { heading: string; body: string; waiting: boolean }> = {
    not_applicable: {
      heading: 'Writing',
      body: 'There is no writing evaluation for this submission.',
      waiting: false,
    },
    pending: {
      heading: 'Writing feedback is still being prepared',
      body:
        'Your written response is being evaluated. This happens in the background and can take a ' +
        'moment. This page updates on its own — you do not need to reload it.',
      waiting: true,
    },
    processing: {
      heading: 'Writing feedback is still being prepared',
      body:
        'Your written response is being evaluated. This happens in the background and can take a ' +
        'moment. This page updates on its own — you do not need to reload it.',
      waiting: true,
    },
    succeeded: {
      heading: 'Your writing feedback is ready',
      body: 'The evaluation of your written response has finished.',
      waiting: false,
    },
    failed_needs_review: {
      heading: 'We could not prepare your writing feedback',
      body:
        'Your written response has been saved exactly as you wrote it. Your Grammar, Vocabulary, ' +
        'and Reading results above are unaffected, and a member of staff can review this.',
      waiting: false,
    },
  };

  const { heading, body, waiting } = content[status];

  return (
    <div className="card">
      <h2>{heading}</h2>
      <p>{body}</p>
      {waiting && (
        <p className="report-status" role="status" aria-live="polite">
          Checking for your feedback…
        </p>
      )}
    </div>
  );
}

/** One deterministic section: its score, and every question with what was answered (FR-DET-003/004). */
function SectionCard({ section }: { section: ReportSection }) {
  return (
    <div className="card">
      <h2>
        {section.title}{' '}
        <span className="score">
          {section.score} / {section.maxScore}
        </span>
      </h2>

      <ol className="question-list">
        {section.questions.map((question) => (
          <ReportQuestionItem key={question.questionId} question={question} />
        ))}
      </ol>
    </div>
  );
}

/**
 * One question and its outcome.
 *
 * The explanation is shown for every question, answered or not — FR-DET-004 asks for it "according
 * to the student's given answer", and the student who left a question blank is the one an
 * explanation helps most. The correct answer is only named when the student did not give it;
 * repeating it back to someone who got it right is noise.
 *
 * "Not answered" is said in words rather than shown as an empty space, which is why the report
 * contract distinguishes a null answer from a blank one.
 */
function ReportQuestionItem({ question }: { question: ReportQuestion }) {
  return (
    <li className="report-question">
      <p className="report-prompt">{question.prompt}</p>

      <p className="report-answer">
        <span className="muted">Your answer: </span>
        {describeAnswer(question.givenAnswer, question.givenAnswerText)}{' '}
        <span className={question.correct ? 'verdict verdict--correct' : 'verdict verdict--wrong'}>
          {question.correct ? 'Correct' : 'Incorrect'}
        </span>
      </p>

      {!question.correct && (
        <p className="report-answer">
          <span className="muted">Correct answer: </span>
          {describeAnswer(question.correctAnswer, question.correctAnswerText)}
        </p>
      )}

      <p className="report-explanation">{question.explanation}</p>
    </li>
  );
}

/**
 * How an answer is written out.
 *
 * The option's text when there is one, the stored value when it names no option — which the autosave
 * schema permits, and which the report must describe rather than hide — and a plain statement when
 * there is no answer at all.
 */
function describeAnswer(value: string | null, text: string | null): string {
  if (value === null) return 'Not answered';

  return text ?? value;
}
