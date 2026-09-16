import type { Submission } from '@prisma/client';
import { getPrismaClient } from './prismaClient.ts';

/**
 * Data access for `Submission` (ARCHITECTURE Section 18 — "Database access: src/data/*Repository.ts").
 *
 * This layer holds queries, not rules. It does not decide whether a student may start an
 * assessment, whether a draft is complete, or what a roll number should normalize to — those are
 * domain decisions that live in `src/domain/`. In particular it deliberately takes
 * `rollNumberNormalized` as a *given* rather than computing it from `rollNumberRaw`, so
 * normalization has exactly one implementation (`StudentIdentityService`, T3.2.1) instead of two
 * that could drift apart.
 *
 * The class is a thin handle over the shared client rather than a connection owner: every method
 * resolves the process-wide Prisma client lazily, so constructing a repository is free and no
 * second connection pool is ever opened.
 */

export type CreateDraftInput = {
  cohortId: string;
  /** As typed by the student, preserved for display. */
  rollNumberRaw: string;
  /** Trimmed + lowercased by the caller; the uniqueness/lookup key. */
  rollNumberNormalized: string;
  studentName: string;
  /** Frozen at draft creation from `ContentLoader.getCurrentVersion()`. */
  contentVersion: string;
};

export class SubmissionRepository {
  /** Looks a submission up by primary key. Returns null rather than throwing when absent. */
  async findById(id: string): Promise<Submission | null> {
    return getPrismaClient().submission.findUnique({ where: { id } });
  }

  /**
   * The identity lookup — one submission per cohort + normalized roll number (FR-STU-005/007).
   *
   * `findUnique` is used rather than `findFirst` because `@@unique([cohortId,
   * rollNumberNormalized])` makes this a genuine unique lookup, which is what lets the database
   * guarantee at most one row is returned under any interleaving.
   */
  async findByCohortAndRollNumber(
    cohortId: string,
    rollNumberNormalized: string,
  ): Promise<Submission | null> {
    return getPrismaClient().submission.findUnique({
      where: { cohortId_rollNumberNormalized: { cohortId, rollNumberNormalized } },
    });
  }

  /**
   * Creates an empty draft.
   *
   * `answers` starts as `{}` — the section-keyed shape (Section 12) with no section filled in
   * yet. New drafts start under `status='draft'` and the `writingStatus`/`problemsTextStatus`
   * defaults from the schema, so nothing else needs to be set here.
   */
  async createDraft(input: CreateDraftInput): Promise<Submission> {
    return getPrismaClient().submission.create({
      data: {
        cohortId: input.cohortId,
        rollNumberRaw: input.rollNumberRaw,
        rollNumberNormalized: input.rollNumberNormalized,
        studentName: input.studentName,
        contentVersion: input.contentVersion,
        answers: {},
      },
    });
  }

  /**
   * Creates a draft, or returns the row that already exists for the same identity.
   *
   * This exists so the caller can be a *find-or-create* without knowing how the "or" is spelled.
   * `createDraft` alone would be enough for every request that arrives after the first, but two
   * requests that arrive together — a student double-clicking "Start", or two tabs opened from the
   * same entry page — both find nothing and both insert. Postgres rejects the second with a unique
   * violation on `@@unique([cohortId, rollNumberNormalized])`, which is the guarantee; without
   * this method that rejection would surface as a 500 on a legitimate first visit.
   *
   * The unique-violation code is read structurally rather than by importing Prisma's error class,
   * so this stays a check on the constraint rather than a dependency on a runtime subpath.
   *
   * If the violation turns out not to be this constraint, or the row cannot be re-read, the
   * original error is rethrown — swallowing it would hide a genuine failure behind a retry.
   */
  async createDraftIfAbsent(input: CreateDraftInput): Promise<Submission> {
    try {
      return await this.createDraft(input);
    } catch (error) {
      if (!isUniqueConstraintViolation(error)) throw error;

      const existing = await this.findByCohortAndRollNumber(
        input.cohortId,
        input.rollNumberNormalized,
      );

      if (!existing) throw error;

      return existing;
    }
  }
}

/** Whether an error is Postgres' unique-constraint violation as Prisma reports it. */
function isUniqueConstraintViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'P2002'
  );
}

/** The process-wide repository instance. */
export const submissionRepository = new SubmissionRepository();
