import type { AssessmentContent, DraftAnswers, SectionKey } from '../../src/shared/types/draft';
import { SECTION_KEYS } from '../../src/shared/types/draft';

/**
 * Whether the assessment has enough in it to be submitted (FR-ASSESS-007).
 *
 * ## This is an advisory gate, not the rule
 *
 * The authoritative completeness check is server-side, inside `SubmissionService.finalize()`
 * (T5.2.1) — Section 12 makes the browser untrusted, and this page is the browser. What this module
 * does is decide whether to *enable a button*, so that a student is told which sections are still
 * unfinished instead of submitting into a refusal. If the two ever disagree, the server is right,
 * and the submit control below surfaces its error rather than trying to reconcile them.
 *
 * ## What "complete" means
 *
 * A required section is complete when every question in it has an answer:
 *
 * - **Grammar, Vocabulary, Reading** — every question carries a chosen option. Reading's questions
 *   are counted across all its passages, which is why they are flattened rather than iterated per
 *   passage.
 * - **Writing** — the free-writing response has something in it. Whitespace is not something:
 *   "   " would otherwise satisfy a check whose purpose is that the student wrote.
 * - **Student Problems** — every *statement* has a scale response. The open-ended answer is
 *   deliberately **not** consulted: FR-ASSESS-007 carves it out as optional, and EDGE-007 states
 *   plainly that leaving it blank "must not block final submission on this field". A student may
 *   therefore submit with the free text empty while having answered the statements.
 *
 * ## The one inference here, stated so it can be corrected
 *
 * That the Student Problems *statements* are required is read from FR-ASSESS-007 — "all required
 * sections must be completed... the open-ended Student Problems response may remain optional" —
 * which names only the open-ended response as optional, and from
 * `student-problems-statements.json` marking `openTextQuestion.required: false` and nothing else.
 * The PRD does not state the statements' requiredness in so many words, so if the team intends the
 * whole instrument to be optional, this is the single line to change.
 */

/** The sections a student must finish, in the order they are presented. */
export type CompletenessReport = {
  complete: boolean;
  /** The sections still unfinished, in presentation order — what the student is told to go back to. */
  incompleteSections: SectionKey[];
};

/** Whether a stored answer for a question id is a real choice rather than a missing or blank one. */
function isAnswered(answers: Record<string, unknown> | undefined, questionId: string): boolean {
  const value = answers?.[questionId];

  return typeof value === 'string' && value.length > 0;
}

/** Every question in the section, across passages for Reading. */
function sectionQuestions(
  content: AssessmentContent,
  section: 'grammar' | 'vocabulary' | 'reading',
): { id: string }[] {
  if (section === 'reading') {
    return content.reading.passages.flatMap((passage) => passage.questions);
  }

  return content[section].questions;
}

function isSectionComplete(
  section: SectionKey,
  content: AssessmentContent,
  answers: DraftAnswers,
): boolean {
  switch (section) {
    case 'grammar':
    case 'vocabulary':
    case 'reading': {
      const chosen = answers[section] as Record<string, unknown> | undefined;
      return sectionQuestions(content, section).every((question) => isAnswered(chosen, question.id));
    }

    case 'writing':
      return (answers.writing?.essayText ?? '').trim().length > 0;

    case 'studentProblems': {
      const scale = answers.studentProblems?.likertAnswers;
      return content.studentProblems.statements.every((statement) => {
        const value = scale?.[statement.id];
        // The five-point scale itself is validated at the API boundary (T4.2.2); this only checks
        // that a response exists, so a value outside the scale would be a validation failure the
        // student sees rather than a silently "complete" section.
        return typeof value === 'number';
      });
    }
  }
}

export function assessCompleteness(
  content: AssessmentContent,
  answers: DraftAnswers,
): CompletenessReport {
  const incompleteSections = SECTION_KEYS.filter(
    (section) => !isSectionComplete(section, content, answers),
  );

  return { complete: incompleteSections.length === 0, incompleteSections };
}
