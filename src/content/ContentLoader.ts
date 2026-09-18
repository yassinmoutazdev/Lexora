import fs from 'node:fs';
import path from 'node:path';
import type { z } from 'zod';
import { REPO_ROOT } from '../config/env.ts';
import {
  currentVersionFileSchema,
  deterministicSectionFileSchema,
  readingFileSchema,
  studentProblemsFileSchema,
  writingPromptFileSchema,
  writingRubricFileSchema,
  type DeterministicSectionFile,
  type ReadingFile,
  type StudentProblemsFile,
  type WritingPromptFile,
  type WritingRubricFile,
} from './contentSchemas.ts';

/**
 * Loads and validates every assessment content version (ARCHITECTURE Section 4, Section 16,
 * Section 18 — canonical location for "assessment content, all versions").
 *
 * Two properties define this class, and both are about failing early rather than gracefully:
 *
 * 1. **Everything is loaded and validated at construction.** A malformed content file stops the
 *    process at boot, before it can serve a student a question with no answer key.
 * 2. **Every version stays resident for the life of the process.** A submission's `contentVersion`
 *    is frozen at draft creation, so scoring, reporting, and background evaluation must always be
 *    able to resolve the version a submission was taken under — never "current" (ARCHITECTURE
 *    Section 12). Keeping all versions in memory is what makes that guarantee unconditional
 *    rather than dependent on what the repository happens to contain today.
 */

/** The files that together make up one version's bundle. */
const FILE_NAMES = {
  grammar: 'grammar-questions.json',
  vocabulary: 'vocabulary-questions.json',
  reading: 'reading-questions.json',
  writingPrompt: 'writing-prompt.json',
  writingRubric: 'writing-rubric.json',
  studentProblems: 'student-problems-statements.json',
} as const;

const CURRENT_VERSION_FILE = 'current-version.json';

/** A fully loaded, validated content version. */
export type ContentBundle = {
  version: string;
  grammar: DeterministicSectionFile;
  vocabulary: DeterministicSectionFile;
  reading: ReadingFile;
  writingPrompt: WritingPromptFile;
  writingRubric: WritingRubricFile;
  studentProblems: StudentProblemsFile;

  /**
   * The text the model is given when it evaluates a free-writing response, because the background
   * worker passes it directly to the AI provider (ARCHITECTURE Section 7, Section 8).
   *
   * Derived rather than stored twice: the rubric's own `instructions`, composed with the task the
   * response was written in answer to and the output contract its JSON must satisfy. See
   * `composeWritingRubricInstructions` for why both were missing and where each value comes from.
   */
  writingRubricInstructions: string;
  writingRubricWeights: Record<string, number>;
};

/** Raised for any content problem. One type, so boot can report every distinct cause it finds. */
export class ContentValidationError extends Error {
  override readonly name = 'ContentValidationError';
}

