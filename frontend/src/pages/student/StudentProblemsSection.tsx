import { useState } from 'react';
import type {
  DraftAnswers,
  StudentProblemsFile,
} from '../../../../src/shared/types/draft';
import {
  translateStudentProblems,
  type StudentProblemsLanguage,
} from './studentProblemsTranslations';

/**
 * The Student Problems instrument (PRD Section 9.5, T4.3.4).
 *
 * Three things make up this section, and the order of them is part of the requirement:
 *
 * 1. **The five-point agreement scale**, one response per statement (FR-PROB-002), grouped under
 *    the areas the content defines (FR-PROB-001). Every statement gets its own radio group, so the
 *    browser enforces one response each; a student can change a response but not hold two.
 * 2. **The privacy notice**, shown *ahead of* the open-ended question rather than beside it
 *    (FR-PROB-014, NFR-PRIV-009). Its wording is content, not code — `openTextQuestion` carries
 *    both the heading and the text, because PRD Section 23.1 leaves the exact wording to the team.
 * 3. **The open-ended question**, which accepts English or Arabic.
 *
 * ## Writing in either language
 *
 * `dir="auto"` on the free-text field is the mechanism, and it is not decoration. Arabic is
 * right-to-left and English is left-to-right; a fixed `dir` would render one of them backwards, and
 * the browser is the only thing that can tell which it is looking at. `dir="auto"` resolves
 * direction from the first strong character the student types, re-evaluating as they type — so a
 * student who writes in English and then switches to Arabic sees the field follow them. Nothing here
 * detects a language, counts characters, or normalizes the text: what the student typed is what is
 * stored (FR-PROB-009), and the AI's separate interpretation is a later, derived concern (T7.4.1).
 *
 * ## The EN/AR display toggle
 *
 * This is separate from the field's `dir="auto"` above, and answers a different question: not "which
 * way does what the student typed run", but "which language are the statements themselves shown in".
 * The section defaults to Arabic — the pilot cohort's own language — with a segmented EN/AR control
 * to switch the *display* language for the scale statements, area labels, and instructions. It is a
 * UI-layer translation (`studentProblemsTranslations.ts`) rather than a change to the stored content,
 * since the underlying instrument stays the single English source of truth the content team edits;
 * switching languages relabels the same statement ids, it does not change which statement is being
 * answered, and a student's answers stay keyed by `statement.id` regardless of which language they
 * were reading in when they gave them.
 *
 * ## On the open text being optional
 *
 * It carries no `required` attribute and feeds nothing in the completeness check
 * (`assessmentCompleteness.ts`), because FR-ASSESS-007 and EDGE-007 both say a blank answer here
 * must not block submission. That is not an oversight in the markup; it is the requirement.
 *
 * ## What this section does not show
 *
 * No result, no category, no interpretation — not even its own Likert data summarised back. FR-PROB-007
 * keeps the MVP free of a student-facing difficulties report, and FR-PROB-011 requires AI-derived
 * categories to be labeled as derived, which they are, for staff, in E8.
 */
