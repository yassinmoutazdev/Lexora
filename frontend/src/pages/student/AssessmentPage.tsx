import { useEffect, useState } from 'react';
import type {
  AssessmentContent,
  ChoiceAnswers,
  DraftAnswers,
  SectionKey,
} from '../../../../src/shared/types/draft';
import { SECTION_KEYS } from '../../../../src/shared/types/draft';
import { ApiError, getDraft, submitAssessment } from '../../api/client';
import { assessCompleteness } from '../../assessmentCompleteness';
import { ChoiceQuestions } from '../../components/ChoiceQuestions';
import { useAutosave } from '../../hooks/useAutosave';
import { navigate } from '../../router';
import { StudentProblemsSection } from './StudentProblemsSection';

/**
 * The assessment — five sections, in order, navigable in both directions (T4.3.2).
 *
 * PRD Section 9.2 fixes what this page may and may not do:
 *
 * - **FR-ASSESS-002/003** — five sections, presented in a fixed order to every student. The order
 *   is `SECTION_KEYS`, and the headings come from the content bundle, so the page holds no copy of
 *   either. Nothing is randomised.
 * - **FR-ASSESS-004** — backward navigation and review are allowed. Every section stays reachable
 *   from every other, and nothing is hidden once answered, because reviewing an answer is the point
 *   of being able to go back to it.
 * - **FR-ASSESS-005** — no time limit. There is no countdown, no deadline, and no elapsed-time
 *   measurement anywhere on this page; it is an absence, and the way it stays absent is that
 *   nothing here has a clock.
 *
 * ## Two components, and why
 *
 * `AssessmentPage` gets the draft and decides where the student belongs; `AssessmentWorkspace`
 * renders it and owns the answers. The split is not stylistic — it is what makes autosave correct.
 * `useAutosave` seeds itself from the answers it is first handed and treats any later difference as
 * an edit, so a hook mounted *before* the draft arrives would see the loaded answers as a change
 * and save them straight back. Mounting the workspace only once there is a draft to work on means
 * the hook's first sight of the answers is the loaded ones.
 *
 * ## On the two ways of not belonging here
 *
 * A student whose work is already in belongs on their report, not back in the assessment
 * (FR-STU-006) — but they can arrive by pressing Back, or from a bookmarked link. The server
 * reports `status: 'submitted'` on load and this page forwards them, `replace`-ing so that Back
 * does not bounce them here again. A student with no session is refused by the API and belongs at
 * the entry page, which is where they are sent.
 */
export function AssessmentPage() {
  const [draft, setDraft] = useState<{ content: AssessmentContent; answers: DraftAnswers } | null>(
    null,
  );
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    getDraft()
      .then((loaded) => {
        if (cancelled) return;

        if (loaded.status === 'submitted') {
          navigate('/report', { replace: true });
          return;
        }

        setDraft({ content: loaded.content, answers: loaded.answers });
      })
      .catch((error: unknown) => {
        if (cancelled) return;

        if (error instanceof ApiError && error.status === 401) {
          // No session: 30 minutes idle, or a cookie that no longer verifies. Identity verification
          // is the only way back in (Section 9), so that is where they go.
          navigate('/', { replace: true });
          return;
        }

        setLoadError(error instanceof ApiError ? error.message : 'Something went wrong');
      });

    return () => {
      // React 18's development StrictMode runs effects twice; without this, a stale response could
      // overwrite a fresh one, or a redirect could fire from a request nobody is waiting on.
      cancelled = true;
    };
  }, []);

  if (loadError !== null) {
    return (
      <main className="page">
        <div className="card">
          <h1>We could not load your assessment</h1>
          <div className="notice" role="alert">
            <p>{loadError}</p>
          </div>
          <p className="hint">
            Your saved answers are not lost. Reload this page to try again, or enter your details
            again from the start.
          </p>
        </div>
      </main>
    );
  }

  if (!draft) {
    return (
      <main className="page">
        <div className="card">
          <p className="lede">Loading your assessment…</p>
        </div>
      </main>
    );
  }

  return <AssessmentWorkspace content={draft.content} loadedAnswers={draft.answers} />;
}

