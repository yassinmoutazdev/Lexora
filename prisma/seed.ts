import { PrismaClient } from '@prisma/client';
import { hashPassword } from '../src/auth/passwordHasher.ts';
import { env } from '../src/config/env.ts';

/**
 * Local development seed data (T2.3.1).
 *
 * Creates the minimum needed to exercise the app by hand: one cohort with an access code, and one
 * staff login. Both are upserted by their unique key, so running the seed repeatedly is safe and
 * never leaves duplicates behind.
 *
 * This is a development and testing convenience, not a provisioning mechanism. PRD FR-STAFF-002
 * requires staff accounts to be created manually by the team, and ARCHITECTURE Section 16 has
 * production run migrations only — this script is never part of a deploy.
 *
 * Note on password hashing: hashing goes through `src/auth/passwordHasher.ts`, the same wrapper
 * `StaffAuthService` verifies against (T3.1.2). The cost factor is decided there and nowhere else,
 * so a seeded login can never be hashed to a different standard than the one login checks for.
 */

const DEV_COHORT_CODE = 'PILOT-2026';
const DEV_STAFF_EMAIL = 'staff@lexora.test';

/**
 * Development-only default password.
 *
 * Overridable so a developer can seed a login of their own choosing without editing this file.
 * The value below is deliberately obvious rather than plausible — it is printed by the seed and
 * exists only so a fresh checkout has something to log in with.
 */
const DEV_STAFF_PASSWORD = process.env.SEED_STAFF_PASSWORD ?? 'local-dev-password';

async function main(): Promise<void> {
  // Explicitly DATABASE_URL, never DATABASE_URL_TEST: seeding the test database would be
  // pointless (the suite truncates it) and seeding the wrong one by accident is worth ruling out.
  const prisma = new PrismaClient({ datasources: { db: { url: env.DATABASE_URL } } });

  try {
    const cohort = await prisma.cohort.upsert({
      where: { code: DEV_COHORT_CODE },
      update: {},
      create: { code: DEV_COHORT_CODE, name: 'Pilot Cohort 2026' },
    });

    const passwordHash = await hashPassword(DEV_STAFF_PASSWORD);

    // The hash is re-derived on every run, so `update` refreshes it to match the currently
    // configured password rather than leaving a stale hash from an earlier seed.
    const staff = await prisma.staffUser.upsert({
      where: { email: DEV_STAFF_EMAIL },
      update: { passwordHash },
      create: { email: DEV_STAFF_EMAIL, passwordHash },
    });

    console.log('[seed] cohort ready:');
    console.log(`         access code: ${cohort.code}`);
    console.log(`         name:        ${cohort.name}`);
    console.log('[seed] staff login ready:');
    console.log(`         email:       ${staff.email}`);
    console.log(
      `         password:    ${DEV_STAFF_PASSWORD}` +
        (process.env.SEED_STAFF_PASSWORD
          ? ' (from SEED_STAFF_PASSWORD)'
          : ' (development default — set SEED_STAFF_PASSWORD to override)'),
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error('[seed] failed:', error);
  process.exitCode = 1;
});
