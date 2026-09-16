import { describe, expect, it } from 'vitest';
import {
  deterministicSectionFileSchema,
  readingFileSchema,
  type Question,
} from '../../content/contentSchemas.ts';
import type { DraftAnswers } from '../../shared/types/draft.ts';
import {
  scoreDeterministicSections,
  type DeterministicContent,
  type QuestionScore,
  type SectionScore,
} from './DeterministicScoringService.ts';

/**
 * Unit coverage for `DeterministicScoringService` (T5.1.1, ARCHITECTURE Section 15 — "Correct/
 * incorrect answer scoring, section totals, explanation lookup, against fixture content for a
 * specific version").
 *
 * There is no database here and no content loader: the module is a function of (answers, content),
 * so the tests pass it content and read the result. That is the whole design being verified — if
 * this file needed a database to run, the module would have stopped being the pure function
 * Section 7 specifies.
 *
 * The fixtures are not hand-shaped literals: each is parsed through the same zod schema that
 * validates the repository's real content files at boot. A fixture that type-checked but was not
 * valid content — a `correctAnswer` naming an option that does not exist, say — would otherwise be
 * able to pass these tests while being impossible to ship.
 */

/** One fixture question with four options, of which `correctAnswer` is the key. */
function question(
  id: string,
  correctAnswer: string,
  overrides: Partial<Question> = {},
): Record<string, unknown> {
  return {
    id,
    skill: 'Fixture skill',
    difficulty: 'basic',
    type: 'multiple_choice',
    prompt: `Prompt for ${id}`,
    options: [
      { id: 'a', text: 'Option A' },
      { id: 'b', text: 'Option B' },
      { id: 'c', text: 'Option C' },
      { id: 'd', text: 'Option D' },
    ],
    correctAnswer,
    // Per-question, so that a test can tell one question's explanation from another's.
    explanation: `Explanation for ${id}`,
    points: 1,
    ...overrides,
  };
}

/**
 * A fixture content version.
 *
 * `grammarKey` parameterises the first Grammar question's answer key, which is what makes it
 * possible to score one set of answers against two different versions of the content and see the
 * results diverge.
 *
 * Grammar, Vocabulary, and Reading carry deliberately different point totals (1s, then 2 and 3,
 * then 1, 1 and 2) so that "the score is the sum of the content's points" is distinguishable from
 * "the score is the number of questions answered correctly" — a bug the latter would hide.
 */
function buildContent(grammarKey: string): DeterministicContent {
  return {
    grammar: deterministicSectionFileSchema.parse({
      section: 'grammar',
      title: 'Grammar',
      contentStatus: 'approved',
      instructions: 'Choose the option that best completes each sentence.',
      questions: [
        question('grammar-fixture-1', grammarKey),
        question('grammar-fixture-2', 'a'),
        question('grammar-fixture-3', 'd'),
      ],
    }),

    vocabulary: deterministicSectionFileSchema.parse({
      section: 'vocabulary',
      title: 'Vocabulary',
      contentStatus: 'approved',
      instructions: 'Choose the word that fits.',
      questions: [
        question('vocabulary-fixture-1', 'c', { points: 2 }),
        question('vocabulary-fixture-2', 'a', { points: 3 }),
      ],
    }),

    // Two passages, so that "every question in Reading" cannot be satisfied by reading only the
    // first one — which is the mistake the flattening exists to prevent.
    reading: readingFileSchema.parse({
      section: 'reading',
      title: 'Reading',
      contentStatus: 'approved',
      instructions: 'Read each passage, then answer the questions that follow it.',
      passages: [
        {
          id: 'passage-1',
          title: 'First passage',
          text: 'The first fixture passage.',
          questions: [
            question('reading-fixture-1', 'b'),
            question('reading-fixture-2', 'c'),
          ],
        },
        {
          id: 'passage-2',
          title: 'Second passage',
          text: 'The second fixture passage.',
          questions: [question('reading-fixture-3', 'a', { points: 2 })],
        },
      ],
    }),
  };
}

/** The fixture content, with `grammar-fixture-1` keyed to `b`. */
const CONTENT = buildContent('b');

/**
 * One question's outcome, by id.
 *
 * Looked up rather than indexed so the assertion names the question it is about: `questions[2]` is
 * a position that a change to the fixture would silently move, and `noUncheckedIndexedAccess` is
 * right to make the compiler complain about it.
 */
