import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../config/env.ts';

/**
 * The raw-SQL scan (T9.3.3) — ARCHITECTURE Section 13: *"every database write goes through Prisma's
 * parameterized queries, so there is no raw SQL string concatenation anywhere in the codebase
 * (eliminates SQL injection as an attack surface by construction)."*
 *
 * ## Why this is a test and not a CI step
 *
 * T9.3.3's `Output:` asks for *"a CI check scanning for raw/unsafe query usage"*. There is no CI in
 * this repository — no `.github/`, no workflow file — so there is nowhere for a check to live except
 * where the suite already runs. Making it a test means it is enforced by `npm test`, which is what CI
 * would run anyway, and it cannot drift out of sync with the code the way a separately-configured
 * pipeline step can.
 *
 * ## What it looks for, and why not simply "Raw"
 *
 * A grep for `Raw` would be wrong in both directions, and both directions are present in this
 * codebase today:
 *
 * - **False positives.** `SubmissionRepository` and `ProcessingJobRepository` use `$queryRaw` and
 *   `$executeRaw` legitimately — the atomic `jsonb ||` section merge (Section 12) and the
 *   `FOR UPDATE SKIP LOCKED` job claim (Section 8) are statements no ORM builder expresses. Both are
 *   **tagged templates**, which is Prisma's parameterized form: the interpolated values become bind
 *   parameters, not text. Flagging them would flag the two queries the architecture specifically
 *   requires.
 * - **False negatives.** The unsafe variants are `$queryRawUnsafe` / `$executeRawUnsafe`, and a scan
 *   that only looked for the safe names would miss exactly the thing it exists to catch.
 *
 * So the rules are:
 *
 * 1. `$queryRawUnsafe(` / `$executeRawUnsafe(` are refused in production code. Two places in this
 *    repository legitimately need the unsafe form and both are test code, not production: `src/test/db.ts`
 *    truncates every table in the schema, discovered at runtime, so the table names *are* the query;
 *    and `SubmissionRepository.test.ts` inserts a row with a hand-written statement to prove Postgres
 *    — not Prisma — rejects the duplicate `(cohortId, rollNumberNormalized)`, which is Section 6's
 *    guarantee and cannot be shown through the ORM that is being bypassed. Neither is reachable from
 *    a request, which is why the scan's subject is production source: *"no raw SQL string
 *    concatenation anywhere in the codebase"* is a statement about the queries that serve users.
 * 2. `$queryRaw(` / `$executeRaw(` are refused *as calls*, in production code. These methods are safe
 *    as tagged templates and unsafe as functions — the call form takes a string, which is the shape
 *    concatenation arrives in. Writing the check this way distinguishes the two without needing to
 *    parse anything.
 *
 * ## On the tables being PascalCase and quoted
 *
 * Worth recording because a scanner written for the usual `snake_case` convention would look correct
 * and find nothing: this schema's tables are `"Submission"`, `"ProcessingJob"`, `"Cohort"` — Prisma's
 * default naming, quoted in every generated statement. This scan does not match on table names at
 * all, which is why it is not affected; anything that later does should not assume either case.
 */

/**
 * Test code is out of scope, by file location and by name.
 *
 * Both forms are excluded because "test file" is the property that matters here — a file that cannot
 * be reached by a request cannot be an injection surface — and a name-based allowlist of the two
 * files that need the unsafe form would have to be maintained as more database-level tests appear.
 */
function isTestCode(relativePath: string): boolean {
  return relativePath.startsWith('src/test/') || relativePath.endsWith('.test.ts');
}

/** Every production `.ts` file under `src/`, as paths relative to the repository root. */
function sourceFiles(): string[] {
  const found: string[] = [];

  const walk = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);

      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.ts')) found.push(full);
    }
  };

  walk(path.join(REPO_ROOT, 'src'));

  return found.map((file) => path.relative(REPO_ROOT, file).split(path.sep).join('/'));
}

/** Every `.ts` file under `src/`, test code included — used only by the complement assertions. */
function allSourceFiles(): string[] {
  const found: string[] = [];

  const walk = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);

      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.ts')) found.push(full);
    }
  };

  walk(path.join(REPO_ROOT, 'src'));

  return found.map((file) => path.relative(REPO_ROOT, file).split(path.sep).join('/'));
}

type Violation = { file: string; line: number; rule: string; text: string };

/** Scans the production source tree and returns every violation, rather than throwing on the first. */
function scan(): Violation[] {
  const violations: Violation[] = [];

  for (const relative of sourceFiles().filter((file) => !isTestCode(file))) {
    fs.readFileSync(path.join(REPO_ROOT, relative), 'utf8')
      .split('\n')
      .forEach((text, index) => {
        const line = index + 1;

        if (/\$(?:query|execute)RawUnsafe\s*\(/.test(text)) {
          violations.push({ file: relative, line, rule: 'unsafe raw query', text: text.trim() });
        }

        // The call form. The tagged-template form — `$queryRaw\`…\`` — is the parameterized one and
        // is deliberately not matched, which is also why this rule does not double-report the unsafe
        // variants above: after `Raw` they read `Unsafe(`, not `(`.
        if (/\$(?:query|execute)Raw\s*\(/.test(text)) {
          violations.push({ file: relative, line, rule: 'raw query as a call', text: text.trim() });
        }
      });
  }

  return violations;
}

describe('raw SQL scan (Section 13)', () => {
  it('finds no unsafe or non-parameterized query usage in production code', () => {
    const violations = scan();

    // Reported as a list rather than a boolean so a failure names every offending line at once
    // instead of one per run.
    expect(
      violations.map((violation) => `${violation.file}:${violation.line} [${violation.rule}] ${violation.text}`),
    ).toEqual([]);
  });

  it('scans code that actually contains raw queries, so a passing scan is not an empty one', () => {
    // The complement, and the reason the scan above means anything: a scan that walked no files, or
    // whose rules matched nothing recognisable, would pass identically. This pins the fact the rules
    // are built on — that parameterized tagged templates exist in production code and are correctly
    // *not* flagged — and the fact the exemption is load-bearing: the unsafe form does exist in this
    // repository, only ever in the test code the scan excludes.
    const production = sourceFiles()
      .filter((file) => !isTestCode(file))
      .map((file) => fs.readFileSync(path.join(REPO_ROOT, file), 'utf8'))
      .join('\n');

    const tests = allSourceFiles()
      .filter(isTestCode)
      .map((file) => fs.readFileSync(path.join(REPO_ROOT, file), 'utf8'))
      .join('\n');

    expect(production).toMatch(/\$queryRaw`/);
    expect(production).not.toMatch(/\$executeRawUnsafe/);
    expect(tests).toMatch(/\$executeRawUnsafe/);
  });
});
