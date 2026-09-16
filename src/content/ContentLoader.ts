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
   * Flattened projection of `writingRubric`, because the background worker passes these two
   * directly to the AI provider and the score calculator (ARCHITECTURE Section 7, Section 8).
   * They are derived from the same file rather than stored twice.
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
    writingRubricInstructions: writingRubric.instructions,
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
