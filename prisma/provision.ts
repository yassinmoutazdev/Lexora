#!/usr/bin/env node
/**
 * Provisions a staff account against whatever `DATABASE_URL` points at.
 *
 * Run with `node prisma/provision.ts` — Node 24 strips the types, exactly as it does for
 * `prisma/seed.ts`, so this needs no transpiler and adds nothing to Section 2's dependency set.
 *
 * ## Why this exists, and why it is not the seed
 *
 * `prisma/seed.ts` is a development convenience: it writes a `PILOT-2026` cohort and a login whose
 * password defaults to `local-dev-password`, and its own comment says it is never part of a deploy.
 * That is correct, and it is also why a deployed instance had no staff account at all —
 * `render.yaml` runs `prisma migrate deploy` and nothing else, and no migration inserts data, so
 * production starts with an empty schema and no way in.
 *
 * FR-STAFF-002 settles how that gap is closed: *"Staff accounts must be created manually by the
 * team."* This is that manual step, made repeatable. It creates no cohort — cohorts are created
 * from the staff UI (`/staff/cohorts`), which is the whole reason that page exists.
 *
 * ## Why it reads `process.env.DATABASE_URL` directly instead of `src/config/env.ts`
 *
 * `env.ts` validates the *application's* whole configuration on import and throws unless every
 * variable is present — `SESSION_SECRET`, `OLLAMA_API_KEY`, and the rest. A provisioning tool has no
 * business needing any of those, and requiring them would mean exporting production secrets onto a
 * laptop to create one row.
 *
 * ## Why `@prisma/client` is imported dynamically, which is not a style choice
 *
 * **`@prisma/client` loads `.env` when it is imported.** Verified, not assumed: a bare `node`
 * process sees no `DATABASE_URL`, and one that imports this package sees the local one.
 *
 * A static `import { PrismaClient } from '@prisma/client'` is hoisted and evaluated before any
 * module body runs, so it would populate `DATABASE_URL` from the laptop's `.env` *before* the check
 * below could look at it — and the script would cheerfully target `lexora_dev` while appearing to
 * refuse. That is precisely the mistake this is meant to make impossible, and it was the script's
 * behaviour until it was tested.
 *
 * So the variable is read first and the client is pulled in afterwards. `import type` is erased
 * entirely by type-stripping and triggers no runtime load, which is what makes that possible while
 * keeping the types.
 *
 * ## Safety
 *
 * There are two guards, and they fail differently on purpose. The variable must be set before
 * anything can have loaded `.env`, so an un-set `DATABASE_URL` fails outright. And the target host
 * and database are printed and confirmed before a single row is written, because an explicit
 * connection string can still be the wrong one.
 *
 * The password is never echoed, never printed, and never passed as an argument — an argument would
 * land in shell history and in the process list.
 */

import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import type { PrismaClient } from '@prisma/client';
import { hashPassword } from '../src/auth/passwordHasher.ts';

/**
 * Below this, the password is called out.
 *
 * A warning rather than a refusal: the person running this is the account's owner and the decision
 * is theirs. But it is worth saying at the moment the credential is created rather than leaving it
 * to be noticed later, because this one password is the only thing between the internet and every
 * student's assessment data.
 */
const MINIMUM_COMFORTABLE_PASSWORD_LENGTH = 12;

const TERMINAL_RESET = '\u001b[0m';
const TERMINAL_BOLD = '\u001b[1m';

function fail(message: string): never {
  console.error(`\n[provision] ${message}\n`);
  process.exit(1);
}

/** The host and database the connection string names, with no credentials in it. */
function describeTarget(connectionString: string): string {
  try {
    const url = new URL(connectionString);

    return `${url.host}${url.pathname}`;
  } catch {
    // Not a URL this can parse — which is itself worth knowing before writing anything, but the
    // driver will give a better error than this can, so the raw shape is not printed.
    return '(unparseable connection string)';
  }
}

/**
 * Reads a line with the terminal's echo suppressed.
 *
 * `readline` has no hidden-input mode, so the output stream is muted for the duration. Restored in a
 * `finally` so an interrupt cannot leave a shell that prints nothing.
 */
async function askHidden(question: string): Promise<string> {
  const rl = createInterface({ input: stdin, output: stdout, terminal: true });
  const write = stdout.write.bind(stdout);

  process.stdout.write(question);
  (stdout as { write: unknown }).write = () => true;

  try {
    return (await rl.question('')).trim();
  } finally {
    (stdout as { write: unknown }).write = write;
    process.stdout.write('\n');
    rl.close();
  }
}

async function ask(question: string): Promise<string> {
  const rl = createInterface({ input: stdin, output: stdout });

  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

async function main(): Promise<void> {
  // Read before `@prisma/client` is loaded — see the header. This is the first thing `main` does
  // because a static import of the client elsewhere in this module would have already loaded `.env`
  // by the time the module body ran.
  const connectionString = process.env.DATABASE_URL;

  if (!connectionString) {
    fail(
      'DATABASE_URL is not set.\n' +
        '           This script reads only the environment it is given, so the target is always\n' +
        '           something you named on purpose. Point it at the database you mean:\n\n' +
        "             DATABASE_URL='postgresql://…' node prisma/provision.ts",
    );
  }

  const target = describeTarget(connectionString);

  console.log(`\n${TERMINAL_BOLD}Provision a staff account${TERMINAL_RESET}`);
  console.log(`  target database: ${target}\n`);

  const email = process.env.STAFF_EMAIL ?? (await ask('  Staff email: '));

  if (email.length === 0) fail('An email is required.');

  const password = process.env.STAFF_PASSWORD ?? (await askHidden('  Password (not shown): '));

  if (password.length === 0) fail('A password is required.');

  if (password.length < MINIMUM_COMFORTABLE_PASSWORD_LENGTH) {
    console.log(
      `\n  ${TERMINAL_BOLD}Note${TERMINAL_RESET}: that password is ${password.length} characters. ` +
        'This is the only\n  credential protecting every student record. Consider something longer.',
    );
  }

  const confirmed = await ask(`\n  Write this account to ${target}? (yes/no) `);

  if (confirmed.toLowerCase() !== 'yes') {
    console.log('\n[provision] cancelled — nothing was written.\n');
    return;
  }

  // Loaded here, after the target above has been read and confirmed, so that the client's own
  // `.env` load cannot influence which database this writes to.
  const { PrismaClient } = await import('@prisma/client');

  // The same wrapper `StaffAuthService` verifies against, so the hash cannot be produced at one
  // cost factor and checked at another — which is the failure mode `passwordHasher` exists to stop.
  const passwordHash = await hashPassword(password);
  const prisma = new PrismaClient({ datasources: { db: { url: connectionString } } });

  try {
    // Upserted by email, so re-running rotates the password rather than colliding — this is also
    // how a forgotten password is reset, which is the only recovery path there is.
    const staff = await prisma.staffUser.upsert({
      where: { email },
      update: { passwordHash },
      create: { email, passwordHash },
    });

    console.log(`\n[provision] staff account ready on ${target}`);
    console.log(`            email: ${staff.email}`);
    console.log('            (the password is not printed, and was not stored anywhere else)\n');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error('[provision] failed:', error);
  process.exitCode = 1;
});
