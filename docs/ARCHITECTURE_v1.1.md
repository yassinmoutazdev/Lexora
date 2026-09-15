# Architecture Document

## English-Language Assessment & Diagnostic Pilot

**App:** A web application that delivers a single five-section English assessment (Grammar, Vocabulary, Reading, Writing, Student Problems) to a small pilot cohort of university students with no accounts, scores it (deterministically for the first three sections, via LLM rubric for Writing), and gives staff a simple internal dashboard for aggregate analysis and export.
**Version:** 1.1 (MVP — Implementation-Readiness Revision)
**Platform:** Web (browser-based, student and staff)
**Architecture Pattern:** Layered monolith (Presentation → API → Domain/Application Services → Data Access → Core Services), single deployable
**Document Status:** Implementation-Ready
**Last Updated:** 2026-09-15

### Revision note (v1.0 → v1.1)

v1.0 was broadly approved but contained implementation-blocking gaps: a job/worker code path that referenced fields the schema didn't have, an unimplementable content-versioning story, an autosave design that could silently drop answers under multi-tab use, inconsistent session terminology, one endpoint that wasn't justified by the PRD, an unconcretized logging claim, and provider assumptions stated as facts rather than as-of-now claims. This revision resolves each of those without adding infrastructure, features, or scope beyond the approved MVP. No section not listed here changed in substance.

---

## 1. System Overview

### High-Level Description

The system is a single Node.js/TypeScript web application serving a React frontend and a REST API from one process, backed by a single PostgreSQL database. Students authenticate implicitly via cohort code + roll number + name (no accounts); staff authenticate via email/password. Grammar, Vocabulary, and Reading are scored deterministically at submission time; Writing is scored by an LLM (Ollama Cloud) through a database-backed job queue processed by a single in-process worker loop, reflecting the provider's own single-concurrency free-tier limit. The entire system is designed to run at $0/month on Render (application) and Supabase (PostgreSQL), which is only possible because the pilot's scale (tens to a few hundred students, two staff members) does not require anything more than a single small server and a single small database.

### Core Responsibilities

| Responsibility | Details |
|---|---|
| Student identity resolution | Verify cohort code + normalized roll number + name against stored records; never rely on URLs or exposed IDs for access |
| Assessment delivery | Serve fixed, version-controlled question content; accept draft answers; enforce section order is browsable, not enforced strictly (backward navigation allowed) |
| Draft persistence | Autosave in-progress answers per student identity, at section granularity; support multi-tab/multi-device access to the same draft without unrelated sections overwriting each other |
| Submission finalization | Atomically and idempotently transition a draft to an immutable submission; enforce one submission per cohort+roll |
| Deterministic scoring | Score Grammar/Vocabulary/Reading immediately at submission using the version-controlled answer keys captured under the submission's `contentVersion` |
| AI-assisted scoring | Evaluate Writing responses via a rubric-constrained LLM call, validate structured output, deterministically compute the final score from criteria + externalized weights, both versioned with the same `contentVersion` |
| Background job processing | Serially process Writing and Student Problems AI jobs against Ollama Cloud's single-concurrency free tier, with bounded retries and explicit failure states; jobs read authoritative input from the `Submission` row, not from job-local copies |
| Staff analysis | Provide authenticated staff with aggregate dashboards, individual submission viewing, and CSV export |
| Data integrity & privacy | Preserve original student responses unconditionally; keep AI-derived data separate and clearly labeled; restrict all personal/academic data to authorized staff |

### Key Constraints

> These constraints are non-negotiable. Every architectural decision below is made in service of satisfying them. If a proposed implementation conflicts with a constraint, the implementation changes, not the constraint.

- **Web-only, online-only** — no offline support, no native app; every feature assumes an active connection.
- **$0 infrastructure** — Render free web service + Supabase free Postgres + Ollama Cloud free tier. No paid add-ons. (Section 16 states the current provider behavior this depends on, and flags it as verify-at-implementation-time rather than a permanent guarantee.)
- **Small pilot scale** — tens to a few hundred students, two staff members. No architecture decision may be justified by hypothetical scale beyond this.
- **Ollama Cloud free tier: single concurrent request** — the free tier processes one cloud request at a time with unpublished daily/weekly quotas and no SLA. Background AI processing must be serial, not parallelized.
- **No student accounts.** Identity is cohort + normalized roll number, with name as supporting information — there is no password and no persistent login. What *does* exist is a **short-lived student session**: after identity verification succeeds, the server issues a session cookie scoped to that one submission. That session — not a new concept, not a separate mechanism — is what authorizes both the assessment-taking flow and the report-viewing flow during the active access period (see Section 9). "No accounts" and "a session exists" are not in tension: the session is a scoped, temporary access grant, never a credentialed account.
- **Immutability after submission is server-enforced** — the browser is never trusted to enforce this.
- **Rubric weights are not finalized** — the Writing scoring formula must read weights from configuration, never from hardcoded logic.
- **No CMS** — assessment content lives in version-controlled files, not a database-backed editor. Historical submissions must remain interpretable against the content/rubric version they were taken under (Section 2, Section 6).

### Layer Responsibilities

**Presentation Layer (React SPA)** — owns rendering, client-side form state (in-flight keystrokes before an autosave fires), and navigation between assessment sections. Never decides whether a submission is valid, never computes scores, never determines whether AI processing succeeded — it only displays state the server has already computed.

**API Layer (Express routes)** — owns request validation (shape/type), authentication/session handling, and translating HTTP requests into calls on Application Services. Never contains scoring logic or SQL directly.

**Application/Domain Services Layer** — owns all business rules: submission finalization, deterministic scoring, Writing score calculation, job lifecycle transitions, authorization checks. Framework-agnostic; does not import Express types or React. This is the single home for every rule the PRD treats as a hard invariant.

**Data Access Layer (Prisma repositories)** — owns all database reads/writes and transaction boundaries. Never contains business rules beyond what the schema itself enforces (constraints, uniqueness). This layer is also the **only** place that assembles the authoritative input a background job needs (Section 8) — a job never carries a private copy of that data.

**Core Services Layer** — owns integration with the outside world: the `AIEvaluationService` (and its `OllamaProvider` implementation), the content loader (reads version-controlled JSON, keyed by content version — Section 2), the password hasher, and the session/cookie mechanism. Exposes narrow interfaces upward; the Domain layer depends on these interfaces, never on `ollama`-specific types.

**Dependency direction:** Presentation → API → Domain → Data Access / Core Services. Domain services depend only on interfaces (`AIEvaluationService`, repository interfaces), never on concrete implementations, so the Ollama provider or the ORM could be swapped without touching business logic.

---

## 2. Dependencies

| Package | Purpose | Version Constraint |
|---|---|---|
| `express` | HTTP server and routing for the API layer | `^4.19` |
| `react` / `react-dom` | Frontend UI | `^18.3` |
| `vite` | Frontend build tool, bundles the SPA served by Express | `^5.4` |
| `@prisma/client` + `prisma` | Type-safe database access and migrations against PostgreSQL | `^5.19` |
| `zod` | Runtime schema validation — API request bodies, LLM structured output, **and** versioned content files at boot | `^3.23` |
| `bcrypt` | Staff password hashing | `^5.1` |
| `cookie-session` (or `express-session` with a Postgres-backed store) | Staff and student sessions | `^2.1` |
| `csv-stringify` | Streaming CSV export for the staff dashboard | `^6.5` |
| `dotenv` | Environment variable loading in local development | `^16.4` |
| `pino` | Structured logging (stdout, captured by Render), including staff data-access log lines (Section 13) | `^9.4` |

