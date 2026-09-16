-- CreateEnum
CREATE TYPE "SubmissionStatus" AS ENUM ('draft', 'submitted');

-- CreateEnum
CREATE TYPE "ProcessingStatus" AS ENUM ('not_applicable', 'pending', 'processing', 'succeeded', 'failed_needs_review');

-- CreateTable
CREATE TABLE "Cohort" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Cohort_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Submission" (
    "id" TEXT NOT NULL,
    "cohortId" TEXT NOT NULL,
    "rollNumberRaw" TEXT NOT NULL,
    "rollNumberNormalized" TEXT NOT NULL,
    "studentName" TEXT NOT NULL,
    "status" "SubmissionStatus" NOT NULL DEFAULT 'draft',
    "contentVersion" TEXT NOT NULL,
    "answers" JSONB NOT NULL,
    "grammarScore" INTEGER,
    "vocabularyScore" INTEGER,
    "readingScore" INTEGER,
    "writingStatus" "ProcessingStatus" NOT NULL DEFAULT 'not_applicable',
    "writingCriteriaScores" JSONB,
    "writingOverallScore" INTEGER,
    "writingFeedback" JSONB,
    "problemsLikertAnswers" JSONB,
    "problemsOpenTextOriginal" TEXT,
    "problemsTextStatus" "ProcessingStatus" NOT NULL DEFAULT 'not_applicable',
    "problemsTextDerived" JSONB,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "submittedAt" TIMESTAMPTZ(3),

    CONSTRAINT "Submission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProcessingJob" (
    "id" TEXT NOT NULL,
    "submissionId" TEXT NOT NULL,
    "jobType" TEXT NOT NULL,
    "status" "ProcessingStatus" NOT NULL DEFAULT 'pending',
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "claimedAt" TIMESTAMPTZ(3),
    "nextAttemptAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMPTZ(3),

    CONSTRAINT "ProcessingJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StaffUser" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StaffUser_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Cohort_code_key" ON "Cohort"("code");

-- CreateIndex
CREATE INDEX "Submission_cohortId_idx" ON "Submission"("cohortId");

-- CreateIndex
CREATE INDEX "Submission_status_idx" ON "Submission"("status");

-- CreateIndex
CREATE UNIQUE INDEX "Submission_cohortId_rollNumberNormalized_key" ON "Submission"("cohortId", "rollNumberNormalized");

-- CreateIndex
CREATE INDEX "ProcessingJob_status_nextAttemptAt_idx" ON "ProcessingJob"("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "ProcessingJob_submissionId_idx" ON "ProcessingJob"("submissionId");

-- CreateIndex
CREATE UNIQUE INDEX "StaffUser_email_key" ON "StaffUser"("email");

-- AddForeignKey
ALTER TABLE "Submission" ADD CONSTRAINT "Submission_cohortId_fkey" FOREIGN KEY ("cohortId") REFERENCES "Cohort"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProcessingJob" ADD CONSTRAINT "ProcessingJob_submissionId_fkey" FOREIGN KEY ("submissionId") REFERENCES "Submission"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