function formatIssues(issues: z.ZodIssue[]): string {
  return issues
    .map((issue) => `    - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('\n');
}

/**
 * Reads one JSON file and validates it against its schema.
 *
 * `expectedSection` is checked separately from the schema because the schema for the grammar and
 * vocabulary files is the same shape — without this, swapping the two files would load cleanly and
 * silently score the wrong questions.
 */
function readContentFile<T extends z.ZodTypeAny>(
  filePath: string,
  schema: T,
  expectedSection?: string,
): z.infer<T> {
  let raw: string;

  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    throw new ContentValidationError(`Missing content file: ${filePath}`);
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch (error) {
    throw new ContentValidationError(
      `Content file is not valid JSON: ${filePath}\n    ${(error as Error).message}`,
    );
  }

  const result = schema.safeParse(parsedJson);

  if (!result.success) {
    throw new ContentValidationError(
      `Invalid content in ${filePath}:\n${formatIssues(result.error.issues)}`,
    );
  }

  if (expectedSection && result.data.section !== expectedSection) {
    throw new ContentValidationError(
      `Invalid content in ${filePath}:\n    - section: expected ${JSON.stringify(expectedSection)}, got ${JSON.stringify(result.data.section)}`,
    );
  }

  return result.data;
}

/**
 * Composes the text the model is given when it evaluates a free-writing response.
 *
 * ## Why this is a composition rather than the rubric's own `instructions`
 *
 * The rubric file is the authored statement of *how to judge*; it is not a statement of *what the
 * response was written in answer to*, and it is not a statement of the JSON shape the answer must
 * arrive in. Both of those were missing from what reached the model, and each failed silently:
 *
 * - **The task.** `taskCompletion` is defined as whether the response "addresses the prompt" and
 *   "meets the expected length", yet the prompt and the length target are in
 *   `writing-prompt.json` and never reached the model. A criterion one fifth of the score depends
 *   on was being judged without the information needed to judge it. (`writing-prompt.json` is
 *   resolved into the bundle a few lines above this one and was otherwise unread.)
 * - **The output contract.** `writingEvaluationSchema` is `.strict()`, so a misnamed top-level key
 *   fails validation outright — while the model was never told the key names. It was being asked to
 *   guess the exact keys of a schema it had not been shown, and a wrong guess spends a retry and
 *   ends at `failed_needs_review` for a response that was graded correctly.
 *
 * ## Every value here is derived, none is authored
 *
 * The criterion key list, the top-level key names, their descriptions, the score range, the
 * correction cap, and the task text are all read from the two content files. Nothing in this
 * function is a second copy of a content decision, so a v2 rubric cannot drift from a prompt that
 * was written against v1. The one thing this function supplies is the connective prose that turns
 * those values into an instruction — which is a fact about how to assemble a prompt, not a fact
 * about the rubric.
 *
 * ## Why the descriptions are quoted verbatim
 *
 * `outputRequirements.fields` maps each required top-level key to the authored description of what
 * belongs in it. Quoting it rather than restating it in code is what keeps the model's instructions
 * and the team's authored intent the same object. The nested `score`/`rationale` field names are
 * named inside `fields.criteriaScores`'s own description for the same reason: `src/ai/schemas.ts`
 * enforces that shape, and the description is where content states it.
 *
 * ## Why the task is framed as context and not as something to evaluate
 *
 * Handing the model the task text introduces a text it could start grading instead of the student's
 * answer. The framing sentence below closes that: the task is what the response is judged *against*,
 * and the model is told explicitly not to evaluate the description itself.
 */
/**
 * One criterion's descriptor at one band.
 *
 * Throws rather than returning a default when the descriptor is absent. That state is unreachable —
 * `contentSchemas.ts` rejects a rubric whose `bands.descriptors` omits a criterion or a band, and
 * `loadVersion` validates before composing — but the failure mode if the guarantee were ever
 * relaxed is a prompt that silently ships with a criterion the model calibrates by guesswork, which
 * is precisely what the `bands` validation was added to prevent. A blank anchor is worse than a
 * loud one, so this is loud.
 */
function bandDescriptor(rubric: WritingRubricFile, criterionKey: string, bandName: string): string {
  const descriptor = rubric.bands.descriptors[criterionKey]?.[bandName];

  if (!descriptor) {
    throw new ContentValidationError(
      `Missing band descriptor for criterion ${JSON.stringify(criterionKey)} at band ` +
        `${JSON.stringify(bandName)}. contentSchemas.ts should have rejected this rubric at load.`,
    );
  }

  return descriptor;
}

function composeWritingRubricInstructions(
  writingPrompt: WritingPromptFile,
  writingRubric: WritingRubricFile,
): string {
  const criterionKeys = writingRubric.criteria.map((criterion) => criterion.key);
  const { min, max } = writingRubric.scoreRange;
  const { maxCorrections, fields } = writingRubric.outputRequirements;

  const fieldLines = Object.entries(fields).map(([key, description]) => `- ${key}: ${description}`);

  // One section per criterion, so the four anchors for a criterion sit together at the moment the
  // model is choosing that criterion's score. Grouping by band instead would scatter each
  // criterion's scale across the prompt.
  const bandSections = writingRubric.criteria.map((criterion) =>
    [
      `${criterion.key}:`,
      ...writingRubric.bands.definitions.map(
        (band) =>
          `  ${band.min}–${band.max} (${band.name}): ${bandDescriptor(writingRubric, criterion.key, band.name)}`,
      ),
    ].join('\n'),
  );

  return [
    writingRubric.instructions,

    '', '---', '',

    'Scoring anchors. Use these to place each criterion on the scale. Judge each criterion against',
    'its own descriptors below — the same number does not mean the same thing in two different',
    'criteria, and the bands are guidance for choosing a score, not a score to look up.',
    '',
    ...bandSections,

    '', '---', '',

    'The student was given the task below. Judge the response against it — in particular, use it to',
    'decide whether the response addresses the prompt, states a position where one is asked for, and',
    'meets the expected length. Do not evaluate this description of the task itself.',
    '',
    `Task: ${writingPrompt.task.prompt}`,
    '',
    `Guidance given to the student: ${writingPrompt.task.guidance}`,

    '', '---', '',

    'Return a single JSON object with exactly these top-level keys and no others:',
    ...fieldLines,
    '',
    `Every criterion score must be a number between ${min} and ${max}.`,
    `The "criteriaScores" object must be keyed by exactly these criterion keys: ${criterionKeys.join(', ')}.`,
    `Return at most ${maxCorrections} corrections.`,
  ].join('\n');
}

/** Loads one version directory into a validated bundle. */
function loadVersion(version: string, versionDir: string): ContentBundle {
  const file = (name: string) => path.join(versionDir, name);

  const grammar = readContentFile(file(FILE_NAMES.grammar), deterministicSectionFileSchema, 'grammar');
  const vocabulary = readContentFile(
    file(FILE_NAMES.vocabulary),
    deterministicSectionFileSchema,
    'vocabulary',
  );
  const reading = readContentFile(file(FILE_NAMES.reading), readingFileSchema, 'reading');
  const writingPrompt = readContentFile(
    file(FILE_NAMES.writingPrompt),
    writingPromptFileSchema,
    'writing',
  );
  const writingRubric = readContentFile(
    file(FILE_NAMES.writingRubric),
    writingRubricFileSchema,
    'writing',
  );
  const studentProblems = readContentFile(
    file(FILE_NAMES.studentProblems),
    studentProblemsFileSchema,
    'studentProblems',
  );

  return {
    version,
    grammar,
    vocabulary,
    reading,
    writingPrompt,
    writingRubric,
    studentProblems,
    writingRubricInstructions: composeWritingRubricInstructions(writingPrompt, writingRubric),
    writingRubricWeights: writingRubric.weights,
  };
}

export class ContentLoader {
  private readonly bundles: Map<string, ContentBundle>;
  private readonly currentVersion: string;

  /**
   * @param contentRoot Directory holding `current-version.json` and `versions/`. Defaults to the
   *   repository's `content/`. Overridden by tests that need to point at a fixture tree.
   */
  constructor(contentRoot: string = path.join(REPO_ROOT, 'content')) {
    const versionsDir = path.join(contentRoot, 'versions');
    const current = readContentFile(
      path.join(contentRoot, CURRENT_VERSION_FILE),
      currentVersionFileSchema,
    );

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(versionsDir, { withFileTypes: true });
    } catch {
      throw new ContentValidationError(`Missing content versions directory: ${versionsDir}`);
    }

    const bundles = new Map<string, ContentBundle>();
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      bundles.set(entry.name, loadVersion(entry.name, path.join(versionsDir, entry.name)));
    }

    if (bundles.size === 0) {
      throw new ContentValidationError(`No content versions found under ${versionsDir}`);
    }

    // A current version that does not resolve would hand every new draft an unresolvable
    // contentVersion — the failure would surface much later, as a scoring error.
    if (!bundles.has(current.version)) {
      throw new ContentValidationError(
        `${path.join(contentRoot, CURRENT_VERSION_FILE)} points at version ` +
          `${JSON.stringify(current.version)}, which does not exist under ${versionsDir} ` +
          `(found: ${[...bundles.keys()].join(', ')})`,
      );
    }

    this.bundles = bundles;
    this.currentVersion = current.version;
  }

  /**
   * The bundle for a specific version.
   *
   * Throws for an unknown version rather than falling back to "current": every caller is either
   * resolving a submission's frozen `contentVersion` or the current version explicitly, and a
   * silent fallback would score a submission against content it was never taken under.
   */
  getContent(version: string): ContentBundle {
    const bundle = this.bundles.get(version);

    if (!bundle) {
      throw new Error(
        `Unknown content version ${JSON.stringify(version)}. Loaded versions: ${[...this.bundles.keys()].join(', ')}`,
      );
    }

    return bundle;
  }

  /** The version new drafts start under (ARCHITECTURE Section 18 — `content/current-version.json`). */
  getCurrentVersion(): string {
    return this.currentVersion;
  }

  /** Every loaded version, for diagnostics and tests. */
  getLoadedVersions(): string[] {
    return [...this.bundles.keys()];
  }
}

let instance: ContentLoader | undefined;

/**
 * The process-wide content loader.
 *
 * Content is loaded once and kept, rather than constructed per caller, for the reason the class
 * documentation gives: a submission's `contentVersion` is frozen at draft creation, so scoring,
 * reporting, and background evaluation must be able to resolve that version for as long as the
 * process lives. Re-reading every version per request would be wasteful, and more than one
 * instance would mean the version a caller resolves depends on which copy it happened to get.
 *
 * Lazy rather than a module-level `new ContentLoader()` for the same reason `getPrismaClient()` is
 * lazy: importing this module to use the *type* must not read the content tree, or a unit test
 * would depend on the repository's content files existing.
 *
 * Tests that need a different content root construct their own `new ContentLoader(fixtureRoot)`
 * and inject it, so nothing here needs a reset hook.
 */
export function getContentLoader(): ContentLoader {
  instance ??= new ContentLoader();
  return instance;
}