**Dev dependencies:**

| Package | Purpose |
|---|---|
| `typescript` | Static typing across frontend and backend |
| `vitest` | Unit and integration testing |
| `supertest` | API endpoint testing |
| `prisma` (CLI) | Migration generation |
| `@types/*` | Type definitions for Node/Express |

**Dependency decisions to document:**

- **Prisma over a raw query builder:** the schema is small (seven tables) and migration safety matters more than query flexibility here — Prisma's migration history gives a clear audit trail for the pilot's schema evolution.
- **`zod` for API, LLM, and content validation:** using one validation library for three different untrusted/external-input boundaries (HTTP bodies, LLM JSON output, versioned content JSON files) avoids maintaining multiple validation idioms in a small codebase.
- **No ORM-level job queue library (e.g., BullMQ):** deliberately omitted. BullMQ requires Redis, which is a paid or self-managed dependency this project has no other use for. A `processing_jobs` table plus a single poll loop is sufficient at this scale and matches Ollama's own single-concurrency limit — see Section 8.
- **`cookie-session`/Postgres-backed sessions over a third-party auth provider:** two staff accounts and no-account student access don't justify an external auth service (e.g., Auth0); it would add a paid dependency for a problem solved in under 100 lines.
- **No frontend state library (Redux/Zustand):** the frontend has no complex cross-cutting state — React's built-in state plus data-fetching hooks are sufficient (see Section 5).
- **No separate audit-log table:** staff access to individual submissions is recorded via structured application logs (`pino`), not a new database entity — see Section 13. A dedicated audit subsystem was considered and rejected as unjustified by the PRD's actual security requirement.

---

## 3. Architecture Diagram

### System Diagram

```
┌────────────────────────────────────────────────────────────────────┐
│                            BROWSER                                  │
│   Student flow (no account)         Staff flow (email/password)     │
│   React SPA — static bundle served by the same origin as the API    │
└───────────────────────────────┬──────────────────────────────────────┘
                                 │  HTTPS (JSON over REST)
┌────────────────────────────────▼──────────────────────────────────────┐
│                     NODE.JS APPLICATION (Render)                     │
│                                                                        │
│  ┌───────────────── API LAYER (Express routes) ─────────────────┐    │
│  │ /api/student/*   /api/staff/*   /api/session/*                │    │
│  └───────────────────────────┬────────────────────────────────────┘  │
│                               │                                       │
│  ┌───────────────── DOMAIN / APPLICATION SERVICES ───────────────┐   │
│  │ SubmissionService  ScoringService  WritingScoreCalculator      │   │
│  │ StudentIdentityService  StaffAuthService  DashboardService     │   │
│  └──────────┬───────────────────────────────────┬─────────────────┘  │
│             │                                    │                    │
│  ┌──────────▼────────────┐          ┌────────────▼─────────────────┐ │
│  │  DATA ACCESS (Prisma)  │          │      CORE SERVICES            │ │
│  │  Repositories per      │          │  AIEvaluationService (iface)  │ │
│  │  entity, transactions  │          │   └─ OllamaProvider           │ │
│  │  incl. evaluation-     │          │  ContentLoader (versioned     │ │
│  │  context assembly      │          │   JSON, keyed by version)     │ │
│  │  for background jobs   │          │  PasswordHasher / Sessions    │ │
│  └──────────┬─────────────┘          └───────────────┬────────────────┘ │
│             │                                        │                    │
│  ┌──────────▼──────────────────────────────────────────────────────┐  │
│  │      BACKGROUND WORKER LOOP (in-process, single instance)       │  │
│  │  polls processing_jobs → claims one → loads evaluation context  │  │
│  │  from Submission via repository → calls AIEvaluationService     │  │
│  │  → validates output → writes result transactionally              │  │
│  └────────────────────────────────────────────────────────────────┘  │
└─────────────┬───────────────────────────────────────┬─────────────────┘
              │                                        │
┌─────────────▼─────────────┐            ┌─────────────▼─────────────────┐
│  PostgreSQL (Supabase)     │            │  Ollama Cloud (free tier)      │
│  submissions, jobs, staff, │            │  1 concurrent request,         │
│  answers, AI results       │            │  server-side API key only      │
└────────────────────────────┘            └─────────────────────────────────┘
```

### Data Flow: Student Submits the Assessment

```
Student clicks "Submit"
         │
         ▼
POST /api/student/submit  (API layer — validates shape, resolves session)
         │
         ▼
SubmissionService.finalize(submissionId)
         │  BEGIN TRANSACTION
         │  SELECT submission WHERE id = :submissionId FOR UPDATE
         │  ├─ if status = 'submitted' → return existing report (idempotent no-op)
         │  ├─ if required sections incomplete → reject with validation error
         │  └─ else:
         │      content = ContentLoader.getContent(submission.contentVersion)
         │      ScoringService.scoreDeterministicSections(submission.answers, content)
         │      UPDATE submissions SET status='submitted',
         │             deterministic_scores=..., submitted_at=now()
         │             -- answers is already the frozen record; no further writes to it occur
         │             -- once status != 'draft' (enforced by the autosave endpoint, Section 12)
         │      INSERT processing_jobs (job_type='writing_eval', submission_id, status='pending')
         │      INSERT processing_jobs (job_type='student_problems_text', ...) IF open text present
         │  COMMIT
         ▼
Response: submission report (deterministic results ready; writing status = 'pending')
         │
         ▼ (asynchronously, independent of the HTTP request)
Background worker loop claims the 'writing_eval' job on its next poll tick
```

### Data Flow: Background Writing Evaluation

```
Worker loop tick (every ~7s)
         │
         ▼
JobService.claimNextJob()
         │  UPDATE processing_jobs SET status='processing', claimed_at=now()
         │  WHERE id = (SELECT id FROM processing_jobs
         │              WHERE status='pending' OR (status='processing' AND claimed_at < stale_threshold)
         │              ORDER BY created_at ASC LIMIT 1 FOR UPDATE SKIP LOCKED)
         │  RETURNING job   -- job = { id, submissionId, jobType, attemptCount, ... } — NO response text, NO rubric
         ▼
SubmissionRepository.getEvaluationContext(job.submissionId, job.jobType)
         │  Reads the ONE authoritative Submission row and returns exactly what
         │  the given jobType needs (see Section 8 for the exact shape):
         │    writing_eval          → { responseText, contentVersion }
         │    student_problems_text → { originalText, contentVersion }
         │  The job table is never the source of this data — the Submission row is.
         ▼
content = ContentLoader.getContent(context.contentVersion)
         │  Resolves the writing prompt, the LLM rubric-instruction text, and the
         │  rubric weights that were frozen at submission time — NOT whatever the
         │  repo's current content happens to be (Section 2).
         ▼
AIEvaluationService.evaluateWriting(context.responseText, content.writingRubricInstructions)
         │  OllamaProvider builds the fixed rubric prompt, requests structured JSON,
         │  calls Ollama Cloud (single in-flight request, timeout enforced)
         ▼
zod schema validates the JSON response
         ├─ invalid / malformed → throw AIValidationError
         ├─ network/timeout error → throw AIRetryableError
         └─ valid → criterion-level scores returned
         ▼
WritingScoreCalculator.computeOverallScore(criteriaScores, content.writingRubricWeights)
         ▼
BEGIN TRANSACTION
  UPDATE submissions SET writing_evaluation = {...}, writing_status='succeeded'
  UPDATE processing_jobs SET status='succeeded', completed_at=now()
COMMIT
         │
         ▼ (on failure instead)
retry_count += 1
  ├─ retry_count < max_retries AND error is retryable → status back to 'pending' (delayed via next_attempt_at)
  └─ else → status='failed_needs_review', submissions.writing_status='failed_needs_review', original response left untouched
```