/** The loaded assessment: navigation, the section on screen, its save status, and its answers. */
function AssessmentWorkspace({
  content,
  loadedAnswers,
}: {
  content: AssessmentContent;
  loadedAnswers: DraftAnswers;
}) {
  const [answers, setAnswers] = useState<DraftAnswers>(loadedAnswers);
  const [activeSection, setActiveSection] = useState<SectionKey>('grammar');

  // One hook, scoped to the section on screen. Moving sections flushes the one being left before
  // this hook is handed the next section's answers (see `useAutosave`).
  const { status, flush } = useAutosave(activeSection, answers[activeSection]);

  const position = SECTION_KEYS.indexOf(activeSection);

  /** Records one choice answer under its section, leaving every other section untouched. */
  function answerChoice(
    section: 'grammar' | 'vocabulary' | 'reading',
    questionId: string,
    optionId: string,
  ) {
    setAnswers((current) => {
      const sectionAnswers: ChoiceAnswers = { ...current[section], [questionId]: optionId };
      return { ...current, [section]: sectionAnswers };
    });
  }

  function updateWriting(essayText: string) {
    setAnswers((current) => ({ ...current, writing: { ...current.writing, essayText } }));
  }

  function updateStudentProblems(next: DraftAnswers['studentProblems']) {
    setAnswers((current) => ({ ...current, studentProblems: next }));
  }

  return (
    <main className="page page--wide">
      <div className="card">
        <h1>English assessment</h1>
        <p className="lede">
          There is no time limit. You can move between sections as often as you like, and your
          answers are saved as you go.
        </p>

        <nav aria-label="Assessment sections">
          <ul className="section-nav">
            {SECTION_KEYS.map((section) => (
              <li key={section}>
                <button
                  type="button"
                  aria-current={section === activeSection ? 'true' : undefined}
                  onClick={() => setActiveSection(section)}
                >
                  {/* The label is the content's own title, so navigation cannot name a section
                      differently from the section it opens. */}
                  {content[section].title}
                </button>
              </li>
            ))}
          </ul>
        </nav>
      </div>

      <div className="card">
        <h2>{content[activeSection].title}</h2>
        <p className="hint">{content[activeSection].instructions}</p>

        <SectionBody
          section={activeSection}
          content={content}
          answers={answers}
          onAnswerChoice={answerChoice}
          onUpdateWriting={updateWriting}
          onUpdateStudentProblems={updateStudentProblems}
          onEditingDone={flush}
        />
      </div>

      <div className="button-row">
        <button
          type="button"
          className="secondary"
          onClick={() => setActiveSection(neighbourSection(activeSection, -1))}
          disabled={position === 0}
        >
          Previous section
        </button>
        <button
          type="button"
          className="secondary"
          onClick={() => setActiveSection(neighbourSection(activeSection, 1))}
          disabled={position === SECTION_KEYS.length - 1}
        >
          Next section
        </button>
      </div>

      <p className="progress">
        Section {position + 1} of {SECTION_KEYS.length}
      </p>

      <SaveStatus status={status} />

      <SubmitControl content={content} answers={answers} onEditingDone={flush} />
    </main>
  );
}

/**
 * Submit, and the reason it is disabled when it is (FR-ASSESS-007).
 *
 * A disabled button with no explanation is the worst version of this control: the student can see
 * they cannot proceed but not what is missing. So the sections still unfinished are listed by name,
 * from `assessCompleteness`, which is the same call that disables the button — the two cannot
 * disagree.
 *
 * ## Why it flushes before submitting
 *
 * The debounce means the last thing the student typed may still be sitting in this tab. Submitting
 * without flushing it would finalize the submission from the last *saved* state, and the server
 * would then score answers missing their final sentence — and the submission is immutable, so there
 * would be no way to put it right. The flush is awaited for exactly that reason.
 *
 * ## Why the refusal is shown rather than worked around
 *
 * Completeness is checked server-side inside `finalize()` (T5.2.1) and the browser is not trusted
 * (Section 12). If the server refuses, this control says so and leaves the student where they can
 * fix it — it does not retry, override, or assume the client's own check was right.
 */
function SubmitControl({
  content,
  answers,
  onEditingDone,
}: {
  content: AssessmentContent;
  answers: DraftAnswers;
  onEditingDone: () => Promise<void>;
}) {
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const completeness = assessCompleteness(content, answers);
  const titles = Object.fromEntries(
    SECTION_KEYS.map((section) => [section, content[section].title]),
  ) as Record<SectionKey, string>;

  async function handleSubmit() {
    setSubmitting(true);
    setSubmitError(null);

    try {
      await onEditingDone();
      await submitAssessment();
      // `replace`: the assessment is finished, and stepping back into it would only bounce the
      // student forward again (Section 9 — a submitted student belongs on their report).
      navigate('/report', { replace: true });
    } catch (error) {
      setSubmitError(error instanceof ApiError ? error.message : 'Something went wrong');
      setSubmitting(false);
    }
  }

  return (
    <div className="card">
      <h2>Submit your assessment</h2>

      {completeness.complete ? (
        <p>
          Every section is answered. Once you submit, your answers become final — you will not be
          able to change them or take the assessment again.
        </p>
      ) : (
        <>
          <p>Finish these sections before you submit:</p>
          <ul className="incomplete-sections">
            {completeness.incompleteSections.map((section) => (
              <li key={section}>{titles[section]}</li>
            ))}
          </ul>
        </>
      )}

      {submitError !== null && (
        <div className="notice" role="alert">
          <p>{submitError}</p>
        </div>
      )}

      <div className="button-row">
        <button type="button" onClick={handleSubmit} disabled={!completeness.complete || submitting}>
          {submitting ? 'Submitting…' : 'Submit assessment'}
        </button>
      </div>
    </div>
  );
}

