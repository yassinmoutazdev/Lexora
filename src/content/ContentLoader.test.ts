import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { writingEvaluationSchema } from '../ai/schemas.ts';
import { REPO_ROOT } from '../config/env.ts';
import { bandForScore, ContentLoader, ContentValidationError } from './ContentLoader.ts';

/**
 * Unit coverage for `ContentLoader` (T2.2.4).
 *
 * The loader is exercised against both the repository's real content tree and throwaway fixture
 * trees built in the OS temp directory. The fixtures matter because the two behaviours worth
 * proving — "adding a v2 does not disturb v1" and "a malformed version stops boot" — cannot be
 * demonstrated without writing files, and must never be demonstrated by writing them into the
 * repository's own `content/`.
 */

const REAL_CONTENT = path.join(REPO_ROOT, 'content');

const tempRoots: string[] = [];

/** Copies the real content tree into a temp directory so a test can mutate it freely. */
function makeFixtureTree(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lexora-content-'));
  tempRoots.push(root);
  fs.cpSync(REAL_CONTENT, root, { recursive: true });
  return root;
}

/** Copies `versions/v1` to `versions/<name>` inside a fixture tree. */
function addVersion(root: string, name: string): string {
  const target = path.join(root, 'versions', name);
  fs.cpSync(path.join(root, 'versions', 'v1'), target, { recursive: true });
  return target;
}

