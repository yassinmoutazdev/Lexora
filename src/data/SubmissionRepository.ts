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
}

/** The process-wide repository instance. */
export const submissionRepository = new SubmissionRepository();