---

## 4. Project Structure

```
repo/
├── package.json
├── tsconfig.json
├── prisma/
│   ├── schema.prisma
│   └── migrations/
│
├── content/                                # Version-controlled assessment content — no CMS
│   ├── current-version.json                # { "version": "v1" } — which version NEW drafts start under
│   └── versions/
│       └── v1/                             # Immutable once referenced by any submission (Section 2)
│           ├── grammar-questions.json
│           ├── vocabulary-questions.json
│           ├── reading-questions.json
│           ├── writing-prompt.json
│           ├── writing-rubric.json         # LLM rubric instructions + externalized scoring weights (NOT hardcoded)
│           └── student-problems-statements.json
│       # A future content change adds versions/v2/ alongside v1/ — v1/ is never edited or deleted
│       # while any submission still references it (Section 2).
│
├── src/
│   ├── server.ts                     # App entrypoint: starts Express + the worker loop
│   ├── app.ts                        # Express app assembly, middleware, route mounting
│   │
│   ├── api/                          # API LAYER — routes/controllers only
│   │   ├── student.routes.ts         # /api/student/*
│   │   ├── staff.routes.ts           # /api/staff/*
│   │   ├── session.routes.ts         # login/logout, identity verification
│   │   └── middleware/
│   │       ├── requireStaffSession.ts
│   │       ├── requireStudentSession.ts
│   │       └── validateBody.ts       # zod-based request validation
│   │
│   ├── domain/                       # DOMAIN / APPLICATION SERVICES — all business rules
│   │   ├── submission/
│   │   │   ├── SubmissionService.ts
│   │   │   └── SubmissionService.test.ts
│   │   ├── scoring/
│   │   │   ├── DeterministicScoringService.ts
│   │   │   ├── WritingScoreCalculator.ts
│   │   │   └── *.test.ts
│   │   ├── identity/
│   │   │   └── StudentIdentityService.ts
│   │   ├── staff/
│   │   │   ├── StaffAuthService.ts
│   │   │   └── DashboardService.ts
│   │   └── jobs/
│   │       └── JobService.ts         # claim/complete/fail job lifecycle rules
│   │
│   ├── ai/                           # CORE SERVICE — AI abstraction boundary
│   │   ├── AIEvaluationService.ts    # Interface: evaluateWriting(text, rubricInstructions), processStudentProblemsText(text)
│   │   ├── OllamaProvider.ts         # Implementation — the ONLY file that knows about Ollama
│   │   ├── schemas.ts                # zod schemas for expected LLM JSON output
│   │   └── errors.ts                 # AIValidationError, AIRetryableError, AINonRetryableError
│   │
│   ├── background/
│   │   └── workerLoop.ts             # setInterval poll loop; wires JobService + AIEvaluationService
│   │
│   ├── content/
│   │   ├── ContentLoader.ts          # Loads ALL versions under content/versions/* at boot; getContent(version), getCurrentVersion()
│   │   └── contentSchemas.ts         # zod schemas each version bundle is validated against at boot
│   │
│   ├── data/                         # DATA ACCESS LAYER — Prisma repositories
│   │   ├── prismaClient.ts
│   │   ├── SubmissionRepository.ts   # incl. getEvaluationContext(submissionId, jobType) — see Section 8
│   │   ├── ProcessingJobRepository.ts
│   │   └── StaffRepository.ts
│   │
│   ├── auth/
│   │   ├── passwordHasher.ts         # bcrypt wrapper
│   │   └── session.ts                # cookie/session configuration (staff session + student session)
│   │
│   └── shared/
│       └── types/                    # Types/schemas shared between API and frontend (e.g. via a shared package or re-exported .d.ts)
│
└── frontend/
    ├── index.html
    ├── vite.config.ts
    └── src/
        ├── main.tsx
        ├── App.tsx                   # Router
        ├── pages/
        │   ├── student/
        │   │   ├── EntryPage.tsx           # cohort code + roll + name
        │   │   ├── AssessmentPage.tsx      # section-by-section flow
        │   │   └── ReportPage.tsx          # deterministic + writing status
        │   └── staff/
        │       ├── LoginPage.tsx
        │       ├── DashboardPage.tsx
        │       └── SubmissionDetailPage.tsx
        ├── components/                     # Shared, feature-agnostic UI pieces
        ├── api/
        │   └── client.ts                   # fetch wrapper, typed against shared schemas
        └── hooks/
            └── useAutosave.ts               # debounced PATCH of the CURRENT SECTION ONLY to the draft endpoint (Section 12)
```

---

## 5. State Management Strategy

There are no ViewModels or a mobile-style state-management framework here — the split is simply **server state vs. transient UI state**.

**Backend (source of truth for everything durable):**
- The database is authoritative for draft answers, submission status, scores, and job status. The API layer never trusts client-sent state for anything that affects persistence beyond "these are the answers the student just typed in the section they're on."
- Every mutating endpoint re-derives the current state from the database before acting (see the `SELECT ... FOR UPDATE` pattern in Section 3), so the frontend's view of "am I submitted yet?" is always re-confirmed server-side, not assumed from client memory.