/** The section `offset` places away, clamped to the ends so a stray click cannot run off the list. */
function neighbourSection(section: SectionKey, offset: number): SectionKey {
  const target = SECTION_KEYS.indexOf(section) + offset;

  return SECTION_KEYS[Math.min(Math.max(target, 0), SECTION_KEYS.length - 1)] ?? section;
}

/**
 * What the student is told about saving.
 *
 * A live region, because the whole point of the indicator is that it changes without them doing
 * anything — a screen reader that only read it on focus would never read it at all. The wording
 * deliberately says "saved" rather than "all answers saved": it reports the last request the server
 * accepted, which is the section they were just in, not a claim about the whole assessment.
 */
function SaveStatus({ status }: { status: ReturnType<typeof useAutosave>['status'] }) {
  const message = {
    idle: '',
    saving: 'Saving…',
    saved: 'Saved',
    error: 'We could not save your last changes — check your connection. Your earlier answers are safe.',
  }[status];

  const modifier = status === 'error' ? ' save-status--error' : status === 'saved' ? ' save-status--saved' : '';

  return (
    <p className={`save-status${modifier}`} role="status" aria-live="polite">
      {message}
    </p>
  );
}

/**
 * The body of the section the student is looking at.
 *
 * Split out so the workspace above reads as navigation and state, and each section's rendering sits
 * together. Only the active section is mounted: a section that is not on screen has nothing to
 * render, and its answers live in the workspace either way.
 */
function SectionBody({
  section,
  content,
  answers,
  onAnswerChoice,
  onUpdateWriting,
  onUpdateStudentProblems,
  onEditingDone,
}: {
  section: SectionKey;
  content: AssessmentContent;
  answers: DraftAnswers;
  onAnswerChoice: (
    section: 'grammar' | 'vocabulary' | 'reading',
    questionId: string,
    optionId: string,
  ) => void;
  onUpdateWriting: (essayText: string) => void;
  onUpdateStudentProblems: (next: DraftAnswers['studentProblems']) => void;
  /** Flush the section being left, for the places where waiting out the debounce is wrong. */
  onEditingDone: () => Promise<void>;
}) {
  switch (section) {
    case 'grammar':
    case 'vocabulary':
      return (
        <ChoiceQuestions
          questions={content[section].questions}
          answers={answers[section] ?? {}}
          namePrefix={section}
          onAnswer={(questionId, optionId) => onAnswerChoice(section, questionId, optionId)}
        />
      );

    case 'reading':
      return (
        <>
          {content.reading.passages.map((passage) => (
            <section key={passage.id}>
              <div className="passage">
                <h3>{passage.title}</h3>
                {passage.text}
              </div>
              <ChoiceQuestions
                questions={passage.questions}
                answers={answers.reading ?? {}}
                // Passage-scoped, so two passages may reuse a question id without their radio
                // groups quietly becoming one.
                namePrefix={`reading-${passage.id}`}
                onAnswer={(questionId, optionId) => onAnswerChoice('reading', questionId, optionId)}
              />
            </section>
          ))}
        </>
      );

    case 'writing':
      return (
        <>
          <div className="writing-task">
            <h3>{content.writing.task.genre}</h3>
            <p className="prompt">{content.writing.task.prompt}</p>
            <p className="hint">{content.writing.task.guidance}</p>
          </div>

          <div className="field">
            <label htmlFor="essayText">Your response</label>
            <textarea
              id="essayText"
              name="essayText"
              value={answers.writing?.essayText ?? ''}
              onChange={(event) => onUpdateWriting(event.target.value)}
              onBlur={() => void onEditingDone()}
              spellCheck={false}
            />
          </div>
        </>
      );

    case 'studentProblems':
      return (
        <StudentProblemsSection
          instrument={content.studentProblems}
          answers={answers.studentProblems}
          onChange={onUpdateStudentProblems}
          onEditingDone={onEditingDone}
        />
      );
  }
}
