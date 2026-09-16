import { useEffect, useState } from 'react';
import type {
  ReportQuestion,
  ReportSection,
  ReportWriting,
  ReportWritingCriterion,
  StudentReport,
} from '../../../../src/shared/types/draft';
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

      <WritingPanel status={report.writingStatus} writing={report.writing} />

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
 * The Writing section of the report (FR-FEEDBACK-002/003/004/007, FR-WRITE-006/007).
 *
 * ## Why the results are keyed off the feedback and not off the status
 *
 * Every other state here is a statement about the *status*, but the finished one is a statement
 * about the *feedback*: "your feedback is ready" is only true if the response actually carries
 * feedback to render. Keying that heading off `status === 'succeeded'` would let the page announce
 * results it does not have — the one thing FR-FEEDBACK-008 forbids — so the results branch is
 * chosen by `writing !== null`, and a `succeeded` status with nothing to show falls through to the
 * same honest "we could not prepare this" copy as a failure. That combination is not produced by any
 * code path (the API returns feedback whenever it reports `succeeded`); this is the page refusing to
 * claim more than it was handed, not a state anyone should expect to see.
 *
 * ## The four statuses still need their own words
 *
 * A student whose evaluation is still running must not read failure, and one whose evaluation has
 * given up must not be left on an indefinite "in progress" (FR-FEEDBACK-007). The two waiting states
 * use PRD Section 8.1's own wording — "still being prepared".
 */
function WritingPanel({
  status,
  writing,
}: {
  status: ProcessingStatus;
  writing: ReportWriting | null;
}) {
  if (writing !== null) return <WritingResults writing={writing} />;

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
    succeeded: FAILED_WRITING,
    failed_needs_review: FAILED_WRITING,
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

/**
 * What a student is told when there is no feedback to show them (FR-WRITE-011, FR-FEEDBACK-007).
 *
 * The first sentence is the one that matters: the response is not lost, and a student who has just
 * been told to wait does not need to fear that it was. The rest says what *is* still true — the
 * deterministic results on this same page are unaffected (FR-FEEDBACK-007) — and that a person will
 * look at it, which is what `failed_needs_review` means.
 */
const FAILED_WRITING = {
  heading: 'We could not prepare your writing feedback',
  body:
    'Your written response has been saved exactly as you wrote it. Your Grammar, Vocabulary, ' +
    'and Reading results above are unaffected, and a member of staff can review this.',
  waiting: false,
} as const;

/**
 * A finished writing evaluation (FR-WRITE-005/006/007).
 *
 * ## Why the overall score is shown beside the criteria rather than instead of them
 *
 * The overall is a weighted summary of the five criterion scores, so showing it alone would hide the
 * only thing a student can act on: which aspects of their writing were strong and which were not.
 * The rubric's weights are deliberately not shown — they are provisional (PRD Section 23.1 item 1)
 * and a student reading "20%" would reasonably take it as an approved decision.
 *
 * ## Why every list is rendered even when it is empty
 *
 * The model is asked for four lists and may legitimately return an empty one — a response with no
 * high-value corrections, say. Rendering a heading with nothing under it reads as a page that failed
 * to load; skipping the heading entirely would make the report's shape depend on the model's mood,
 * and a student comparing two reports would have no way to tell an empty list from a missing one.
 * Saying "None" is the honest third option.
 */
function WritingResults({ writing }: { writing: ReportWriting }) {
  return (
    <div className="card">
      <h2>
        Your writing feedback{' '}
        <span className="score">
          {writing.overallScore} / 100
        </span>
      </h2>

      <ul className="criterion-list">
        {writing.criteria.map((criterion) => (
          <CriterionItem key={criterion.key} criterion={criterion} />
        ))}
      </ul>

      <ReportList title="What you did well" items={writing.strengths} />
      <ReportList title="What to work on" items={writing.weaknesses} />
      <CorrectionList corrections={writing.corrections} />
      <ReportList title="Suggestions" items={writing.suggestions} />
    </div>
  );
}

/** One criterion: its rubric label, its score, and the model's evidence for it (FR-WRITE-005). */
function CriterionItem({ criterion }: { criterion: ReportWritingCriterion }) {
  return (
    <li className="criterion">
      <p className="criterion-head">
        <span className="criterion-label">{criterion.label}</span>{' '}
        <span className="score">{criterion.score} / 100</span>
      </p>
      <p className="report-explanation">{criterion.rationale}</p>
    </li>
  );
}

/** One of the four titled lists in the feedback (FR-WRITE-007). */
function ReportList({ title, items }: { title: string; items: string[] }) {
  return (
    <div className="feedback-block">
      <h3>{title}</h3>
      {items.length === 0 ? (
        <p className="muted">None.</p>
      ) : (
        <ul>
          {/*
            Keyed by position, not by text. The model is asked for a list of sentences and may
            legitimately return the same one twice; two identical strings would collide as keys.
            The list arrives whole with each report and is never reordered in place, so position
            is a stable identity here.
          */}
          {items.map((item, index) => (
            <li key={`${index}:${item}`}>{item}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * The corrections, shown as what was written beside what it should be (FR-WRITE-007/008).
 *
 * The explanation is a third line rather than a third column: it is a sentence, not a value, and
 * three columns of prose on a phone is a layout nobody reads. Nothing here is a diff — the model
 * returns whole phrases, not character ranges, so the two texts are shown as the two texts.
 */
function CorrectionList({ corrections }: { corrections: ReportWriting['corrections'] }) {
  return (
    <div className="feedback-block">
      <h3>Corrections</h3>
      {corrections.length === 0 ? (
        <p className="muted">None.</p>
      ) : (
        <ul className="correction-list">
          {/* Keyed by position for the reason the lists above give: the same phrase can be corrected twice. */}
          {corrections.map((correction, index) => (
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