export function StudentProblemsSection({
  instrument,
  answers,
  onChange,
  onEditingDone,
}: {
  instrument: StudentProblemsFile;
  answers: DraftAnswers['studentProblems'];
  onChange: (next: DraftAnswers['studentProblems']) => void;
  /** Flush the section when the student finishes with the open text (T4.3.3). */
  onEditingDone: () => Promise<void>;
}) {
  const likertAnswers = answers?.likertAnswers ?? {};
  const openText = answers?.openText ?? '';

  // Defaults to Arabic (the pilot cohort's language), switchable per FR — see the class doc above.
  const [language, setLanguage] = useState<StudentProblemsLanguage>('ar');

  /**
   * What a screen reader is told when the display language changes.
   *
   * Switching languages flips the whole section's direction and replaces every statement, area
   * label, and instruction in one render. For anyone reading the page rather than seeing it, that
   * is a large change with no event attached to it: the buttons carry `aria-pressed` so their own
   * state is correct, but nothing says that the text around them has been rewritten. This does.
   *
   * It reports the language now in use rather than the change itself — "shown in Arabic" is the
   * fact someone needs, and it stays true while the section stays in that language.
   */
  const [languageAnnouncement, setLanguageAnnouncement] = useState('');

  function chooseLanguage(next: StudentProblemsLanguage) {
    // Pressing the language already in use should not re-announce it as though something changed.
    if (next === language) return;

    setLanguage(next);
    setLanguageAnnouncement(
      next === 'ar'
        ? 'The statements are now shown in Arabic.'
        : 'The statements are now shown in English.',
    );
  }
  const t = translateStudentProblems(instrument, language);
  const dir = language === 'ar' ? 'rtl' : 'ltr';

  function answerStatement(statementId: string, value: number) {
    onChange({ ...answers, likertAnswers: { ...likertAnswers, [statementId]: value } });
  }

  return (
    <div dir={dir} lang={language}>
      <div className="ai-banner">
        <span className="ai-dot" aria-hidden="true" />
        <div>
          <strong>{language === 'ar' ? 'لا يؤثر على درجتك في الإنجليزية' : 'Not part of your English score'}</strong>
          <p>
            {language === 'ar'
              ? 'تُستخدم إجاباتك هنا لأغراض البحث في المناهج الدراسية فقط. لا تؤثر أبدًا على نتائجك في القواعد أو المفردات أو القراءة أو الكتابة.'
              : 'Your answers here are used for curriculum research only. They never affect your Grammar, Vocabulary, Reading, or Writing results.'}
          </p>
        </div>
      </div>

      <p className="sr-only" role="status" aria-live="polite">
        {languageAnnouncement}
      </p>

      <div className="problems-header">
        <p className="hint" style={{ margin: 0, flex: '1 1 16rem' }}>
          {t.instructions}
        </p>

        <div className="lang-toggle" role="group" aria-label="Section language">
          <button
            type="button"
            aria-pressed={language === 'ar'}
            onClick={() => chooseLanguage('ar')}
          >
            AR
          </button>
          <button
            type="button"
            aria-pressed={language === 'en'}
            onClick={() => chooseLanguage('en')}
          >
            EN
          </button>
        </div>
      </div>

      {instrument.areas.map((area) => {
        const statements = instrument.statements.filter((statement) => statement.area === area.id);

        // A content area with no statements is a content problem the content schema does not catch;
        // rendering an empty heading would be worse than rendering nothing.
        if (statements.length === 0) return null;

        return (
          <section key={area.id}>
            <p className="scale-category">{t.areas[area.id] ?? area.label}</p>

            {statements.map((statement) => (
              <fieldset className="scale-row" key={statement.id}>
                <legend className="scale-statement">
                  {t.statements[statement.id] ?? statement.text}
                </legend>

                {/* One row, deliberately: each option takes an equal share of the row's width (see
                    .scale-options in styles.css) so the five points — including the longest label,
                    "Strongly agree" / "موافق بشدة" — sit on a single line instead of the last one
                    wrapping alone. */}
                <div className="scale-options">
                  {instrument.scale.map((point) => {
                    const inputId = `${statement.id}-${point.value}`;
                    const label = t.scale[point.value] ?? point.label;

                    return (
                      <div className="scale-option" key={point.value}>
                        <input
                          type="radio"
                          id={inputId}
                          // One group per statement: the browser enforces a single response, and a
                          // name shared across statements would collapse them into one answer.
                          name={statement.id}
                          value={point.value}
                          checked={likertAnswers[statement.id] === point.value}
                          onChange={() => answerStatement(statement.id, point.value)}
                        />
                        <label htmlFor={inputId} title={label}>
                          <span>{label}</span>
                        </label>
                      </div>
                    );
                  })}
                </div>
              </fieldset>
            ))}
          </section>
        );
      })}

      {/* FR-PROB-014 / NFR-PRIV-009 — ahead of the field, not beside it. */}
      <div className="notice notice--privacy">
        <h3>{t.openTextQuestion.privacyNoticeHeading}</h3>
        <p>{t.openTextQuestion.privacyNotice}</p>
      </div>

      <div className="field">
        <label htmlFor="problemsOpenText">{t.openTextQuestion.prompt}</label>
        <textarea
          id="problemsOpenText"
          name="problemsOpenText"
          value={openText}
          onChange={(event) => onChange({ ...answers, openText: event.target.value })}
          onBlur={() => void onEditingDone()}
          // Follows what the student actually types rather than the section's display language —
          // see the class doc above for why this is deliberately independent of `language`.
          dir="auto"
          rows={6}
        />
        <p className="hint">{t.openTextQuestion.hint}</p>
      </div>
    </div>
  );
}