**Frontend:**
- **Local component state** (`useState`) for in-progress keystrokes in the currently visible section, before an autosave fires.
- **A single `useAutosave` hook** debounces changes (e.g., 1.5s after the last keystroke, or on blur/section-navigation) and `PATCH`es the draft endpoint **with only the currently active section's answers** (Section 12) — it never sends the full `answers` object. It tracks a simple `idle | saving | saved | error` status shown unobtrusively in the UI — never blocking navigation.
- **No global client store.** Each page fetches what it needs from the API on mount (`EntryPage` → identity verification; `AssessmentPage` → current draft + content for the draft's `contentVersion`; `ReportPage` → current submission state, polled every ~10s only while `writingStatus = 'pending'` to reflect background completion without the student refreshing manually; `DashboardPage` → aggregate queries on load and on filter change).
- Because the backend is authoritative and drafts are keyed by student identity (via the student session, Section 9) rather than browser storage, opening the same student's assessment in a second tab or device just re-fetches the same server-side draft. Section-level autosave (Section 12) means two tabs open on different sections do not need any client-side sync logic to avoid clobbering each other.

---

## 6. Database Design

PostgreSQL via Supabase. All primary keys are UUIDs (`gen_random_uuid()`). All timestamps are `timestamptz`.

```prisma
enum SubmissionStatus {
  draft
  submitted
}

enum ProcessingStatus {
  not_applicable        // e.g., no open-text Student Problems response was given
  pending
  processing
  succeeded
  failed_needs_review
}

model Cohort {
  id          String   @id @default(uuid())
  code        String   @unique              // student-entered access code
  name        String
  createdAt   DateTime @default(now())

  submissions Submission[]
}

model Submission {
  id                     String            @id @default(uuid())
  cohortId               String
  cohort                 Cohort            @relation(fields: [cohortId], references: [id])
  rollNumberRaw          String            // as typed, preserved for display
  rollNumberNormalized   String            // trimmed + lowercased, used for the uniqueness/lookup key
  studentName            String

  status                 SubmissionStatus  @default(draft)

  // Captured once, at draft creation, from ContentLoader.getCurrentVersion(); frozen for the
  // life of the submission. Governs question content, the writing prompt, the LLM rubric
  // instructions, AND the rubric weights (Section 2) — one version tag covers the entire
  // content bundle, so there is no separate "rubric version" that could drift out of sync
  // with the question version.
  contentVersion         String

  // Draft / answer data — keyed by section, which is also the autosave PATCH unit (Section 12)
  answers                Json              // { grammar: {...}, vocabulary: {...}, reading: {...}, writing: {...}, studentProblems: {...} }

  // Deterministic results (computed at submission time)
  grammarScore           Int?
  vocabularyScore        Int?
  readingScore           Int?

  // Writing (AI-assisted, computed by the background worker)
  writingStatus          ProcessingStatus  @default(not_applicable)
  writingCriteriaScores  Json?             // { grammarAccuracy, vocabulary, sentenceStructure, coherence, taskCompletion }
  writingOverallScore    Int?              // deterministically computed 0-100 by WritingScoreCalculator
  writingFeedback        Json?             // strengths, weaknesses, corrections, suggestions

  // Student Problems — original vs. derived, kept strictly separate
  problemsLikertAnswers      Json?         // { statementId: 1-5, ... }
  problemsOpenTextOriginal   String?       // authoritative, written exactly once at submission, never overwritten
  problemsTextStatus         ProcessingStatus @default(not_applicable)
  problemsTextDerived        Json?         // { normalizedText, categories: [...] } — explicitly derived data

  createdAt              DateTime  @default(now())
  updatedAt              DateTime  @updatedAt
  submittedAt             DateTime?

  jobs                   ProcessingJob[]

  @@unique([cohortId, rollNumberNormalized])
  @@index([cohortId])
  @@index([status])
}

// Deliberately thin: identifies WHICH work to do, not the data itself. The worker resolves
// the actual response text / content / rubric it needs by reading the Submission row via
// SubmissionRepository.getEvaluationContext() (Section 8) — never from a field on this model.
model ProcessingJob {
  id             String            @id @default(uuid())
  submissionId   String
  submission     Submission        @relation(fields: [submissionId], references: [id])
  jobType        String            // 'writing_eval' | 'student_problems_text'
  status         ProcessingStatus  @default(pending)
  attemptCount   Int               @default(0)
  lastError      String?
  claimedAt      DateTime?
  nextAttemptAt  DateTime          @default(now())
  createdAt      DateTime          @default(now())
  completedAt    DateTime?

  @@index([status, nextAttemptAt])
  @@index([submissionId])
}

model StaffUser {
  id            String   @id @default(uuid())
  email         String   @unique
  passwordHash  String
  createdAt     DateTime @default(now())
}
```

**Why these choices:**

- **`@@unique([cohortId, rollNumberNormalized])`** is the database-level enforcement of "exactly one submission per cohort + roll number" (FR-STU-007, EDGE-003). This is not just an application check — Postgres rejects a second `INSERT` even under a race condition, which is the guarantee application code alone cannot provide.
- **`rollNumberRaw` vs. `rollNumberNormalized`** — the normalized column is what uniqueness and lookups key on (trimmed, lowercased), while the raw value is preserved for display and staff review, since normalization is a technical concern, not something that should silently alter what's shown back to a student.
- **`answers` as JSONB, keyed by section,** rather than a fully normalized per-question-answer table — at pilot scale (fixed question set, no per-question querying requirement beyond "show me this student's answers"), a normalized answers table would add migration and query overhead with no realistic benefit. The section-keyed shape is also exactly what the section-level autosave merge (Section 12) operates on. If per-question analytics become a real requirement later, this is a deliberate, documented extension point (Section 17), not a gap.
- **`problemsOpenTextOriginal` and `problemsTextDerived` as separate columns** directly implements NFR-PRIV-005/FR-PROB-009/010/011: the original can never be overwritten by a later AI write, because the AI job only ever writes to `problemsTextDerived`.
- **`ProcessingJob` as its own table, not just a status column on `Submission`** — a submission can have two independent AI jobs (writing, Student Problems text) that succeed/fail independently (FR-WRITE-011 vs. FR-PROB-013 are separate failure modes), and the job table also needs its own retry/attempt/claim bookkeeping that doesn't belong on the submission record itself. The job table intentionally does **not** duplicate response text or rubric content (see the model comment above and Section 8) — `submissionId` is the only link it needs, and the Submission row plus `ContentLoader` remain the single source of truth for what gets evaluated and against what rubric.
- **A single `contentVersion`, not a separate `writingRubricVersion`:** the rubric weights and instructions live inside the same versioned content bundle as the questions (Section 2), so one tag is sufficient and there is no way for a submission's question version and rubric version to silently drift apart.
- **Indexes:** `[status, nextAttemptAt]` on `ProcessingJob` is the exact index the worker loop's claim query needs; `[cohortId]` and `[status]` on `Submission` support the staff dashboard's cohort filter and completion-status views, the two most frequent staff queries.

**Transaction boundaries:** (1) submission finalization (Section 3) — read-check-write of the submission plus insertion of its processing jobs, one transaction; (2) section-level autosave — one atomic `UPDATE` per request (Section 12), no read-modify-write race; (3) job claiming — the `UPDATE ... SKIP LOCKED` claim, one transaction; (4) job completion — writing the AI result to `Submission` and marking the `ProcessingJob` succeeded, one transaction, so a crash between "wrote the score" and "marked the job done" cannot happen.

---

## 7. Assessment / Domain-Critical Engines

**`DeterministicScoringService`** (`src/domain/scoring/DeterministicScoringService.ts`)
Input: a student's `answers.grammar/vocabulary/reading` plus the loaded content (`ContentLoader.getContent(submission.contentVersion)`) for the content version the submission was taken under. For each question, compares the student's answer to the content's `correctAnswer`, looks up the `prewrittenExplanation`, and sums section scores. Pure function of (answers, content) — no side effects, fully unit-testable without a database.

**`WritingScoreCalculator`** (`src/domain/scoring/WritingScoreCalculator.ts`)
Input: the five criterion-level scores returned (and already schema-validated) from the LLM, plus the `writingRubricWeights` from the same versioned content bundle (`ContentLoader.getContent(submission.contentVersion)`) used to build the prompt. Output: a single 0–100 overall score via a fixed weighted-sum formula. This is the **only** place the weighting formula is implemented — the AI provider never computes a score, only criterion judgments. Because weights are read from the versioned content bundle at call time (never compiled in), updating the rubric weighting is a content change (a new version), not a code change, and this function's unit tests can assert the formula's behavior against fixture weights independent of the real (TBD) values.

**`SubmissionService.finalize()`** (`src/domain/submission/SubmissionService.ts`)
The single canonical implementation of submission finalization (Section 3's data flow). Every invariant in Section 12 that concerns "what happens at submit time" is implemented exactly once here — the API route never contains this logic, and there is no second code path that finalizes a submission differently.

**`JobService`** (`src/domain/jobs/JobService.ts`)
Owns job claiming, success/failure transitions, retry-count bookkeeping, and stale-job reclamation (Section 8). The background worker loop is the **only** caller — there is no staff-facing manual retry path (Section 10 explains why one isn't included), so retry behavior has exactly one entry point.

**Report generation** is not a separate persisted artifact — the `ReportPage`/`/api/student/report` endpoint simply reads the current `Submission` row and shapes it into a response (deterministic sections always populated once `status='submitted'`; `writing*` fields populated once `writingStatus='succeeded'`). There is no separate "report" entity to keep in sync with the submission, by design.

---

## 8. Background Processing

**Model:** a single `processing_jobs` table (Section 6) plus **one** in-process poll loop, started alongside the Express server in `server.ts` and run for the lifetime of the process.

**What a job contains vs. what the worker resolves at run time:** a `ProcessingJob` row identifies *which submission* and *which kind of work* — nothing more. All authoritative input the worker needs is resolved fresh, at claim time, from `Submission` (via `SubmissionRepository`) and from `ContentLoader` (keyed by that submission's frozen `contentVersion`). This is deliberate: it means the job table can never hold a stale or divergent copy of the response text or rubric, and a submission's data has exactly one place it lives.

```ts
// src/data/SubmissionRepository.ts (illustrative)
type EvaluationContext =
  | { jobType: 'writing_eval'; responseText: string; contentVersion: string }
  | { jobType: 'student_problems_text'; responseText: string; contentVersion: string };

async function getEvaluationContext(submissionId: string, jobType: string): Promise<EvaluationContext> {
  const submission = await prisma.submission.findUniqueOrThrow({ where: { id: submissionId } });
  if (jobType === 'writing_eval') {
    return { jobType, responseText: (submission.answers as any).writing.essayText, contentVersion: submission.contentVersion };
  }
  return { jobType, responseText: submission.problemsOpenTextOriginal!, contentVersion: submission.contentVersion };
}
```

```ts
// src/background/workerLoop.ts (illustrative)
const POLL_INTERVAL_MS = 7_000;
const STALE_THRESHOLD_MS = 5 * 60_000; // a job claimed >5 min ago and never completed is stalled
const MAX_ATTEMPTS = 3;

async function tick() {
  const job = await jobService.claimNextJob({ staleThresholdMs: STALE_THRESHOLD_MS });
  if (!job) return; // nothing pending — idle tick, cheapest possible no-op

  try {
    const context = await submissionRepository.getEvaluationContext(job.submissionId, job.jobType);
    const content = contentLoader.getContent(context.contentVersion); // resolves the FROZEN version, never "current"

    const result = job.jobType === 'writing_eval'
      ? await aiEvaluationService.evaluateWriting(context.responseText, content.writingRubricInstructions)
      : await aiEvaluationService.processStudentProblemsText(context.responseText);

    await jobService.completeJob(job.id, result, { contentVersion: context.contentVersion }); // transactional write of result + job status
    // For writing_eval, completeJob() itself calls WritingScoreCalculator.computeOverallScore(
    // result.criteriaScores, content.writingRubricWeights) before persisting — see Section 7.
  } catch (err) {
    await jobService.failJob(job.id, err, { maxAttempts: MAX_ATTEMPTS });
  }
}

setInterval(tick, POLL_INTERVAL_MS);
```

**Why one poll loop and not a queue library:** Ollama Cloud's free tier permits exactly one in-flight cloud request. A single loop, processing one job at a time, is not a simplification made *despite* the requirements — it is the design that matches the provider's actual concurrency ceiling. Introducing Redis/BullMQ here would add an infrastructure dependency (and, at free tiers, another service that can sleep/expire) to manage concurrency the underlying AI provider doesn't allow anyway.

**Claiming (avoiding duplicate processing):** `claimNextJob` runs `UPDATE ... WHERE id = (SELECT ... FOR UPDATE SKIP LOCKED)` in one statement, so even if a future change added a second worker instance, two workers could never claim the same row. With a single instance this also protects against a rare double-tick if a previous poll is still finishing when the interval fires — the loop is written to await each tick fully before scheduling the next (`setInterval` firing overlaps are prevented via an `isRunning` guard).

**Stale jobs:** a job claimed (`status='processing'`) but not completed within `STALE_THRESHOLD_MS` (e.g., the process restarted mid-call, or Render put the service to sleep mid-job) is eligible for re-claim on the next poll. This directly addresses EDGE-005 — the student never sees an indefinite "in progress" state, because a stalled job either completes on retry or exhausts its attempts and becomes `failed_needs_review`.

**Retries and backoff:** failures are split into **retryable** (network/timeout errors, Ollama queue-full rejections) and **non-retryable** (malformed input from the student, e.g. an empty response, is non-retryable and handled before a job is even created; a schema-validation failure on a well-formed-but-wrong LLM response is treated as retryable once, since a re-prompt may succeed). Retryable failures increment `attemptCount` and set `nextAttemptAt = now() + backoff(attemptCount)` (simple linear backoff — 30s, 2min, 5min — is sufficient at this volume). After `MAX_ATTEMPTS`, the job is marked `failed_needs_review` and the submission's `writingStatus`/`problemsTextStatus` is set to the same value, without ever touching the original response text (FR-WRITE-011, FR-PROB-013). This state is visible to staff (Section 9) and there is no separate manual-retry workflow (Section 10) — a submission stuck at `failed_needs_review` is a known, visible, terminal-for-now state, not a silent failure.

**Render sleep interaction:** if the free web service spins down from inactivity, the poll loop stops along with everything else. Any jobs left `pending` simply resume on the next wake (the next incoming HTTP request, or an external ping — see Section 16). No job is lost, since job state lives in Postgres, not in process memory.

---

## 9. Navigation & Access Control

**Student routes:** students have no accounts; what they have, after identity verification succeeds, is a short-lived **student session** — a server-issued cookie scoped to exactly one submission (Section 1). That single session mechanism covers both routes below; there is no separate "report session" concept.

| Route | Purpose | Access rule |
|---|---|---|
| `/` | Entry page: cohort code + roll number + name | Public |
| `POST /api/session/student-verify` | Resolves identity, creates the student session cookie scoped to that submission's id | Public; rate-limited (Section 13) |
| `/assessment` | Section-by-section assessment UI | Requires a valid student session; server re-checks `status='draft'` on every write — if already submitted, redirected to `/report` |
| `/report` | Deterministic + writing status view | Requires a valid student session; works identically for a first-time post-submit view and a later returning visit (re-verifying identity re-issues the session) |

There is deliberately **no** `/report/:id` or any route parameter that identifies a submission — this is the direct implementation of "no predictable student report URL" (NFR-SEC-009). The only way to obtain a student session — for either the assessment or the report — is through identity verification.

**Staff routes:**

| Route | Purpose | Access rule |
|---|---|---|
| `/staff/login` | Email/password login | Public |
| `/staff/dashboard` | Aggregate views, cohort filter | Requires staff session |
| `/staff/submissions/:submissionId` | Individual submission detail | Requires staff session; every access is logged server-side via structured application logging (Section 13) |
| `/staff/export` | CSV export | Requires staff session |

**Session behavior:** two independent cookie-based sessions exist — a staff session (longer-lived, e.g. 8 hours, since staff return to the dashboard repeatedly) and a student session (short-lived, e.g. 30 minutes of inactivity, re-established trivially by re-entering identity). Neither session type grants access to the other's routes; middleware (`requireStaffSession` / `requireStudentSession`) is applied per router, not globally, so the two access boundaries can never be accidentally merged.

---

## 10. API / Backend Contracts

Deliberately small — one endpoint per real user action, not one per theoretical CRUD operation.

| Endpoint | Method | Purpose | Auth |
|---|---|---|---|
| `/api/session/student-verify` | POST | Look up/create a draft for (cohort code, roll number, name); returns current status and issues the student session | Public, rate-limited |
| `/api/student/draft` | GET | Fetch the current draft's answers + content (for the draft's `contentVersion`) for the active session | Student session |
| `/api/student/draft` | PATCH | Autosave **one section's** answers (Section 12) | Student session; rejected if `status != 'draft'` |
| `/api/student/submit` | POST | Finalize the submission (idempotent — see Section 3) | Student session |
| `/api/student/report` | GET | Current submission state: deterministic scores, writing status/result | Student session |
| `/api/staff/login` | POST | Staff email/password login | Public, rate-limited |
| `/api/staff/logout` | POST | Clear staff session | Staff session |
| `/api/staff/dashboard` | GET | Aggregate metrics, filterable by cohort | Staff session |
| `/api/staff/submissions/:id` | GET | Individual submission detail; logs staff access (Section 13) | Staff session |
| `/api/staff/export.csv` | GET | Streamed CSV, optionally filtered by cohort | Staff session |

**On the removal of a manual retry endpoint:** v1.0 included `POST /api/staff/submissions/:id/retry-writing`. It is removed in this revision. The PRD does not request a manual-retry workflow, the automatic retry mechanism (Section 8) already gives every job up to `MAX_ATTEMPTS` serial attempts with backoff, and a `failed_needs_review` submission is already visible to staff on the dashboard. A manual retry endpoint would be a staff-facing operational tool the product requirements never asked for, and at pilot scale (tens to a few hundred submissions, two staff members), a handful of jobs reaching `failed_needs_review` is an acceptable, visible outcome rather than one that needs an in-app remediation workflow. If the pilot later shows retries are genuinely needed as self-service rather than "staff notices and asks an engineer to re-run the job manually," that is a small, well-understood addition (Section 17) — not something to build speculatively now.

Every request body is validated against a `zod` schema before it reaches a domain service (`validateBody` middleware) — malformed input never reaches business logic. Every domain service method that changes data is called from exactly one route, keeping the "canonical implementation" property from Section 7 enforceable in code review (a second call site is a review-time red flag).

---

## 11. Error Handling Strategy

| Failure class | Example | User-facing behavior | Internal handling |
|---|---|---|---|
| Validation error | Malformed autosave payload | 400 with field-level message | `zod` parse failure caught by middleware, never reaches domain layer |
| Student identity not found | Wrong cohort code/roll/name combination | Generic "we couldn't find a matching record — check your details" (never reveals *which* field was wrong, to avoid aiding guesswork against NFR-SEC-009) | Logged at info level, rate-limited |
| Submission conflict | Retry/double-click on an already-submitted draft | Treated as success — the existing report is returned, not an error | Handled inside the same transaction as finalize (Section 3) |
| Authorization error | Staff route hit without a staff session; student route hit without a student session | 401/403, redirect to the relevant login/entry page | Middleware-level, before any domain logic runs |
| Database error | Connection drop, constraint violation | 500 with a generic "something went wrong, your answers are saved" (autosave failures specifically retry client-side before surfacing anything) | Logged with full detail server-side; never leaks SQL/stack traces to the client |
| AI validation error | LLM response doesn't match the expected schema | Not surfaced to the student directly — the job fails and is retried per Section 8; report shows "still being prepared" until retries exhaust | Logged with the raw (schema-invalid) response for later debugging |
| AI timeout/network error | Ollama Cloud slow or unreachable | Same as above — retried, then `failed_needs_review` | Logged as retryable |
| Stale job | Worker died mid-call | Re-claimed automatically (Section 8) | No user-facing error at all in the common case |

**Principle:** any error that could reveal information useful for guessing another student's identity, or that would expose internal implementation detail (stack traces, SQL, prompt content), is reduced to a generic message before it reaches the browser. Everything else is logged with full context server-side via `pino`.

---

## 12. Data Consistency & Integrity

- **One submission per identity:** enforced at the database level via `@@unique([cohortId, rollNumberNormalized])` (Section 6) — not solely an application-level check.
- **Immutable after submission:** enforced in `SubmissionService.finalize()` (the only write path that sets `status='submitted'`) and in every subsequent write path (`/api/student/draft PATCH`) explicitly checking `status='draft'` before allowing a write. A submitted row is never targeted by the autosave update at all.
- **Section-level autosave (multi-tab/device safe):**
  - **Request shape:** `PATCH /api/student/draft` body is `{ section: 'grammar' | 'vocabulary' | 'reading' | 'writing' | 'studentProblems', sectionAnswers: {...} }` — never the full `answers` object.
  - **Server behavior:** the update is a single atomic statement that merges only the named section's key into the JSONB column — `UPDATE submissions SET answers = answers || jsonb_build_object($section, $sectionAnswers), updated_at = now() WHERE id = :submissionId AND status = 'draft'`. Postgres's `||` operator on `jsonb` replaces only the specified top-level key and leaves every other key untouched, so this is a genuine partial update, not a read-modify-write the application has to orchestrate.
  - **Two requests arriving close together, different sections:** both succeed, each touching only its own key — no data loss, no merge conflict, no locking needed, because each `UPDATE` is independently atomic and the keys they touch don't overlap.
  - **Two requests arriving close together, the same section (e.g., two tabs both on "Writing"):** last-write-wins **for that section only** — the later `UPDATE` overwrites the earlier one's value at that key. This is the one case where a very recent keystroke in the losing request could be superseded, which is judged acceptable at pilot scale (a student editing the same section in two tabs simultaneously is an edge case, not the common path) and is a much narrower blast radius than v1.0's whole-document last-write-wins, which could silently drop an entire *other* section's progress.
  - **Answers in unrelated sections are never lost** under this design — that was the specific failure mode being corrected, and the section-scoped `jsonb ||` merge eliminates it structurally rather than through discipline or luck.
- **Safe retries on submit:** the finalize transaction (Section 3) is idempotent by construction — a retried request that arrives after the first one already committed simply observes `status='submitted'` and returns the existing report rather than attempting a second state transition.
- **Valid AI results only:** the domain layer never accepts an LLM response into `writingCriteriaScores`/`writingOverallScore` without it passing the `zod` schema in `src/ai/schemas.ts` first (Section 3, Section 8).
- **Deterministic scores:** `DeterministicScoringService` and `WritingScoreCalculator` are both pure functions with no reliance on ambient state — same (answers, content-version) input always produces the same score, which is directly testable (Section 15).
- **Original data preservation:** `problemsOpenTextOriginal` is written exactly once, at submission time, by `SubmissionService.finalize()`, and no other code path in the system writes to that column — verified by the fact that `JobService`/`AIEvaluationService` code only ever targets `problemsTextDerived`.
- **Historical content interpretability:** a submission's `contentVersion` is frozen at draft creation and never changes. `ContentLoader` keeps every version referenced by any submission available in memory for the life of the process (Section 2), so scoring, re-scoring, or staff review of an old submission always resolves against the exact questions/prompt/rubric it was taken under, never against whatever the repo's content currently is.

---

## 13. Security Architecture

- **Password hashing:** staff passwords hashed with `bcrypt` (cost factor 12), never stored or logged in plaintext.
- **Sessions:** httpOnly, `Secure`, `SameSite=Lax` cookies for both staff and student sessions. Session secret loaded from an environment variable, never committed. The student session (Section 1, Section 9) is the sole access mechanism for both the assessment and the report — there is no separate authentication concept for either flow.
- **CSRF:** `SameSite=Lax` plus origin-checking on state-changing requests is sufficient here — there is no cross-site embedding use case for this app, so a full CSRF-token scheme would be unjustified complexity for this threat model.
- **Student identity, not authentication:** explicitly *not* treated as a security boundary equivalent to a password — the cohort code is a cohort identifier, not a secret (NFR-SEC-002), so the actual protection against one student seeing another's report is the **combination requirement** (cohort + roll + name must all match a stored record) plus the **absence of any ID-bearing URL** to guess or share (Section 9), not code secrecy alone.
- **Rate limiting:** `POST /api/session/student-verify` and `POST /api/staff/login` are rate-limited per IP (e.g., a simple in-memory or Postgres-backed counter — no external rate-limiting service needed at this traffic volume) to blunt brute-force guessing of roll numbers or staff passwords.
- **API key protection:** the Ollama Cloud API key lives only in a Render environment variable, read exclusively inside `OllamaProvider.ts`. No route, log line, or client response ever includes it. `pino` is configured to redact any field literally named `apiKey`/`authorization` as a defense-in-depth measure.
- **Input validation:** every API boundary validated via `zod` (Section 11); every database write goes through Prisma's parameterized queries, so there is no raw SQL string concatenation anywhere in the codebase (eliminates SQL injection as an attack surface by construction).
- **Predictable-ID protection:** covered in Section 9 — there is structurally no ID-bearing student route to protect.
- **Staff data access is logged — as a log line, not a new data model.** Every `GET /api/staff/submissions/:id` emits one structured `pino` log entry: `{ event: 'staff_submission_access', staffUserId, submissionId, timestamp, action: 'view' }`. This is an **operational log**, written to stdout and viewable in Render's log dashboard (Section 16) alongside every other application log — it is not a database table, not an audit-event model, and nothing else in the system reads it back. This is a deliberately minimal implementation of "individual-record access should be traceable": proportionate to a two-staff, non-adversarial pilot, and easy to remove or upgrade later without touching the data model if a future need justifies more.
- **Sensitive data handling:** the Student Problems open-text field may contain personal information about third parties; the entry page displays the required notice (FR-PROB-014, NFR-PRIV-009) before that question, but the field is not filtered/redacted automatically — the PRD explicitly scopes redaction as out of scope, this is a notice-only mitigation.

**Realistic threat model:** this is a small, non-adversarial pilot with no payment data and no PII beyond names/roll numbers/free-text responses. The security posture above (server-authoritative state, hashed passwords, no guessable IDs, parameterized queries, operational access logging) is proportionate to that — it does not attempt to defend against a sophisticated attacker with infrastructure access, which is out of scope for a $0-infrastructure pilot.

---

## 14. Performance Considerations

At "tens to a few hundred students" and two staff users, this application will never be under meaningful load. Design choices are chosen for simplicity first, with the following explicit provisions:

- **Autosave debouncing and payload size:** client-side debounce (~1.5s after last keystroke, plus on blur/navigation) keeps `PATCH /api/student/draft` calls infrequent — realistically a handful per minute per active student. Section-level payloads (Section 12) are also smaller than v1.0's whole-`answers` payload, which incidentally reduces bandwidth per request as well as fixing the correctness issue.
- **Dashboard aggregation:** computed on-demand with plain SQL `GROUP BY`/`AVG`/`COUNT` queries at request time — no precomputed materialized views or caching layer. At a few hundred rows, these queries return in milliseconds; adding caching here would be complexity solving a problem that doesn't exist at this scale.
- **Indexes:** `[cohortId]` and `[status]` on `Submission`, `[status, nextAttemptAt]` on `ProcessingJob` (Section 6) cover the actual query patterns (cohort filter, completion status, job claiming) — no speculative indexing beyond what the defined queries need.
- **AI latency:** Ollama Cloud free tier has no published SLA and a single-concurrency ceiling, so Writing evaluation may take anywhere from seconds to (under load) minutes. This is explicitly designed around via background processing (Section 8) rather than the request/response cycle — the student is never blocked waiting on it.
- **Timeouts:** the `OllamaProvider` enforces a request timeout (e.g., 60s) so a hung call cannot block the single worker loop indefinitely; a timeout is treated as a retryable failure.
- **No connection pooling concerns beyond default Prisma pooling** — Supabase's free tier connection limit is well above what a single Node process with default Prisma pool settings will ever open.

---

## 15. Testing Strategy

| Area | Test type | What's covered |
|---|---|---|
| `DeterministicScoringService` | Unit | Correct/incorrect answer scoring, section totals, explanation lookup, against fixture content for a specific version |
| `WritingScoreCalculator` | Unit | Weighted formula correctness against fixture weights; boundary values (0, 100) |
| `ContentLoader` | Unit + integration | All committed versions load and validate at boot; `getContent('v1')` still resolves correctly after a `v2` is added; boot fails fast on a malformed content file |
| `SubmissionService.finalize()` | Integration (real test DB) | First submission succeeds; second attempt for the same identity is idempotent (no duplicate row, no error); concurrent simultaneous submit requests (simulated) never create two rows; incomplete required sections are rejected |
| Database constraints | Integration | Direct attempt to insert a duplicate `(cohortId, rollNumberNormalized)` row is rejected by Postgres itself, not just application code |
| `StudentIdentityService` | Unit + integration | Correct match/no-match behavior; normalization (whitespace/case) behaves as expected |
| `StaffAuthService` | Unit | Password hashing/verification, session issuance |
| Autosave endpoint (section-level) | Integration | A PATCH to section A does not alter previously-saved section B; two concurrent PATCHes to different sections both persist; two concurrent PATCHes to the same section result in one winning (last-write) without affecting other sections; writes to a submitted record rejected |
| `SubmissionRepository.getEvaluationContext()` | Unit + integration | Returns the correct response text and `contentVersion` for both job types; throws clearly if the submission is missing the expected field (e.g., a `writing_eval` job for a submission with no writing answer) |
| `AIEvaluationService`/`OllamaProvider` | Unit, with a **fake provider** implementing the same interface | Schema validation accepts well-formed responses and rejects malformed ones (missing field, wrong type, out-of-range score) without ever making a real network call in CI |
| `JobService` | Unit + integration | Claim query never double-claims (simulated concurrent claim attempts); retry/backoff transitions; stale job re-claim after the threshold; exhausted-retries → `failed_needs_review` |
| Dashboard aggregation queries | Integration | Correct counts/averages against seeded fixture data, including cohort filtering |
| CSV export | Integration | Output includes expected columns/rows for a seeded dataset |
| End-to-end student flow | A small number of Playwright/supertest-driven flows | Entry → draft (section-level autosave) → submit → report (deterministic visible immediately, writing status transitions from pending to succeeded using the fake AI provider) |

**Mocking Ollama:** all tests run against a `FakeAIEvaluationService` implementing the same `AIEvaluationService` interface as `OllamaProvider` — this is the direct payoff of the AI abstraction boundary (Section 1/8): the entire test suite, including CI, never depends on Ollama Cloud being reachable or within quota.

---

## 16. Deployment & Operations

**Local development:** `npm run dev` starts Express (with the worker loop active) and the Vite dev server concurrently; `.env` (git-ignored) holds `DATABASE_URL`, `OLLAMA_API_KEY`, `OLLAMA_BASE_URL`, `SESSION_SECRET`. `prisma migrate dev` applies migrations against a local or Supabase dev database.

**Environment variables (production, set in Render's dashboard):**

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Supabase Postgres connection string |
| `OLLAMA_API_KEY` | Server-side only; never sent to the client |
| `OLLAMA_BASE_URL` | Ollama Cloud's API endpoint |
| `SESSION_SECRET` | Cookie signing secret |
| `NODE_ENV=production` | Standard production flag |

**Database migrations:** `prisma migrate deploy` run as part of the Render build/release step, before the new instance starts serving traffic — migrations are never applied by hand against production.

**Production deployment:** a single Render free web service, built from the repository (`npm ci && npm run build`), started via `node dist/server.js`, which serves the built React bundle as static files and runs the API + worker loop in the same process.

**Startup behavior:** on boot, the process (1) connects to Postgres, (2) loads and validates **every** assessment content version under `content/versions/*` (fails fast if any version's content is malformed — a broken content file should never reach students, and an old version must stay loadable for as long as any submission references it), (3) starts the Express server, (4) starts the background worker loop's `setInterval`.

**Worker lifecycle:** the worker is not a separate process or service — it lives inside the same Node process as the API server, started at boot and running for the process's lifetime. When Render puts the free service to sleep, the worker stops with everything else; both resume together on the next incoming request (see below).

**Logging:** structured JSON logs via `pino` to stdout, captured by Render's built-in log viewer, including the staff data-access log lines described in Section 13. No separate log aggregation service — unnecessary at this scale and would add a paid or additional free-tier dependency for a problem Render's dashboard already solves adequately for a pilot.

**Monitoring/error visibility:** no external APM. Job failures (`failed_needs_review`) are visible directly in the staff dashboard, which doubles as the operational visibility mechanism for the one failure mode staff actually need to act on. Application-level unhandled errors are logged to stdout; for a two-person pilot team, periodic log review is proportionate — a dedicated monitoring service is not justified.

**Free-tier provider behavior — stated as of September 2026, to be reverified against each provider's current documentation at implementation time, since free-tier terms change without notice:**

- **Render free web service:** as of this writing, sleeps after 15 minutes of inactivity and takes roughly 30–60 seconds to wake on the next request. This affects both the API (first visitor after idle waits) and the background worker (jobs left pending simply wait until the next wake — no jobs are lost, per Section 8, but completion is delayed).
- **Supabase free Postgres:** as of this writing, a free project **pauses after 7 days of continuous inactivity** (not merely "may pause" — this is a specific, documented threshold) and must be manually resumed from the dashboard, or reached by a request, to come back online; the free tier also does not include automated backups. Because Render's own sleep threshold (15 minutes) is far shorter than Supabase's (7 days), ordinary pilot traffic hitting the app at least once every few days keeps the database warm as a side effect — but a genuinely quiet stretch (e.g., a week-long break between assessment sessions) could pause the database. Unlike Render's free Postgres (which deletes data after 30 days — the reason Supabase was chosen over it in Section 1's discovery pass), a Supabase pause does not delete data; it just requires a wake before the next request succeeds.
- **Mitigation for both, if idle periods during the pilot risk exceeding these thresholds:** an external free scheduled ping (e.g., a GitHub Actions workflow hitting a `/health` endpoint — which itself performs a trivial DB query — every ~10 minutes) keeps both Render and Supabase warm at no additional cost. This is an **optional operational mitigation** available if the pilot's actual usage pattern turns out to have idle gaps longer than a few days; it is not required for the architecture to function, and it introduces no new infrastructure (GitHub Actions' free tier, triggering an endpoint that already exists).
- **Ollama Cloud free tier has no SLA and unpublished quotas.** If the pilot's Writing-evaluation volume exceeds the free tier's actual daily/weekly allowance, jobs will queue longer or be rejected and retried rather than fail outright — the job/retry design (Section 8) degrades gracefully under this, but sustained heavy usage could mean Writing feedback takes noticeably longer to appear than the deterministic sections. This should be monitored during the pilot; if it becomes a real constraint, the fix is a paid Ollama Cloud tier, not an architecture change.
- **No backups on Supabase's free tier.** Given the small data volume, a simple periodic `pg_dump` triggered manually (or via a free scheduled GitHub Action) before major milestones (e.g., end of pilot data collection) is a reasonable, zero-cost safety net; this is an operational recommendation, not new infrastructure.
- **The $0 constraint holds under all of the above.** None of these behaviors require a paid tier to satisfy the architecture's functional requirements — they affect latency and require light operational awareness, not money.

---

## 17. Future Extensibility

Documented as realistic extension points only — none of the following exist in the MVP codebase, and none require present-day implementation:

- **Additional assessment types (Listening, Speaking automation):** the content layer already separates "assessment structure" (`content/versions/*`) from delivery logic; a new section type would mean a new content file (added to the next version) and a new scoring service alongside `DeterministicScoringService`/`WritingScoreCalculator`, without restructuring the submission or job models.
- **Question-management CMS:** because content is already isolated behind `ContentLoader`'s typed interface, a future CMS would replace *how* content is loaded (versioned files → database-backed versions), not *how* it's consumed by scoring or the frontend — the version-keyed access pattern (`getContent(version)`) would stay identical.
- **Additional staff roles/permissions:** `StaffUser` has no role column today (by design — one flat permission level, per NFR-SEC-007/FR-STAFF-003); adding one later is a single migration plus an authorization check in `requireStaffSession`, not a restructuring.
- **Alternative/additional AI providers:** the `AIEvaluationService` interface (Section 1, Section 8) is the deliberate seam for this — a second provider implementation could be added and selected via configuration without touching `SubmissionService`, `WritingScoreCalculator`, or any route.
- **Staff-initiated manual retry:** if operational experience during the pilot shows this is genuinely needed (Section 10), it is a small addition — one route calling the existing `JobService.retryJob()` internal capability — not a new subsystem.
- **Additional cohorts/scaling beyond pilot volume:** the schema already scopes everything by `cohortId`; supporting more cohorts requires no schema change, only more `Cohort` rows. If volume genuinely outgrew a single free-tier instance, the first and only necessary step would be upgrading Render/Supabase to paid tiers of the *same* services — not a re-architecture.

No infrastructure (queues, caching, CMS tables, RBAC tables, audit-event subsystems) is introduced now in anticipation of these — each is a bounded, well-understood change against today's structure when and if it's actually needed.

---

## 18. Canonical Locations & Architectural Authority

This document is the architectural source of truth for the English-Language Assessment & Diagnostic Pilot MVP. An undocumented architectural decision is not a decision — it is a guess.

| Concern | Canonical location |
|---|---|
| Submission finalization rules | `src/domain/submission/SubmissionService.ts` |
| Deterministic scoring | `src/domain/scoring/DeterministicScoringService.ts` |
| Writing score calculation | `src/domain/scoring/WritingScoreCalculator.ts` |
| Writing rubric instructions & weights (configurable, not hardcoded; versioned with content) | `content/versions/<version>/writing-rubric.json` |
| Assessment content (questions, answers, explanations, statements), all versions | `content/versions/*`, loaded via `src/content/ContentLoader.ts` |
| Which content version new drafts start under | `content/current-version.json` |
| Resolving a submission's authoritative response text / content for background evaluation | `src/data/SubmissionRepository.ts` (`getEvaluationContext`) — never `ProcessingJob` fields |
| AI integration boundary | `src/ai/AIEvaluationService.ts` (interface) / `src/ai/OllamaProvider.ts` (implementation) |
| AI output validation | `src/ai/schemas.ts` |
| Background job lifecycle | `src/domain/jobs/JobService.ts` + `src/background/workerLoop.ts` |
| Section-level autosave merge | `src/api/student.routes.ts` (`PATCH /api/student/draft`) via `src/data/SubmissionRepository.ts` |
| Database access | `src/data/*Repository.ts` (Prisma) |
| Database schema and constraints | `prisma/schema.prisma` |
| Student identity verification & session issuance | `src/domain/identity/StudentIdentityService.ts`, `src/auth/session.ts` |
| Staff authentication/authorization | `src/domain/staff/StaffAuthService.ts`, `src/api/middleware/requireStaffSession.ts` |
| Staff data-access logging | Structured `pino` log line in `src/api/staff.routes.ts` (`GET /api/staff/submissions/:id`) — not a database table |
| Dashboard/aggregate queries | `src/domain/staff/DashboardService.ts` |

All architectural decisions above are final unless a change request is submitted and approved before the implementation sprint begins.
