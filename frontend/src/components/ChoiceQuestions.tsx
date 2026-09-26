import type { ChoiceAnswers, Question } from '../../../src/shared/types/draft';

/**
 * A list of choice questions, as radio groups (T4.3.2).
 *
 * Shared by Grammar, Vocabulary, and Reading — the three sections whose questions all have the same
 * shape (a prompt and a set of options) even though Reading groups them under passages. Rendering
 * them once means a change to how a question looks happens in one place rather than three.
 *
 * ## Why radios, and why the group name matters
 *
 * A radio group is the accessible spelling of "choose one of these": arrow keys move between the
 * options, and the browser enforces that only one is selected. That enforcement is by `name`, which
 * must therefore be unique per question *across the whole document* — two questions sharing a name
 * would silently behave as one. `namePrefix` carries the section so the same question id cannot
 * collide with itself in another section.
 *
 * An unanswered question is simply not selected; there is no "none" option, and no question is
 * required at the point of answering. Whether the section is complete enough to submit is a
 * question about the whole section, asked once, in the submit control.
 */
export function ChoiceQuestions({
  questions,
  answers,
  namePrefix,
  onAnswer,
}: {
  questions: Question[];
  /** This section's saved answers, keyed by question id. */
  answers: ChoiceAnswers;
  /** Distinguishes this section's radio groups from every other section's. */
  namePrefix: string;
  onAnswer: (questionId: string, optionId: string) => void;
}) {
  const answeredCount = questions.filter((question) => answers[question.id] != null).length;

  return (
    <>
      {/*
        How many of this section's questions are answered so far, filled in the section's own
        accent hue (set as `--section-hue` on an ancestor by `AssessmentPage`; falls back to
        `--accent` for anything that doesn't set it — see .card-edge in styles.css).
      */}
      <div className="section-progress" aria-hidden="true">
        <div className="section-progress-track">
          <div
            className="section-progress-fill"
            style={{ width: `${questions.length === 0 ? 0 : (answeredCount / questions.length) * 100}%` }}
          />
        </div>
        <span className="section-progress-count">
          {answeredCount} of {questions.length}
        </span>
      </div>

      <ol className="question-list">
        {questions.map((question, index) => (
          <li key={question.id}>
            <fieldset className="answer">
              <legend className="prompt">
                <span className="question-number">Question {index + 1}</span>
                {question.prompt}
              </legend>

              <div className="options">
                {(question.options ?? []).map((option) => {
                  const inputId = `${namePrefix}-${question.id}-${option.id}`;

                  return (
                    <div className="option" key={option.id}>
                      <input
                        type="radio"
                        id={inputId}
                        name={`${namePrefix}-${question.id}`}
                        value={option.id}
                        checked={answers[question.id] === option.id}
                        onChange={() => onAnswer(question.id, option.id)}
                      />
                      <label htmlFor={inputId}>{option.text}</label>
                    </div>
                  );
                })}
              </div>
            </fieldset>
          </li>
        ))}
      </ol>
    </>
  );
}
