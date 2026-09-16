import type {
  DraftAnswers,
  StudentProblemsFile,
} from '../../../../src/shared/types/draft';

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
 * `dir="auto"` on the field is the mechanism, and it is not decoration. Arabic is right-to-left and
 * English is left-to-right; a fixed `dir` would render one of them backwards, and the browser is
 * the only thing that can tell which it is looking at. `dir="auto"` resolves direction from the
 * first strong character the student types, re-evaluating as they type — so a student who writes in
 * English and then switches to Arabic sees the field follow them. Nothing here detects a language,
 * counts characters, or normalizes the text: what the student typed is what is stored (FR-PROB-009),
 * and the AI's separate interpretation is a later, derived concern (T7.4.1).
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

  function answerStatement(statementId: string, value: number) {
    onChange({ ...answers, likertAnswers: { ...likertAnswers, [statementId]: value } });
  }

  return (
    <>
      {instrument.areas.map((area) => {
        const statements = instrument.statements.filter((statement) => statement.area === area.id);

        // A content area with no statements is a content problem the content schema does not catch;
        // rendering an empty heading would be worse than rendering nothing.
        if (statements.length === 0) return null;

        return (
          <section key={area.id}>
            <h3>{area.label}</h3>

            {statements.map((statement) => (
              <fieldset className="scale-row" key={statement.id}>
                <legend className="scale-statement">{statement.text}</legend>

                <div className="scale-options">
                  {instrument.scale.map((point) => {
                    const inputId = `${statement.id}-${point.value}`;

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
                        <label htmlFor={inputId}>{point.label}</label>
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
        <h3>{instrument.openTextQuestion.privacyNoticeHeading}</h3>
        <p>{instrument.openTextQuestion.privacyNotice}</p>
      </div>

      <div className="field">
        <label htmlFor="problemsOpenText">{instrument.openTextQuestion.prompt}</label>
        <textarea
          id="problemsOpenText"
          name="problemsOpenText"
          value={openText}
          onChange={(event) => onChange({ ...answers, openText: event.target.value })}
          onBlur={() => void onEditingDone()}
          // Follows the student's script rather than assuming one — see the note above.
          dir="auto"
          rows={6}
        />
        <p className="hint">
          You may answer in English or Arabic. This question is optional — you can submit without
          answering it.
        </p>
      </div>
    </>
  );
}
