import { useEffect, useRef, useState } from 'react';
import type {
  AssessmentContent,
  ChoiceAnswers,
  DraftAnswers,
} from '../../../../src/shared/types/draft';
import { SECTION_KEYS, type SectionKey } from '../../../../src/shared/types/sections';
import { ApiError, getDraft, submitAssessment } from '../../api/client';
import { assessCompleteness } from '../../assessmentCompleteness';
import { ChoiceQuestions } from '../../components/ChoiceQuestions';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { SkeletonCard, SkeletonLines, SkeletonStatus } from '../../components/Skeleton';
import { ThemeToggle } from '../../components/ThemeToggle';
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
      <main className="page page--toggle">
        <ThemeToggle variant="floating" />
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

  // The shape of the assessment rather than a sentence about it: the navigation row and a tall
  // card, so the questions land where the placeholder was. See `components/Skeleton.tsx`.
  if (!draft) {
    return (
      <main className="page page--wide page--toggle">
        <ThemeToggle variant="floating" />
        <SkeletonStatus label="Loading your assessment" />

        <div className="card">
          <SkeletonLines count={2} />
          <div className="skeleton-chips" aria-hidden="true">
            {[0, 1, 2, 3, 4].map((index) => (
              <span key={index} className="skeleton-chip" />
            ))}
          </div>
        </div>

        <SkeletonCard lines={6} />
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

  /**
   * Which sections are finished, from the same call that gates the submit button.
   *
   * One source for both, so the tick beside a section's name and the reason Submit is disabled
   * cannot disagree — a navigation that marked Vocabulary done while the submit panel listed it as
   * unfinished would leave the student with two answers and no way to tell which was right.
   */
  const completeness = assessCompleteness(content, answers);
  const finishedSections = new Set(
    SECTION_KEYS.filter((section) => !completeness.incompleteSections.includes(section)),
  );

  /** The heading of the section on screen, which a section change moves the reader to. */
  const sectionHeading = useRef<HTMLHeadingElement>(null);

  /**
   * Moving between sections is a change of place, so the reader is moved with it.
   *
   * Switching sections replaces the card's contents without changing the route, so none of the
   * route-level handling applies. On a long section — Reading renders every passage and every
   * question in one card — a student who scrolls to the bottom and then chooses "Grammar" used to
   * land at the same offset inside a much shorter section, looking at the middle of a question.
   *
   * Focus moves as well as the scroll, because the two are one action for anyone using a keyboard:
   * the heading is where the new section begins, and it is what a screen reader should read next.
   *
   * Skipped on the first render: arriving at the assessment already scrolls and focuses via
   * `useRouteAnnouncement`, and doing it again here would fight it.
   *
   * The reduced-motion preference is read here rather than left to CSS, because `scrollIntoView`'s
   * `behavior` option overrides the `scroll-behavior` property outright — a stylesheet cannot
   * soften a scroll that JavaScript asked to be smooth.
   */
  const hasRendered = useRef(false);

  useEffect(() => {
    if (!hasRendered.current) {
      hasRendered.current = true;
      return;
    }

    const heading = sectionHeading.current;
    if (heading === null) return;

    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    heading.focus({ preventScroll: true });
    heading.scrollIntoView({ block: 'start', behavior: reduced ? 'auto' : 'smooth' });
  }, [activeSection]);

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

  const isLastSection = position === SECTION_KEYS.length - 1;

  return (
    <main className="page page--wide page--toggle">
      <ThemeToggle variant="floating" />
      <div className="card">
        <h1>English assessment</h1>
        <p className="lede">
          There is no time limit. You can move between sections as often as you like, and your
          answers are saved as you go.
        </p>

        <nav aria-label="Assessment sections">
          <ul className="section-nav">
            {SECTION_KEYS.map((section) => {
              const finished = finishedSections.has(section);

              return (
                <li key={section}>
                  <button
                    type="button"
                    aria-current={section === activeSection ? 'true' : undefined}
                    /*
                      The tick is a mark, not a word, so the state travels in the button's name
                      instead. Without this a screen reader hears five section titles and no
                      indication of which are done — the one thing this navigation now says.
                    */
                    aria-label={`${content[section].title} — ${finished ? 'finished' : 'not finished yet'}`}
                    onClick={() => setActiveSection(section)}
                  >
                    {/* The label is the content's own title, so navigation cannot name a section
                        differently from the section it opens. */}
                    {content[section].title}
                    {finished && (
                      <span className="tick" aria-hidden="true">
                        ✓
                      </span>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        </nav>
      </div>

      <div className="card">
        {/* A focus target for section changes, not a control — `tabIndex={-1}` keeps it out of the
            tab order while letting the effect above move focus here. */}
        <h2 ref={sectionHeading} tabIndex={-1}>
          {content[activeSection].title}
        </h2>
        <p className="hint">{content[activeSection].instructions}</p>

        {/*
          Keyed on the section, so changing sections remounts this subtree and its entrance
          animation fires. Without the key React reconciles what it can and the only visible change
          would be the content itself — which is exactly the abrupt swap the transition exists to
          remove. Remounting costs nothing here: every answer is controlled from `answers` above, so
          nothing is lost, and the autosave hook lives in the workspace rather than in here.
        */}
        <div className="section-body" key={activeSection}>
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

        <div className="button-row" style={{ marginTop: '1.5rem' }}>
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
            disabled={isLastSection}
          >
            Next section
          </button>
        </div>

        {/*
          Where the student is, and how much is left — on every section, not only the last one.

          The count used to be the whole line, which answered "how far through am I" but not "am I
          finished", and the second question was only answerable by reaching section five and
          reading the submit panel. Both facts now sit together, because they are the same question
          asked twice.
        */}
        <p className="progress">
          Section {position + 1} of {SECTION_KEYS.length} · {finishedSections.size} of{' '}
          {SECTION_KEYS.length} sections finished
        </p>

        <SaveStatus status={status} />

        {/*
          The submit control has no purpose being visible mid-assessment — a student on Grammar has
          nothing to submit yet and the list of unfinished sections is just noise this early. It
          appears only once the student has reached the last section, where "am I ready to submit"
          is actually the question on screen.
        */}
        {isLastSection && (
          <SubmitControl content={content} answers={answers} onEditingDone={flush} />
        )}
      </div>
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
 * ## Why it flushes before asking, and not after
 *
 * The debounce means the last thing the student typed may still be sitting in this tab. Submitting
 * without flushing it would finalize the submission from the last *saved* state, and the server
 * would then score answers missing their final sentence — and the submission is immutable, so there
 * would be no way to put it right. So the flush is awaited, and it is awaited **before the
 * confirmation opens** rather than after it: a dialog that described one set of answers while a
 * different set was on its way would be worse than no dialog at all.
 *
 * ## Why there is a confirmation at all
 *
 * `FR-ASSESS-008` makes the submission final and `FR-STU-007` forbids a retake, so this is the one
 * irreversibly destructive action in the product and it used to take a single click. The dialog
 * states the consequence in the same words the panel above it already used — that part was never
 * the problem — and adds the step that makes it a decision rather than a slip.
 *
 * ## Why the refusal is shown rather than worked around
 *
 * Completeness is checked server-side inside `finalize()` (T5.2.1) and the browser is not trusted
 * (Section 12). If the server refuses, this control says so and leaves the student where they can
 * fix it — it does not retry, override, or assume the client's own check was right.
 *
 * When the server refuses for incompleteness it names the sections it thinks are unfinished, and
 * those are rendered below its message. That list normally agrees with the client's own gate; when
 * it does not, the student is looking at the one case where this page's model was wrong, and the
 * server's answer is the one that will let them submit.
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
  /**
   * The two-step submit, as one value rather than two booleans.
   *
   * `preparing` (flushing the pending autosave) and `submitting` (the request is away) look similar
   * but are different promises to the reader — one is "we are making sure nothing is left out", the
   * other is "this is happening now" — and modelling them as `busy` plus `submitting` would allow
   * the impossible combination of both.
   */
  const [phase, setPhase] = useState<'idle' | 'preparing' | 'confirming' | 'submitting'>('idle');
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [refusedSections, setRefusedSections] = useState<SectionKey[]>([]);

  const completeness = assessCompleteness(content, answers);
  const titles = Object.fromEntries(
    SECTION_KEYS.map((section) => [section, content[section].title]),
  ) as Record<SectionKey, string>;

  /** Save whatever is still pending, then open the confirmation. */
  async function prepareSubmit() {
    setPhase('preparing');
    setSubmitError(null);
    setRefusedSections([]);

    try {
      await onEditingDone();
      setPhase('confirming');
    } catch {
      // Submitting now would leave the last edit out of a submission that can never be amended, so
      // the action stops here rather than proceeding on a partial save.
      setSubmitError(
        'We could not save your last changes, so submitting now would leave them out. Check your ' +
          'connection and try again — your earlier answers are safe.',
      );
      setPhase('idle');
    }
  }

  async function confirmSubmit() {
    setPhase('submitting');
    setSubmitError(null);

    try {
      await submitAssessment();
      // `replace`: the assessment is finished, and stepping back into it would only bounce the
      // student forward again (Section 9 — a submitted student belongs on their report).
      navigate('/report', { replace: true });
    } catch (error) {
      setSubmitError(error instanceof ApiError ? error.message : 'Something went wrong');
      setRefusedSections(error instanceof ApiError ? incompleteSectionsFrom(error) : []);
      setPhase('idle');
    }
  }

  return (
    <div className="submit-panel">
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
          {refusedSections.length > 0 && (
            <ul className="incomplete-sections">
              {refusedSections.map((section) => (
                <li key={section}>{titles[section] ?? section}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      <div className="button-row">
        <button
          type="button"
          onClick={() => void prepareSubmit()}
          disabled={!completeness.complete || phase !== 'idle'}
          aria-busy={phase === 'preparing'}
        >
          {phase === 'preparing' ? 'Saving your last changes…' : 'Submit assessment'}
        </button>
      </div>

      <ConfirmDialog
        open={phase === 'confirming' || phase === 'submitting'}
        title="Submit your assessment?"
        confirmLabel="Submit final answers"
        busyLabel="Submitting…"
        busy={phase === 'submitting'}
        onConfirm={() => void confirmSubmit()}
        onCancel={() => setPhase('idle')}
      >
        <p>
          Once you submit, your answers become final. You will not be able to change them, and you
          will not be able to take the assessment again.
        </p>
        <p>
          Your Grammar, Vocabulary, and Reading results appear straight away. Your writing feedback
          is prepared in the background and appears on the same report when it is ready.
        </p>
      </ConfirmDialog>
    </div>
  );
}

/**
 * The section keys the server named when it refused a submit for incompleteness.
 *
 * Read defensively, because `body` is whatever the response parsed to — for a refusal from a proxy
 * or an unexpected path that is not the shape Section 11 describes, and an unguarded cast would
 * turn a malformed body into a crash inside the catch block that exists to prevent one. Anything
 * that is not a list of section keys this client recognises is reported as "the server did not
 * say", and the message alone is shown — which is what this page did before the field was read.
 */
function incompleteSectionsFrom(error: ApiError): SectionKey[] {
  const { body } = error;
  if (typeof body !== 'object' || body === null) return [];

  const { incompleteSections } = body as { incompleteSections?: unknown };
  if (!Array.isArray(incompleteSections)) return [];

  return incompleteSections.filter((section): section is SectionKey =>
    SECTION_KEYS.includes(section as SectionKey),
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
