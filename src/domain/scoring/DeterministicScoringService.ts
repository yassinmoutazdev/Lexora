import type {
  DeterministicSectionFile,
  Question,
  ReadingFile,
} from '../../content/contentSchemas.ts';
import type { ChoiceAnswers, DraftAnswers } from '../../shared/types/draft.ts';
import type { DeterministicSectionKey } from '../../shared/types/sections.ts';

/**
 * Scoring for Grammar, Vocabulary, and Reading (ARCHITECTURE Section 7, Section 18 — canonical
 * location for "Deterministic scoring").
 *
 * These three sections are the structured evidence the pilot is built on (FR-DET-001): every
 * question has one right answer, so the score is a comparison, not a judgement. That is what makes
 * it available the instant a student submits — no model is involved, nothing can be slow, and the
 * same answers against the same content always produce the same numbers (Section 12).
 *
 * ## It is a function, not a service with state
 *
 * Section 7 is explicit: "Pure function of (answers, content) — no side effects, fully
 * unit-testable without a database." So there is no class here, no repository, and no import of
 * the content loader. The caller resolves the content and passes it in; this module has no way to
 * reach a database, a version tag, or a clock even by accident.
 *
 * That matters more than it looks. The rule this scoring must never break is that a submission is
 * scored against the content version it was *taken under*, never whatever is current (Section 12,
 * FR-CONTENT-001). A function that cannot call `getCurrentVersion()` cannot break it — the
 * guarantee holds structurally rather than by the caller remembering. Resolving the frozen version
 * is the caller's one job (`SubmissionService.finalize`, T5.2.1), and the test for it lives there.
 *
 * ## What it decides, and what it deliberately does not
 *
 * It decides one thing: whether the student's chosen option is the content's `correctAnswer`. It
 * does **not** validate the answer — an option id that matches no option in the question is scored
 * incorrect rather than rejected, which is the correct reading of "the student selected something
 * that is not an option" (see `choiceAnswersSchema`). Validation of the request body happens at the
 * API boundary, where it belongs (Section 11).
 *
 * It also does not compute anything about Writing or Student Problems. Writing is rubric-based LLM
 * evaluation with a separate calculator (Section 7), and Student Problems must never affect an
 * English score at all (FR-PROB-008/012). Both are absent here for the same reason: a section that
 * is not deterministic has no business in the deterministic scorer.
 */

/**
 * The content a submission is scored against — the three deterministic sections, and nothing else.
 *
 * Deliberately narrower than `ContentBundle`: the writing prompt, the rubric instructions and
 * weights, and the Student Problems instrument are all irrelevant to this scoring, and a signature
 * that accepted them would suggest otherwise. A `ContentBundle` satisfies this type structurally,
 * so the real caller passes `getContent(version)` unchanged, while a unit test can pass a fixture
 * of three section files with no bundle to build.
 */
export type DeterministicContent = {
  grammar: DeterministicSectionFile;
  vocabulary: DeterministicSectionFile;
  reading: ReadingFile;
};

/**
 * One question's outcome.
 *
 * Carries the explanation (FR-DET-004) rather than a question id the report would have to resolve
 * back through content: the report is rendered from the submission row, and the version that row
 * was taken under is the only one whose explanations are correct for it. Handing the explanation
 * over here — from the content actually used to score — is what keeps the two from being able to
 * disagree.
 *
 * There is no `skill` or `difficulty` field. Both are real question metadata (FR-DET-002) and both
 * will matter to the staff difficulty comparison in FR-STAFF-007, but nothing in scoring or in the
 * student report reads them, and a field carried "for later" is a field nobody has yet agreed the
 * meaning of.
 *
 * (An earlier draft of the student report carried `skill` through here to group questions by topic.
 * That grouping was tried and explicitly rejected on review — the report shows a flat question list
 * instead — so `skill` was removed again rather than left wired to a feature that no longer exists.)
 */
export type QuestionScore = {
  questionId: string;
  /**
   * The option the student chose, or `null` when they left the question unanswered.
   *
   * `null` rather than a sentinel string, because "not answered" is a real state the report
   * describes in words (FR-DET-004) and is not a wrong answer that happens to look like one. A
   * blank saved answer — the empty string — is reported as `null` too: an empty selection is not a
   * selection, and this is the same rule `assessmentCompleteness.isAnswered` applies on the client,
   * so the two sides cannot describe one submission differently.
   */
  givenAnswer: string | null;
  /** The content's answer key for this question (FR-DET-002). */
  correctAnswer: string;
  correct: boolean;
  /** FR-DET-002's prewritten explanation — written once per question, never generated. */
  explanation: string;
};