function questionScore(section: SectionScore, questionId: string): QuestionScore {
  const outcome = section.questions.find((candidate) => candidate.questionId === questionId);

  if (!outcome) throw new Error(`No scored outcome for ${questionId}`);

  return outcome;
}

describe('scoreDeterministicSections — scoring', () => {
  it('awards the points of a correct answer and nothing for a wrong one', () => {
    const scores = scoreDeterministicSections(
      { grammar: { 'grammar-fixture-1': 'b', 'grammar-fixture-2': 'c' } },
      CONTENT,
    );

    expect(scores.grammar.score).toBe(1);
    expect(scores.grammar.questions).toEqual([
      expect.objectContaining({ questionId: 'grammar-fixture-1', correct: true }),
      expect.objectContaining({ questionId: 'grammar-fixture-2', correct: false }),
      expect.objectContaining({ questionId: 'grammar-fixture-3', correct: false }),
    ]);
  });

  it('sums the content’s points rather than counting correct questions', () => {
    // Vocabulary's two questions are worth 2 and 3. Answering only the second one correctly must
    // score 3, not 1 — if the service counted questions, this is the test that would fail.
    const scores = scoreDeterministicSections(
      { vocabulary: { 'vocabulary-fixture-2': 'a' } },
      CONTENT,
    );

    expect(scores.vocabulary.score).toBe(3);
    expect(scores.vocabulary.maxScore).toBe(5);
  });

  it('scores a fully correct section at its full maximum', () => {
    const scores = scoreDeterministicSections(
      {
        grammar: {
          'grammar-fixture-1': 'b',
          'grammar-fixture-2': 'a',
          'grammar-fixture-3': 'd',
        },
      },
      CONTENT,
    );

    expect(scores.grammar.score).toBe(scores.grammar.maxScore);
    expect(scores.grammar.score).toBe(3);
    expect(scores.grammar.questions.every((outcome) => outcome.correct)).toBe(true);
  });

  it('scores a fully wrong section at zero, out of the same maximum', () => {
    const scores = scoreDeterministicSections(
      {
        grammar: {
          'grammar-fixture-1': 'a',
          'grammar-fixture-2': 'b',
          'grammar-fixture-3': 'c',
        },
      },
      CONTENT,
    );

    expect(scores.grammar.score).toBe(0);
    expect(scores.grammar.maxScore).toBe(3);
  });

  it('scores an answer that is not one of the question’s options as incorrect, without throwing', () => {
    // The answer schema accepts any string, so this is reachable. It is an incorrect answer, not a
    // malformed request — validation happened at the API boundary, and re-deciding it here would
    // put the same rule in two places.
    const scores = scoreDeterministicSections(
      { grammar: { 'grammar-fixture-1': 'z' } },
      CONTENT,
    );

    expect(questionScore(scores.grammar, 'grammar-fixture-1')).toMatchObject({
      correct: false,
      givenAnswer: 'z',
    });
  });

  it('reports an unanswered question as not answered, still counted in the maximum', () => {
    const scores = scoreDeterministicSections(
      { grammar: { 'grammar-fixture-1': 'b' } },
      CONTENT,
    );

    const unanswered = scores.grammar.questions.filter(
      (outcome) => outcome.questionId !== 'grammar-fixture-1',
    );
    expect(unanswered.map((outcome) => outcome.givenAnswer)).toEqual([null, null]);
    expect(unanswered.every((outcome) => !outcome.correct)).toBe(true);
    expect(scores.grammar.maxScore).toBe(3);
    expect(scores.grammar.score).toBe(1);
  });

  it('treats a blank saved answer as not answered', () => {
    // Clearing a selection is un-answering a question, and the client's completeness gate already
    // reads an empty string that way. The two sides describe one submission, so they must agree.
    const scores = scoreDeterministicSections(
      { grammar: { 'grammar-fixture-1': '' } },
      CONTENT,
    );

    expect(questionScore(scores.grammar, 'grammar-fixture-1').givenAnswer).toBeNull();
  });
});