function readJson(filePath: string): any {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJson(filePath: string, value: unknown): void {
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf8');
}

afterAll(() => {
  for (const root of tempRoots) fs.rmSync(root, { recursive: true, force: true });
});

describe('ContentLoader against the committed content', () => {
  const loader = new ContentLoader();

  /**
   * The pointer and the version directories are read from disk here rather than written out as
   * literals. Which version is current is a content decision that changes every time the content
   * does, and this test is about the loader honouring `current-version.json` — not about which
   * version that file happens to name. Spelling the version out made the first content change
   * fail a test about the loader, which reads as a loader bug and is not one.
   */
  it('loads the current version named by current-version.json', () => {
    const pointer = JSON.parse(
      fs.readFileSync(path.join(REAL_CONTENT, 'current-version.json'), 'utf8'),
    ) as { version: string };

    const versionDirs = fs
      .readdirSync(path.join(REAL_CONTENT, 'versions'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();

    expect(loader.getCurrentVersion()).toBe(pointer.version);
    expect(loader.getLoadedVersions().sort()).toEqual(versionDirs);
  });

  /**
   * Whatever becomes current, v1 stays resident: a submission created under it has its version
   * frozen at draft creation and must still resolve once a newer version ships (Section 12).
   */
  it('keeps the frozen version of an already-recorded submission resolvable', () => {
    expect(loader.getLoadedVersions()).toContain('v1');
    expect(loader.getContent('v1').grammar.questions.length).toBeGreaterThan(0);
  });

  it('exposes each section of the bundle', () => {
    const content = loader.getContent('v1');

    expect(content.version).toBe('v1');
    expect(content.grammar.section).toBe('grammar');
    expect(content.vocabulary.section).toBe('vocabulary');
    expect(content.reading.section).toBe('reading');
    expect(content.writingPrompt.section).toBe('writing');
    expect(content.studentProblems.section).toBe('studentProblems');
    expect(content.grammar.questions.length).toBeGreaterThan(0);
    expect(content.reading.passages.length).toBeGreaterThan(0);
  });

  it('projects the rubric weights the worker consumes', () => {
    const content = loader.getContent('v1');

    expect(content.writingRubricWeights).toEqual(content.writingRubric.weights);
  });

  /**
   * The composed prompt is the whole of what the model is told, so this asserts it carries the three
   * things a usable one needs: the authored rubric, the task the response is graded against, and the
   * output contract its JSON must satisfy.
   *
   * Each expectation is derived from the content bundle or the schema rather than written out as
   * prose, which is the point: it fails if a criterion key is renamed, if the task is reworded, or —
   * the case that motivated the composition — if `writingEvaluationSchema` gains a top-level key that
   * nobody told the model about. Asserting literal sentences would only prove the strings still
   * match themselves.
   */
  it('composes the writing prompt from the rubric, the task, and the output contract', () => {
    const content = loader.getContent('v1');
    const composed = content.writingRubricInstructions;

    // The authored rubric text, carried through unchanged.
    expect(composed).toContain(content.writingRubric.instructions);

    // The task, which `taskCompletion` is defined in terms of ("addresses the prompt", "meets the
    // expected length") and which used to be resolved and then never sent.
    expect(composed).toContain(content.writingPrompt.task.prompt);
    expect(composed).toContain(content.writingPrompt.task.guidance);

    // Every top-level key the strict schema requires. Derived from the schema, because a response
    // that guesses a key name fails validation outright — this is the assertion that would have
    // caught the missing output contract.
    const requiredKeys = Object.keys(
      (writingEvaluationSchema as unknown as { shape: Record<string, unknown> }).shape,
    );
    for (const key of requiredKeys) {
      expect(composed).toContain(key);
    }

    // The authored description of each of those keys, quoted rather than restated in code.
    for (const description of Object.values(content.writingRubric.outputRequirements.fields)) {
      expect(composed).toContain(description);
    }

    // The nested field names the schema requires inside those keys.
    for (const field of ['score', 'rationale', 'original', 'corrected', 'explanation']) {
      expect(composed).toContain(field);
    }

    // The scoring anchors: every criterion's descriptor at every band, so no criterion reaches the
    // model with a scale it has to invent. Derived from the content, so a descriptor reworded or a
    // band renamed is carried into the prompt rather than leaving it stale.
    for (const [criterionKey, byBand] of Object.entries(content.writingRubric.bands.descriptors)) {
      for (const [bandName, descriptor] of Object.entries(byBand)) {
        expect(composed).toContain(criterionKey);
        expect(composed).toContain(`${bandName}): ${descriptor}`);
      }
    }

    for (const band of content.writingRubric.bands.definitions) {
      expect(composed).toContain(`${band.min}–${band.max} (${band.name})`);
    }

    // Every criterion key, the correction cap, and the score range — all read from the rubric.
    for (const criterion of content.writingRubric.criteria) {
      expect(composed).toContain(criterion.key);
    }
    expect(composed).toContain(String(content.writingRubric.outputRequirements.maxCorrections));
    expect(composed).toContain(`${content.writingRubric.scoreRange.min} and ${content.writingRubric.scoreRange.max}`);
  });

  it('throws for a version that was never loaded instead of falling back to current', () => {
    expect(() => loader.getContent('v99')).toThrow(/Unknown content version/);
  });
});

describe('bandForScore', () => {
  const loader = new ContentLoader();

  it('returns the band and descriptor a real score falls in, for a real committed rubric', () => {
    const content = loader.getContent('v1');
    const { criteria, bands, scoreRange } = content.writingRubric;
    const criterionKey = criteria[0]?.key;

    if (!criterionKey) throw new Error('Fixture rubric has no criteria to test against.');

    // The min of the scale is, by the same tiling guarantee `bandDescriptor` relies on, inside
    // exactly one band — whichever one `bands.definitions` places `scoreRange.min` in.
    const expectedBand = bands.definitions.find(
      (definition) => scoreRange.min >= definition.min && scoreRange.min <= definition.max,
    );

    if (!expectedBand) throw new Error('scoreRange.min is not covered by any band — content is broken.');

    const placement = bandForScore(content.writingRubric, criterionKey, scoreRange.min);

    expect(placement.band).toBe(expectedBand.name);
    expect(placement.descriptor).toBe(bands.descriptors[criterionKey]?.[expectedBand.name]);
  });

  it('throws rather than guessing for a score outside every band', () => {
    const content = loader.getContent('v1');
    const criterionKey = content.writingRubric.criteria[0]?.key;

    if (!criterionKey) throw new Error('Fixture rubric has no criteria to test against.');

    // One below the scale's own minimum is guaranteed to be outside every band, since the bands are
    // validated to tile scoreRange exactly.
    const belowScale = content.writingRubric.scoreRange.min - 1;

    expect(() => bandForScore(content.writingRubric, criterionKey, belowScale)).toThrow(
      ContentValidationError,
    );
  });
});

describe('ContentLoader with a fixture version added', () => {
  it('resolves v1 identically after a new version exists', () => {
    const root = makeFixtureTree();

    // The fixture states its own current version instead of inheriting the repository's. The
    // question here is what the loader does when a version is *added*, and inheriting made the
    // answer depend on what the committed content happens to ship as current.
    writeJson(path.join(root, 'current-version.json'), { version: 'v1' });

    const v1Before = new ContentLoader(root).getContent('v1');

    // A directory name no committed version can collide with, so the fixture's added version is
    // genuinely added rather than overwriting one the repository already ships.
    const addedDir = addVersion(root, 'v-added');
    // v-added differs, so a loader that resolved "current" or "latest" would visibly return the
    // wrong bundle rather than accidentally matching v1.
    const addedFile = path.join(addedDir, 'grammar-questions.json');
    const added = readJson(addedFile);
    added.questions[0].prompt = 'A v-added-only question.';
    writeJson(addedFile, added);

    const loader = new ContentLoader(root);

    const versionDirs = fs
      .readdirSync(path.join(root, 'versions'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();

    expect(loader.getLoadedVersions().sort()).toEqual(versionDirs);
    expect(loader.getLoadedVersions()).toContain('v-added');
    expect(loader.getCurrentVersion()).toBe('v1');
    expect(loader.getContent('v1')).toEqual(v1Before);
    // The added version is served as itself, not as a fallback to the current one.
    expect(loader.getContent('v-added').grammar.questions[0]?.prompt).toBe('A v-added-only question.');
  });

  it('serves the new current version once current-version.json points at it', () => {
    const root = makeFixtureTree();
    addVersion(root, 'v-added');
    writeJson(path.join(root, 'current-version.json'), { version: 'v-added' });

    const loader = new ContentLoader(root);

    expect(loader.getCurrentVersion()).toBe('v-added');
    // v1 remains resolvable — a submission frozen under it must still score.
    expect(loader.getContent('v1').grammar.questions.length).toBeGreaterThan(0);
  });
});

describe('ContentLoader fails fast on broken content', () => {
  const boot = (root: string) => () => new ContentLoader(root);

  it('refuses to boot when a version has a malformed question file', () => {
    const root = makeFixtureTree();
    const v2 = addVersion(root, 'v2');
    const file = path.join(v2, 'grammar-questions.json');
    writeJson(file, { ...readJson(file), questions: 'not an array' });

    expect(boot(root)).toThrow(ContentValidationError);
    expect(boot(root)).toThrow(/grammar-questions\.json/);
  });

  it('names the offending field in the error', () => {
    const root = makeFixtureTree();
    const v2 = addVersion(root, 'v2');
    const file = path.join(v2, 'vocabulary-questions.json');
    const content = readJson(file);
    content.questions[0].correctAnswer = 'z';
    writeJson(file, content);

    expect(boot(root)).toThrow(/correctAnswer/);
  });

  it('refuses to boot when a required file is missing', () => {
    const root = makeFixtureTree();
    const v2 = addVersion(root, 'v2');
    fs.rmSync(path.join(v2, 'writing-rubric.json'));

    expect(boot(root)).toThrow(/Missing content file/);
  });

  it('refuses to boot when a file is not valid JSON', () => {
    const root = makeFixtureTree();
    const v2 = addVersion(root, 'v2');
    fs.writeFileSync(path.join(v2, 'reading-questions.json'), '{ "section": "reading",', 'utf8');

    expect(boot(root)).toThrow(/not valid JSON/);
  });

  it('refuses to boot when current-version.json names a version that does not exist', () => {
    const root = makeFixtureTree();
    writeJson(path.join(root, 'current-version.json'), { version: 'v3' });

    expect(boot(root)).toThrow(/does not exist/);
  });

  it('refuses to boot when a section file carries the wrong section', () => {
    const root = makeFixtureTree();
    const v2 = addVersion(root, 'v2');
    // Swapping the two files would otherwise load cleanly and score the wrong questions.
    fs.copyFileSync(
      path.join(v2, 'vocabulary-questions.json'),
      path.join(v2, 'grammar-questions.json'),
    );

    expect(boot(root)).toThrow(/expected "grammar"/);
  });
});