/** One section's result: its score, the score it was out of, and every question's outcome. */
export type SectionScore = {
  /** Sum of the points of the questions answered correctly. */
  score: number;
  /**
   * Sum of every question's points, answered or not.
   *
   * The denominator, computed from content rather than assumed — which is what lets the report say
   * "6 / 9" without hardcoding a question count that a new content version would silently falsify.
   */
  maxScore: number;
  /** Every question in the section, in content order, including those left unanswered. */
  questions: QuestionScore[];
};

/** The three deterministic sections' results, keyed as the `answers` column is. */
export type DeterministicScores = {
  grammar: SectionScore;
  vocabulary: SectionScore;
  reading: SectionScore;
};

/**
 * Every question belonging to one section, in the order the assessment presents them.
 *
 * Reading is the reason this exists: its questions are nested under the passage they belong to, so
 * the section's questions are the concatenation across passages. Flattening here rather than at
 * each call site is what makes "every question in Reading" one definition — the same one the
 * section's score, its maximum, and the client's completeness gate all count.
 */
function questionsOf(section: DeterministicSectionKey, content: DeterministicContent): Question[] {
  if (section === 'reading') {
    return content.reading.passages.flatMap((passage) => passage.questions);
  }

  return content[section].questions;
}

/**
 * The answer the student gave for one question, or `null` when there is none.
 *
 * A non-string or an empty string is "no answer": the autosave schema allows any string at all,
 * including `''`, and a student who clears a selection has not answered the question — they have
 * un-answered it. Scoring is unaffected either way (an empty string can never equal a
 * `correctAnswer`, which the content schema requires to be non-empty), but the report is not, and
 * it should say "not answered" rather than print an empty space where an answer goes.
 */
function readGivenAnswer(given: ChoiceAnswers | undefined, questionId: string): string | null {
  const value = given?.[questionId];

  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** Scores one section's questions against one section's content. */
function scoreSection(questions: Question[], given: ChoiceAnswers | undefined): SectionScore {
  let score = 0;
  let maxScore = 0;

  const outcomes = questions.map((question): QuestionScore => {
    const givenAnswer = readGivenAnswer(given, question.id);
    const correct = givenAnswer !== null && givenAnswer === question.correctAnswer;

    maxScore += question.points;
    if (correct) score += question.points;

    return {
      questionId: question.id,
      givenAnswer,
      correctAnswer: question.correctAnswer,
      correct,
      explanation: question.explanation,
    };
  });

  return { score, maxScore, questions: outcomes };
}

/**
 * The denominator for each deterministic section — the maximum `scoreDeterministicSections` scores
 * it out of.
 *
 * The staff dashboard needs this and nothing else from scoring: FR-STAFF-005/006 put Grammar,
 * Vocabulary, Reading, and Writing on one comparable axis, and the three deterministic sections are
 * out of different totals (9, 9, and 8 under v1 content), so a raw score cannot be compared across
 * them or against Writing's 0–100 without the maximum it was out of.
 *
 * It is exported from here rather than recomputed by the caller for the reason `questionsOf` gives:
 * "every question in a section" must have exactly one definition, and Reading's questions are
 * nested under passages. A dashboard that summed `content.grammar.questions` for itself would agree
 * with this until the day it didn't.
 *
 * Deliberately a separate function rather than only a field on `SectionScore`: the dashboard is
 * aggregating rows it never scored, so it has no `SectionScore` to read the field from.
 */
export function sectionMaxScores(content: DeterministicContent): Record<DeterministicSectionKey, number> {
  const maxOf = (section: DeterministicSectionKey) =>
    questionsOf(section, content).reduce((total, question) => total + question.points, 0);

  return { grammar: maxOf('grammar'), vocabulary: maxOf('vocabulary'), reading: maxOf('reading') };
}

/**
 * Scores Grammar, Vocabulary, and Reading (FR-DET-003), with the per-question explanation
 * FR-DET-004 requires.
 *
 * Unanswered questions are included in the result rather than omitted: they are part of what the
 * section was out of, and their explanations are exactly what a student who skipped one needs to
 * see. Their `correct` is `false`, which is the honest reading of FR-ASSESS-007 — a section is only
 * submittable once every question is answered, so an unanswered question at scoring time means a
 * missing section, not a student who declined to guess.
 *
 * A section the student never saved scores zero out of its full maximum rather than being absent,
 * so every submission produces the same three keys and no reader has to handle a missing one.
 */
export function scoreDeterministicSections(
  answers: DraftAnswers,
  content: DeterministicContent,
): DeterministicScores {
  return {
    grammar: scoreSection(questionsOf('grammar', content), answers.grammar),
    vocabulary: scoreSection(questionsOf('vocabulary', content), answers.vocabulary),
    reading: scoreSection(questionsOf('reading', content), answers.reading),
  };
}