describe('scoreDeterministicSections — explanation lookup', () => {
  it('returns each question’s own prewritten explanation (FR-DET-004)', () => {
    const scores = scoreDeterministicSections(
      { grammar: { 'grammar-fixture-1': 'b', 'grammar-fixture-2': 'c' } },
      CONTENT,
    );

    // The content's text, verbatim, per question — not one explanation reused, and not anything
    // generated. FR-DET-002 requires the explanation to be prewritten, and this is where the
    // report's copy of it comes from.
    expect(scores.grammar.questions.map((outcome) => outcome.explanation)).toEqual([
      'Explanation for grammar-fixture-1',
      'Explanation for grammar-fixture-2',
      'Explanation for grammar-fixture-3',
    ]);
    expect(scores.grammar.questions.map((outcome) => outcome.correctAnswer)).toEqual([
      'b',
      'a',
      'd',
    ]);
  });

  it('carries the explanation for an unanswered question, which is what a skipped question needs', () => {
    const scores = scoreDeterministicSections({}, CONTENT);

    expect(questionScore(scores.grammar, 'grammar-fixture-3').explanation).toBe(
      'Explanation for grammar-fixture-3',
    );
  });
});

describe('scoreDeterministicSections — reading', () => {
  it('gathers every passage’s questions into the one section', () => {
    const scores = scoreDeterministicSections({}, CONTENT);

    expect(scores.reading.questions.map((outcome) => outcome.questionId)).toEqual([
      'reading-fixture-1',
      'reading-fixture-2',
      'reading-fixture-3',
    ]);
    expect(scores.reading.maxScore).toBe(4);
  });

  it('scores questions from a later passage like any other', () => {
    const scores = scoreDeterministicSections(
      { reading: { 'reading-fixture-3': 'a' } },
      CONTENT,
    );

    expect(scores.reading.score).toBe(2);
    expect(questionScore(scores.reading, 'reading-fixture-3').correct).toBe(true);
  });
});

describe('scoreDeterministicSections — the shape of the result', () => {
  it('returns all three sections for a submission with no answers at all', () => {
    // A section the student never saved is zero out of its maximum, not absent — so every reader
    // has three keys to handle and none has to handle a missing one.
    const scores = scoreDeterministicSections({}, CONTENT);

    expect(Object.keys(scores).sort()).toEqual(['grammar', 'reading', 'vocabulary']);
    expect(scores.grammar.score).toBe(0);
    expect(scores.grammar.maxScore).toBe(3);
    expect(scores.reading.score).toBe(0);
    expect(scores.reading.maxScore).toBe(4);
  });

  it('ignores sections it does not score', () => {
    // Writing and Student Problems are in the answers but are not deterministic; nothing about them
    // may reach a score (FR-PROB-008/012, and Writing is Section 7's separate calculator).
    const scores = scoreDeterministicSections(
      {
        grammar: { 'grammar-fixture-1': 'b' },
        writing: { essayText: 'A paragraph.' },
        studentProblems: { likertAnswers: { 'sp-01': 5 }, openText: 'النطق صعب' },
      },
      CONTENT,
    );

    expect(scores.grammar.score).toBe(1);
    expect(Object.keys(scores).sort()).toEqual(['grammar', 'reading', 'vocabulary']);
  });

  it('does not modify the answers it is given', () => {
    const answers: DraftAnswers = { grammar: { 'grammar-fixture-1': 'b' } };
    const before = structuredClone(answers);

    scoreDeterministicSections(answers, CONTENT);

    expect(answers).toEqual(before);
  });
});

describe('scoreDeterministicSections — the content it is given decides the score', () => {
  it('scores the same answers differently against a different version’s content', () => {
    // The frozen-version guarantee (Section 12) at the level this module can hold it: the result
    // follows the content argument and nothing else. Two versions that disagree about one question's
    // answer key must produce different scores for identical answers — which is only possible
    // because the service resolves no version of its own. Nothing here can reach `getCurrentVersion()`.
    const answers: DraftAnswers = { grammar: { 'grammar-fixture-1': 'b' } };

    const underOneVersion = scoreDeterministicSections(answers, buildContent('b'));
    const underAnother = scoreDeterministicSections(answers, buildContent('c'));

    expect(underOneVersion.grammar.score).toBe(1);
    expect(underAnother.grammar.score).toBe(0);
    expect(questionScore(underAnother.grammar, 'grammar-fixture-1').correctAnswer).toBe('c');
  });

  it('is a function of its arguments — the same inputs produce the same result', () => {
    const answers: DraftAnswers = { grammar: { 'grammar-fixture-1': 'b' } };

    expect(scoreDeterministicSections(answers, CONTENT)).toEqual(
      scoreDeterministicSections(answers, CONTENT),
    );
  });
});
