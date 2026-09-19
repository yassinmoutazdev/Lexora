# TASK_PLAN.md
## English-Language Assessment & Diagnostic Pilot — Implementation Task Plan

**Source documents:** `PRD.md` (English Assessment Pilot PRD v1.1), `ARCHITECTURE.md` v1.1 (Implementation-Ready)
**Operating rules:** `CLAUDE.md` (project root) — loaded automatically at the start of every Claude Code session
**Prepared for:** Sequential execution by Claude Code, run from the repository root in the VS Code integrated terminal — one Epic per session, one task at a time
**Last Updated:** 2026-09-15
**Status:** Ready for implementation

---

## Scope Summary

| Epic | Title | Features | Tasks |
| ---- | ----- | -------: | ----: |
| E1 | Project Foundation & Tooling | 2 | 8 |
| E2 | Database Schema, Content Versioning & Seed Data | 3 | 10 |
| E3 | Identity, Sessions & Authentication | 3 | 9 |
| E4 | Student Draft & Assessment-Taking Flow | 3 | 7 |
| E5 | Deterministic Scoring & Submission Finalization | 3 | 7 |
| E6 | AI Abstraction & Background Job Infrastructure | 3 | 8 |
| E7 | Writing Evaluation & Student Problems AI Processing | 4 | 10 |
| E8 | Staff Dashboard & Reporting | 4 | 9 |
| E9 | Security, Error Handling & Deployment Hardening | 4 | 10 |
| E10 | Final QA & End-to-End Verification | 5 | 12 |

**Total Epics:** 10
**Total Tasks:** 90
**Last Updated:** 2026-09-15
**Status:** Ready for implementation

---

## Build Order Diagram

```text
E1  Project Foundation & Tooling
      ↓
E2  Database Schema, Content Versioning & Seed Data
      ↓
E3  Identity, Sessions & Authentication
      ↓
E4  Student Draft & Assessment-Taking Flow
      ↓
E5  Deterministic Scoring & Submission Finalization
      ↓
E6  AI Abstraction & Background Job Infrastructure
      ↓
E7  Writing Evaluation & Student Problems AI Processing
      ↓
E8  Staff Dashboard & Reporting          (also consumes E3's staff-auth infrastructure)
      ↓
E9  Security, Error Handling & Deployment Hardening   (hardens all of E3–E8)
      ↓
E10 Final QA & End-to-End Verification   (exercises the entire system)
```

The sequence is strictly linear: each Epic's "What Done Means" criteria are prerequisites for the next Epic's tasks. E8 additionally reuses the staff-session infrastructure built in E3 (no new dependency, just a later consumer of already-completed work). E9 hardens cross-cutting concerns that were deliberately deferred rather than repeated in every earlier Epic. No two Epics are genuinely independent at this scale — the assessment flow, scoring, AI processing, and staff tooling all sit on top of the same submission/job data model, so parallelizing Epics would risk building against schema or session behavior that hasn't been implemented yet.

---

## How to Use This Plan

This plan is executed by Claude Code running **inside this repository**, started from the VS Code integrated terminal. Every document it needs is already committed here. Nothing is uploaded, attached, or pasted into chat — Claude Code reads the files directly.

```text
VS Code
  ↓
Integrated Terminal
  ↓
Claude Code (started from the repository root)
  ↓
Repository files
  ↓
CLAUDE.md + PRD.md + ARCHITECTURE.md + TASK_PLAN.md
```

1. Open the project repository in VS Code.
2. Open the integrated terminal (Ctrl+backtick on Windows/Linux, Cmd+backtick on macOS) at the repository root.
3. Start Claude Code with `claude`. It loads the project-root `CLAUDE.md` automatically — run `/context` once if you want to confirm it appears under **Memory files**.
4. Optionally name the session after the Epic (`/rename epic-3-identity`) so it can be resumed later with `claude --resume`.
5. Give Claude Code the session-start prompt below, naming the Epic.
6. Claude Code reconstructs state from the repository (files, tests, `git status`, completed task markers) and verifies the Epic's prerequisites.
7. Claude Code works through the Epic's tasks in order, one task at a time.
8. After each task, Claude Code runs the task's verification (the `Output:` line) and shows the evidence — test output, command output, or the created file.
9. You confirm the result or correct it.
10. Claude Code ticks the task's checkbox in this file and moves to the next task.
11. At Epic completion, the Epic's **What Done Means** criteria are verified in full.
12. The completed Epic is committed to Git as a checkpoint (`git commit -m "Epic N complete: <title>"`).
13. A new Claude Code session (`/clear`, or a fresh `claude` run) begins the next Epic.

**One Epic per session.** Do not begin the next Epic while any current-Epic criterion is failing.

### Session-start prompt

```text
Read CLAUDE.md, then read PRD.md, ARCHITECTURE.md, and TASK_PLAN.md.
Determine the current Epic and completed tasks from the repository state.
Verify the prerequisites for the current Epic.
Then begin with the first incomplete task in that Epic.
Execute tasks sequentially and verify each one before continuing.
```

Do not paste this plan, the PRD, or the Architecture into chat. The repository is the persistent context.

---

## Claude Code Session Boundaries

Each Epic is one session. The following applies to every Epic and is not repeated per-Epic.

### At session start

- Inspect the repository state (`git status`, `git log --oneline -10`, the actual file tree).
- Read `CLAUDE.md`, `PRD.md`, `ARCHITECTURE.md`, and `TASK_PLAN.md`.
- Read the current Epic's **Prerequisites**, **Files to Read**, and **What Done Means**.
- Inspect the existing implementation the Epic builds on — do not assume a previous session finished what it started.
- Identify which tasks are already checked off, and confirm the repository actually supports that claim.
- If a prerequisite is missing, say so before writing any code.

### During the Epic

- Execute tasks in listed order.
- Inspect existing code before modifying it.
- Implement only the current task; do not pull work forward from later tasks.
- Run the task's verification and show the evidence.
- Do not change approved architecture, and do not skip an unfinished dependency.
- Tick a task's checkbox only once its `Output:` condition is actually verified.

### At Epic completion

- Run the Epic's **What Done Means** verification in full.
- Run the relevant automated tests, plus `tsc`/build checks where applicable.
- Inspect `git status` and `git diff` — no stray files, no scratch artifacts, no committed secrets.
- Commit the Epic as a checkpoint (`git commit -m "Epic N complete: <title>"`).
- Leave the working tree clean and the repository in a coherent state for the next session.

---

## E1 — Project Foundation & Tooling

**Rationale:** Establishes the runnable backend/frontend skeleton, dependency set, and test harness that every later Epic is built on top of.

**What Done Means:**
- Backend and frontend both build and start locally (`npm run dev`) without errors.
- `npm test` executes a passing smoke test, and an integration test can run against the test database.
- `npm run build` produces a backend `dist/` and a frontend bundle; `npm start` serves both from one process.
- Directory structure matches ARCHITECTURE Section 4 exactly, with three deliberate additions. `src/config/env.ts` holds environment loading and fail-fast validation, which several Section 18 canonical files need but Section 4 does not enumerate a home for. `scripts/dev.mjs` runs the Express and Vite processes together, because Section 2's pinned dependency list includes no process-runner package. `src/test/` holds the vitest setup and harness modules, which Section 4 shows only implicitly via colocated `*.test.ts` files. No file outside these additions was created, and no Section 4 location was moved or renamed.
- `.env.example` documents every environment variable required by the architecture, including the test database URL.

**Prerequisites:** A Git repository exists at the project root and the four project documents above are committed. Node.js and npm are available. No other prerequisites — this Epic creates the skeleton.

**Files to Read:**
- `CLAUDE.md` — persistent Claude Code operating rules for this repository
- `PRD.md` — product requirements and behavioral constraints
- `ARCHITECTURE.md` — approved technical architecture
- `TASK_PLAN.md` — this Epic's task order, outputs, and completion state
- any existing root files (`package.json`, `tsconfig.json`, `.gitignore`) — inspect before creating, never overwrite blindly

### Feature 1.1 — Repository & Tooling Setup

- [x] T1.1.1 — Initialize the Node/TypeScript backend project structure (package.json, tsconfig.json, empty `src/`, `prisma/`, `content/`, `frontend/` directories) matching the approved layout.
      Ref: ARCHITECTURE Section 4 (Project Structure)
      Output: package.json, tsconfig.json, directory skeleton matching Section 4 · `npm install` succeeds
- [x] T1.1.2 — Install and pin the backend dependencies and dev dependencies exactly as specified (express, @prisma/client + prisma, zod, bcrypt, cookie-session, csv-stringify, dotenv, pino; typescript, vitest, supertest, @types/*).
      Ref: ARCHITECTURE Section 2 (Dependencies)
      Output: package.json dependency list matches Section 2 · `npm ls` reports no missing peer dependencies
- [x] T1.1.3 — Initialize the Vite + React + TypeScript frontend project under `frontend/`, matching Section 4's file layout (`frontend/index.html`, `frontend/vite.config.ts`, `frontend/src/main.tsx`, `frontend/src/App.tsx`).
      Ref: ARCHITECTURE Section 4 (Project Structure), Section 2 (react/react-dom/vite)
      Output: frontend/vite.config.ts, frontend/index.html, frontend/src/main.tsx · `npm run build` (frontend) produces a dist bundle
- [x] T1.1.4 — Configure `dotenv`-based environment variable loading and create `.env.example` documenting `DATABASE_URL`, `OLLAMA_API_KEY`, `OLLAMA_BASE_URL`, `SESSION_SECRET`, `NODE_ENV`.
      Ref: ARCHITECTURE Section 16 (Deployment & Operations — Environment variables)
      Output: .env.example · the app throws a clear startup error if a required variable is missing
- [x] T1.1.5 — Assemble the minimal Express app entrypoint (`src/app.ts` for app assembly/middleware mounting, `src/server.ts` as the process entrypoint) and wire `npm run dev` to run Express and the Vite dev server concurrently.
      Ref: ARCHITECTURE Section 16 (Local development), Section 4
      Output: src/app.ts, src/server.ts · `npm run dev` starts both processes without errors
- [x] T1.1.6 — Define the production build pipeline: `npm run build` compiles the backend TypeScript to `dist/` and builds the Vite frontend bundle; `npm start` runs `node dist/server.js`; in production Express serves the built frontend bundle as static files from the same process.
      Ref: ARCHITECTURE Section 16 (Production deployment — `npm ci && npm run build`, `node dist/server.js`, single process serving bundle + API), Section 1 (single deployable)
      Output: package.json build/start scripts, static-asset serving in src/app.ts · `npm run build` produces `dist/server.js` and a frontend bundle; `npm start` serves the built frontend and the API from one process

### Feature 1.2 — Testing Harness

- [x] T1.2.1 — Configure `vitest` for backend unit/integration tests and `supertest` for API-level tests, with one passing smoke test.
      Ref: ARCHITECTURE Section 15 (Testing Strategy)
      Output: vitest.config.ts + one passing smoke test · `npm test` runs and passes
- [x] T1.2.2 — Establish the integration-test harness every later Epic's database tests depend on: a separate test database URL (e.g. `DATABASE_URL_TEST` in `.env.example`), a migrate-then-reset step before the suite, per-test truncation/rollback, and shared fixture helpers for creating cohorts, staff users, and submissions.
      Ref: ARCHITECTURE Section 15 (Testing Strategy — integration tests against a real test DB), Section 16 (Local development)
      Output: test setup module + fixture helpers · an example integration test creates and reads a row against the test database, and the suite leaves no residual data between tests
      **Completed in E2.** E1 delivered `src/test/db.ts` (`DATABASE_URL_TEST` resolution, `runMigrations()`, schema-agnostic `resetDatabase()` truncation), `src/test/globalSetup.ts` wired into `vitest.config.ts`, and 9 unit tests. E2 added the outstanding halves once the schema existed: `src/test/fixtures.ts` (`useCleanTestDatabase()`, `createCohort()`, `createStaffUser()`, `createSubmission()`) and `src/data/SubmissionRepository.test.ts`, whose five integration tests include a create-and-read round trip and an explicit "leaves no residual data between tests" assertion. `npm test`: 16 passed.

---

## E2 — Database Schema, Content Versioning & Seed Data

**Rationale:** Establishes the persistent data model and version-controlled assessment content that every domain service, API route, and background job in later Epics reads from or writes to.

**What Done Means:**
- `prisma migrate dev` applies cleanly against a working Postgres database.
- All `content/versions/v1/*.json` files load and validate via `ContentLoader` at boot.
- A deliberately malformed content fixture causes the process to fail fast before serving any request.
- `SubmissionRepository`'s core surface creates and looks up a draft by cohort + normalized roll number.
- The seed script produces a working local cohort and staff account.

**Prerequisites:** E1 complete — the backend/frontend skeleton builds, `npm test` passes, and `.env.example` documents `DATABASE_URL`. A reachable Postgres database (local or Supabase dev) is configured.

**Files to Read:**
- `CLAUDE.md` — persistent Claude Code operating rules for this repository
- `PRD.md` — product requirements and behavioral constraints
- `ARCHITECTURE.md` — approved technical architecture
- `TASK_PLAN.md` — this Epic's task order, outputs, and completion state
- `prisma/` — existing schema/migrations, if any
- `content/` — existing content versions, if any
- `src/data/`, `src/content/` — existing data-access and content code

### Feature 2.1 — Database Schema & Migrations

- [x] T2.1.1 — Define the Prisma schema exactly as specified: `Cohort`, `Submission`, `ProcessingJob`, `StaffUser` models and the `SubmissionStatus`/`ProcessingStatus` enums.
      Ref: ARCHITECTURE Section 6 (Database Design)
      Output: prisma/schema.prisma matches Section 6's model definitions exactly, including `@@unique([cohortId, rollNumberNormalized])` and both indexes on `Submission`/`ProcessingJob`
- [x] T2.1.2 — Generate and apply the initial migration against a local/dev Postgres database, and verify the cohort+roll uniqueness constraint is enforced at the database level.
      Ref: ARCHITECTURE Section 6 (Why these choices — unique constraint), Section 16 (Database migrations)
      Output: prisma/migrations/<timestamp>_init · `prisma migrate dev` applies cleanly; a direct duplicate `(cohortId, rollNumberNormalized)` insert is rejected by Postgres
- [x] T2.1.3 — Implement `src/data/prismaClient.ts` as the single shared Prisma client instance used throughout the app.
      Ref: ARCHITECTURE Section 4 (Project Structure — src/data/prismaClient.ts)
      Output: src/data/prismaClient.ts · imported by repositories without creating multiple client instances
- [x] T2.1.4 — Implement `src/data/SubmissionRepository.ts`'s core read/write surface (find by id, find by cohort + normalized roll number, create draft). This lands in E2 rather than E4 because `StudentIdentityService` (T3.2.1) is its first consumer — the repository must exist before E3, not after it.
      Ref: ARCHITECTURE Section 4 (src/data/SubmissionRepository.ts), Section 6 (Submission model, uniqueness key), Section 18 (Canonical Locations — Database access)
      Output: src/data/SubmissionRepository.ts · integration test (test DB harness from T1.2.2) covers create-then-lookup by cohort + normalized roll

### Feature 2.2 — Content Versioning System

- [x] T2.2.1 — Author `content/versions/v1/*.json` (grammar-questions, vocabulary-questions, reading-questions, writing-prompt, writing-rubric, student-problems-statements) with structurally complete content including every metadata field FR-DET-002 requires (section, skill/topic label, difficulty level, question type, correct answer where applicable, prewritten explanation, scoring information).
      Ref: PRD Section 9.3 (FR-DET-002), Section 9.5 (FR-PROB-001/002), Section 10 (Assessment Structure); ARCHITECTURE Section 4 (content/ tree), Section 6 (writing-rubric.json)
      Output: content/versions/v1/*.json · valid JSON, each question/statement carries the required metadata fields
      **Content is structurally final but marked `provisional` in-file.** PRD Section 23.1 leaves the question set (item 3), Student Problems wording (item 4), rubric weights (item 1), and the writing prompt (item 2) to the team, so every file carries `contentStatus: "provisional"` plus a `statusNote` naming the open item — the schema rejects a `provisional` file that does not explain itself, so placeholder content can never read as approved. Authored: 9 grammar + 9 vocabulary + 8 reading questions (2 passages), spread 8 basic / 10 intermediate / 8 upper-intermediate; 15 Student Problems statements across all 7 areas; the rubric's five approved criteria with PRD-23.1 placeholder equal weights (20 each, schema-enforced to sum to 100).
- [x] T2.2.2 — Author `content/current-version.json` pointing to `"v1"` — the version new drafts start under.
      Ref: ARCHITECTURE Section 18 (Canonical Locations — current-version.json)
      Output: content/current-version.json · `ContentLoader.getCurrentVersion()` returns `"v1"`
- [x] T2.2.3 — Implement `src/content/contentSchemas.ts`: zod schemas validating each content file's shape, including `writing-rubric.json`'s LLM instructions and externalized scoring weights (never hardcoded).
      Ref: ARCHITECTURE Section 2 (zod for content validation), Section 6 (contentVersion / writing-rubric.json), Section 18
      Output: src/content/contentSchemas.ts · a malformed fixture content file fails validation with a clear error
- [x] T2.2.4 — Implement `src/content/ContentLoader.ts`: loads and validates all versions under `content/versions/*` at construction/boot, exposes `getContent(version)` and `getCurrentVersion()`, fails fast on any malformed version.
      Ref: ARCHITECTURE Section 4, Section 16 (Startup behavior — step 2), Section 18
      Output: src/content/ContentLoader.ts · unit test: `getContent('v1')` still resolves correctly after a fixture `v2` is added; boot throws on a malformed fixture version
- [x] T2.2.5 — Wire `ContentLoader` into the `server.ts` boot sequence so the process exits before accepting requests if any content version fails validation.
      Ref: ARCHITECTURE Section 16 (Startup behavior)
      Output: src/server.ts · starting the server against a deliberately broken content fixture exits non-zero before listening
      **Verified against a real broken file, not only a fixture tree.** With `content/versions/v1/grammar-questions.json` truncated to invalid JSON, `node src/server.ts` exited 1, printed `[server] Content validation failed — refusing to start.` with the file path and parse position, and never reached `app.listen`. The file was restored byte-identically afterwards and the server boots again.

### Feature 2.3 — Seed Data

- [x] T2.3.1 — Implement a seed script creating at least one `Cohort` (with access code) and one `StaffUser` (bcrypt-hashed password) for local development and testing. Hash with `bcrypt` directly at this stage; T3.1.2 introduces the shared `passwordHasher` wrapper and the seed is repointed at it there.
      Ref: PRD Section 6.2 (Staff accounts manually provisioned); ARCHITECTURE Section 6 (Cohort, StaffUser)
      Output: prisma/seed.ts · running the seed script populates a usable local dev cohort and staff login

---

## E3 — Identity, Sessions & Authentication

**Rationale:** Implements the shared session mechanism and both identity paths — student implicit identity and staff credentialed login — that every protected route in every later Epic depends on.

**What Done Means:**
- Student identity verification correctly matches/rejects cohort+roll+name combinations and issues a scoped student session.
- Staff login/logout correctly issues/clears a staff session using bcrypt-verified credentials.
- Staff-only and student-only middleware each reject the other session type.
- Rate limiting engages on repeated failed verify/login attempts.

**Prerequisites:** E2 complete — migrations apply cleanly, `ContentLoader` validates all content versions at boot, and the seed script produces a working cohort and staff account.

**Files to Read:**
- `CLAUDE.md` — persistent Claude Code operating rules for this repository
- `PRD.md` — product requirements and behavioral constraints
- `ARCHITECTURE.md` — approved technical architecture
- `TASK_PLAN.md` — this Epic's task order, outputs, and completion state
- `prisma/schema.prisma` — `Cohort`, `Submission`, `StaffUser` models
- `src/data/` — `prismaClient.ts`, `SubmissionRepository.ts`
- `src/content/ContentLoader.ts` — `getCurrentVersion()` for new drafts
- `src/app.ts`, `src/server.ts` — where routers and middleware are mounted

### Feature 3.1 — Session Infrastructure

- [x] T3.1.1 — Implement `src/auth/session.ts`: cookie/session configuration for two independent session types — staff session (≈8h) and student session (≈30 min inactivity) — both httpOnly, `Secure`, `SameSite=Lax`.
      Ref: ARCHITECTURE Section 9 (Session behavior), Section 13 (Sessions)
      Output: src/auth/session.ts · unit test confirms staff and student sessions are issued with distinct cookie identity/lifetimes and never grant access to each other's routes
- [x] T3.1.2 — Implement `src/auth/passwordHasher.ts` (bcrypt wrapper, cost factor 12), and repoint the T2.3.1 seed script at it so password hashing has exactly one implementation.
      Ref: ARCHITECTURE Section 13 (Password hashing), Section 2 (bcrypt)
      Output: src/auth/passwordHasher.ts · unit test: hash/verify round-trip succeeds, wrong password rejected · prisma/seed.ts uses the wrapper
- [x] T3.1.3 — Implement `src/api/middleware/requireStudentSession.ts` and `src/api/middleware/requireStaffSession.ts`, applied per-router rather than globally.
      Ref: ARCHITECTURE Section 9 (Session behavior — middleware applied per router)
      Output: src/api/middleware/requireStudentSession.ts, requireStaffSession.ts · integration test (using throwaway test-only routers, since the real staff routes arrive in T3.3.2): a staff-only route rejects a student session and vice versa

### Feature 3.2 — Student Identity Verification

- [x] T3.2.1 — Implement `src/domain/identity/StudentIdentityService.ts`: normalizes the roll number (trim/lowercase), verifies the cohort code + roll number + name combination against stored records, and finds-or-creates the draft `Submission` row (`status='draft'`, `contentVersion=ContentLoader.getCurrentVersion()`) when no existing submission is found.
      Ref: PRD Section 9.1 (FR-STU-001–007), Section 15 (NFR-SEC-001/002/008); ARCHITECTURE Section 1 (Student identity resolution), Section 6, Section 18 (Canonical Locations — `src/domain/identity/StudentIdentityService.ts`). Depends on `SubmissionRepository` (T2.1.4) and `ContentLoader.getCurrentVersion()` (T2.2.4)
      Output: src/domain/identity/StudentIdentityService.ts · unit+integration test: correct match resolves existing/new submission; mismatched roll/name/cohort returns a generic no-match; repeated calls for an existing submission never create a duplicate row
- [x] T3.2.2 — Implement `POST /api/session/student-verify`: calls `StudentIdentityService`, issues the student session cookie scoped to the resolved submission id, and returns the current status.
      Ref: ARCHITECTURE Section 10 (API contract — student-verify), Section 11 (Error Handling — identity not found), Section 3 (Data Flow)
      Output: src/api/session.routes.ts (student-verify) · integration test: valid identity issues a session with correct status; invalid identity returns a generic error that never reveals which field was wrong
- [x] T3.2.3 — Implement `src/api/middleware/validateBody.ts` (zod-based request validation) and apply it to `student-verify`.
      Ref: ARCHITECTURE Section 10 (validateBody middleware), Section 11 (Validation error)
      Output: src/api/middleware/validateBody.ts · a malformed request body returns 400 before reaching `StudentIdentityService`

### Feature 3.3 — Staff Authentication

- [x] T3.3.1 — Implement `src/domain/staff/StaffAuthService.ts`: verifies email/password against `StaffUser` via `passwordHasher`, issues the staff session on success.
      Ref: PRD Section 9.7 (FR-STAFF-001/002/003), Section 15 (NFR-SEC-003/004/010); ARCHITECTURE Section 18
      Output: src/domain/staff/StaffAuthService.ts · unit test: correct credentials succeed; wrong password and unknown email are rejected with an identical response (no user-enumeration signal)
- [x] T3.3.2 — Implement `POST /api/staff/login` and `POST /api/staff/logout`.
      Ref: ARCHITECTURE Section 10 (API contract — staff login/logout)
      Output: src/api/staff.routes.ts (login/logout) · integration test: login issues the staff session cookie; logout clears it; a protected staff route rejects the request after logout
- [x] T3.3.3 — Add per-IP rate limiting to `POST /api/session/student-verify` and `POST /api/staff/login`.
      Ref: ARCHITECTURE Section 13 (Rate limiting)
      Output: rate limiting applied to both routes · integration test: exceeding the configured threshold blocks further attempts

---

## E4 — Student Draft & Assessment-Taking Flow

**Rationale:** Delivers assessment content to a verified student session and persists in-progress answers safely, producing the editable draft state that submission finalization (E5) depends on.

**What Done Means:**
- A verified student session can fetch its draft content and existing answers.
- Section-level autosave persists one section's answers without disturbing any other section, including under concurrent requests.
- The assessment UI supports backward navigation and review without data loss.
- Writes to a submitted (non-draft) record are rejected server-side.

**Prerequisites:** E3 complete — `POST /api/session/student-verify` resolves identity, issues a scoped student session, and `requireStudentSession` rejects requests without one.

**Files to Read:**
- `CLAUDE.md` — persistent Claude Code operating rules for this repository
- `PRD.md` — product requirements and behavioral constraints
- `ARCHITECTURE.md` — approved technical architecture
- `TASK_PLAN.md` — this Epic's task order, outputs, and completion state
- `src/domain/identity/StudentIdentityService.ts` — how the draft is found/created
- `src/data/SubmissionRepository.ts` — existing read/write surface to extend
- `src/api/` — existing routes and middleware (`validateBody`, `requireStudentSession`)
- `src/content/ContentLoader.ts` — versioned content served to the assessment UI
- `frontend/src/` — existing router, pages, and API client

### Feature 4.1 — Draft Retrieval

- [x] T4.1.1 — Implement `GET /api/student/draft`: returns the active session's current answers plus the content for the draft's `contentVersion`.
      Ref: ARCHITECTURE Section 10 (API contract — GET draft), Section 5 (AssessmentPage data fetch)
      Output: src/api/student.routes.ts (GET draft) · integration test: returns saved answers and matching versioned content for an authenticated student session

### Feature 4.2 — Section-Level Autosave

- [x] T4.2.1 — Implement `PATCH /api/student/draft` using the atomic `answers = answers || jsonb_build_object($section, $sectionAnswers)` merge; reject the write when `status != 'draft'`.
      Ref: ARCHITECTURE Section 12 (Section-level autosave), Section 6 (Transaction boundaries #2)
      Output: src/api/student.routes.ts (PATCH draft), src/data/SubmissionRepository.ts (section merge method) · integration test: a PATCH to section A leaves section B untouched; two concurrent PATCHes to different sections both persist; a PATCH to a submitted record is rejected
- [x] T4.2.2 — Define zod validation schemas for each section's answer shape and apply them via `validateBody` on the PATCH route.
      Ref: ARCHITECTURE Section 10 (validateBody), PRD Section 9.2 (FR-ASSESS-002)
      Output: src/shared/types (section answer schemas) · a malformed section payload returns 400

### Feature 4.3 — Assessment Frontend

- [x] T4.3.1 — Build `EntryPage.tsx`: cohort code + roll number + name form, submits to `student-verify`, routes to `/assessment` for a fresh draft or `/report` for an existing submission, with a small, clearly labeled Staff login link.
      Ref: PRD Section 8.1 (Student journey steps 1–6), Section 9.1 (FR-STU-008); ARCHITECTURE Section 4, Section 9
      Output: frontend/src/pages/student/EntryPage.tsx · manual verification: valid identity routes correctly; invalid identity shows the generic error · the Staff login link points at the `/staff/login` route (the page itself is built in T8.3.2)
- [x] T4.3.2 — Build `AssessmentPage.tsx`: section-by-section navigation (Grammar → Vocabulary → Reading → Writing → Student Problems) with backward navigation/review allowed and no time limit.
      Ref: PRD Section 9.2 (FR-ASSESS-001/003/004/005), Section 10 (Assessment Structure)
      Output: frontend/src/pages/student/AssessmentPage.tsx · manual verification: student can navigate backward and forward without losing entered answers
- [x] T4.3.3 — Implement `frontend/src/hooks/useAutosave.ts`: debounces edits (~1.5s idle, or on blur/section navigation) and PATCHes only the current section; exposes an `idle | saving | saved | error` status.
      Ref: ARCHITECTURE Section 5 (useAutosave), Section 12
      Output: frontend/src/hooks/useAutosave.ts · manual verification: editing one section triggers no write to any other section; the save-status indicator updates correctly
- [x] T4.3.4 — Build the Student Problems section UI: the five-point agreement scale for every statement, plus the open-ended field accepting English **or** Arabic input (correct encoding and text direction). Show the required privacy notice ahead of the open-ended question, and gate the submit control so every required section is complete while a blank open-text field never blocks submission (the server-authoritative completeness check lives in T5.2.1).
      Ref: PRD Section 9.5 (FR-PROB-001/002/003/004/014, NFR-PRIV-009), Section 9.2 (FR-ASSESS-007), Section 18 (NFR-GEN-004 bilingual input)
      Output: Student Problems section UI · manual verification: notice is shown; Likert responses and Arabic open text persist and render correctly; a blank open-text field does not block submission; a blank required section does

---

## E5 — Deterministic Scoring & Submission Finalization

**Rationale:** Implements the server-authoritative transition from draft to immutable submission and the deterministic scoring that must be available immediately, producing the `Submission` state that background AI jobs (E6/E7) and staff views (E8) read.

**What Done Means:**
- `SubmissionService.finalize()` scores deterministic sections immediately, is idempotent on repeat calls, and relies on database-level uniqueness rather than application logic alone.
- `GET /api/student/report` shows deterministic results immediately after submit, before any AI job has run.
- A returning student (already submitted) is routed to the saved report, never a new draft.

**Prerequisites:** E4 complete — a verified student session can fetch its draft and autosave one section at a time, and writes to a non-draft record are rejected.

**Files to Read:**
- `CLAUDE.md` — persistent Claude Code operating rules for this repository
- `PRD.md` — product requirements and behavioral constraints
- `ARCHITECTURE.md` — approved technical architecture
- `TASK_PLAN.md` — this Epic's task order, outputs, and completion state
- `src/data/SubmissionRepository.ts` — transaction surface used by finalization
- `src/content/ContentLoader.ts` — answer keys and explanations for the frozen `contentVersion`
- `prisma/schema.prisma` — `ProcessingJob`, submission score and status columns
- `src/api/student.routes.ts` — existing student endpoints
- `frontend/src/pages/student/` — `EntryPage.tsx`, `AssessmentPage.tsx`

### Feature 5.1 — Deterministic Scoring Engine

- [x] T5.1.1 — Implement `src/domain/scoring/DeterministicScoringService.ts`: a pure function scoring Grammar/Vocabulary/Reading against `ContentLoader` content for the submission's `contentVersion`, including per-question prewritten-explanation lookup.
      Ref: PRD Section 9.3 (FR-DET-001/002/003/004); ARCHITECTURE Section 7 (DeterministicScoringService), Section 18
      Output: src/domain/scoring/DeterministicScoringService.ts + test · unit tests cover correct/incorrect scoring and explanation lookup against fixture content, with no database dependency

### Feature 5.2 — Submission Finalization

- [x] T5.2.1 — Implement `src/domain/submission/SubmissionService.finalize()`: transactional read-check-write — idempotent no-op if already submitted, rejects if required sections are incomplete, otherwise scores deterministic sections, sets `status='submitted'`/`submittedAt`, and inserts a `writing_eval` job (plus a `student_problems_text` job if open text was provided).
      Ref: PRD Section 9.2 (FR-ASSESS-008), Section 9.6 (FR-FEEDBACK-001); ARCHITECTURE Section 3 (Data Flow — Student Submits), Section 6 (Transaction boundaries #1), Section 12 (Immutable after submission, Safe retries), Section 18
      Output: src/domain/submission/SubmissionService.ts + SubmissionService.test.ts · integration test (real test DB): first submit succeeds; a second attempt for the same identity is an idempotent no-op; simulated concurrent submits never create two rows; incomplete required sections are rejected · job rows are inserted inside the finalize transaction directly (E6's `JobService`/`ProcessingJobRepository` consume them; they are not a prerequisite here)
- [x] T5.2.2 — Implement `POST /api/student/submit` calling `SubmissionService.finalize()`.
      Ref: ARCHITECTURE Section 10 (API contract — submit)
      Output: src/api/student.routes.ts (POST submit) · integration test: submit response contains deterministic results with `writingStatus='pending'`
- [x] T5.2.3 — Add a direct database-constraint test proving a duplicate `(cohortId, rollNumberNormalized)` insert is rejected by Postgres itself.
      Ref: ARCHITECTURE Section 6 (Why these choices), Section 15 (Database constraints test)
      Output: integration test in the SubmissionRepository suite · duplicate insert is rejected at the database level

### Feature 5.3 — Report Endpoint (Deterministic View)

- [x] T5.3.1 — Implement `GET /api/student/report`: reads the current `Submission` row and shapes deterministic sections (always populated once `status='submitted'`) plus current writing/problems processing status.
      Ref: PRD Section 9.6 (FR-FEEDBACK-001/004/008), Section 13 (Feedback and Result States); ARCHITECTURE Section 7 (Report generation), Section 10
      Output: src/api/student.routes.ts (GET report) · integration test: immediately after submit, response includes deterministic scores/explanations and `writingStatus='pending'` without waiting on any AI call
- [x] T5.3.2 — Build `ReportPage.tsx`: displays deterministic section scores and the per-question prewritten explanation for each answer given, immediately; shows "Writing feedback is still being prepared" while `writingStatus='pending'`; polls the report endpoint every ~10s only while pending; never implies the report is already complete.
      Ref: PRD Section 8.1 (step 9), Section 9.3 (FR-DET-004), Section 9.6 (FR-FEEDBACK-002/003/004/008); ARCHITECTURE Section 5 (ReportPage polling)
      Output: frontend/src/pages/student/ReportPage.tsx · manual verification: deterministic results visible immediately after submit; polling stops once status leaves 'pending'
- [x] T5.3.3 — Wire returning-visit routing: re-verifying identity for an already-submitted student re-issues the session and routes to `/report`, never `/assessment`.
      Ref: PRD Section 8.2 (Student journey — return visit), Section 9.1 (FR-STU-006); ARCHITECTURE Section 9 (Student routes)
      Output: EntryPage/session.routes.ts routing logic · manual verification: a returning student sees the saved report and cannot edit, restart, or resubmit

---

## E6 — AI Abstraction & Background Job Infrastructure

**Rationale:** Builds the provider-agnostic AI integration boundary and the serial job queue that Writing and Student Problems processing (E7) run on top of, fully testable via a fake provider before any real LLM call is wired in.

**What Done Means:**
- The worker loop claims, processes, and completes a pending job end-to-end using a fake AI provider.
- Concurrent claim attempts never double-claim the same job row.
- Stale jobs are automatically re-claimed after the threshold; exhausted retries transition to `failed_needs_review`.

**Prerequisites:** E5 complete — `SubmissionService.finalize()` creates `pending` `ProcessingJob` rows inside its transaction, so there is real work for the worker to claim.

**Files to Read:**
- `CLAUDE.md` — persistent Claude Code operating rules for this repository
- `PRD.md` — product requirements and behavioral constraints
- `ARCHITECTURE.md` — approved technical architecture
- `TASK_PLAN.md` — this Epic's task order, outputs, and completion state
- `prisma/schema.prisma` — `ProcessingJob` model and its `[status, nextAttemptAt]` index
- `src/data/` — `SubmissionRepository.ts`, `prismaClient.ts`
- `src/domain/submission/SubmissionService.ts` — where jobs are enqueued
- `src/server.ts` — documented boot order the worker loop attaches to

### Feature 6.1 — AI Abstraction Boundary

- [x] T6.1.1 — Define `src/ai/AIEvaluationService.ts` (interface: `evaluateWriting(text, rubricInstructions)`, `processStudentProblemsText(text)`) and `src/ai/errors.ts` (`AIValidationError`, `AIRetryableError`, `AINonRetryableError`).
      Ref: ARCHITECTURE Section 4 (src/ai/), Section 18
      Output: src/ai/AIEvaluationService.ts, src/ai/errors.ts
- [x] T6.1.2 — Implement `src/ai/schemas.ts`: zod schemas for the expected LLM JSON output (criterion-level writing scores, Student Problems categories).
      Ref: PRD Section 9.4 (FR-WRITE-005/007), Section 9.5 (FR-PROB-011); ARCHITECTURE Section 2 (zod), Section 3 (schema validation step)
      Output: src/ai/schemas.ts · unit test: a well-formed fixture passes; a missing field, wrong type, or out-of-range score fails
- [x] T6.1.3 — Implement a `FakeAIEvaluationService` test double implementing `AIEvaluationService`, used throughout the test suite so CI never depends on Ollama Cloud reachability.
      Ref: ARCHITECTURE Section 15 (Mocking Ollama)
      Output: test fixture/fake provider · reused across job, worker, and end-to-end tests

### Feature 6.2 — Job Persistence & Lifecycle

- [x] T6.2.1 — Implement `src/data/ProcessingJobRepository.ts` including the claim query (`UPDATE ... WHERE id = (SELECT ... FOR UPDATE SKIP LOCKED)`).
      Ref: ARCHITECTURE Section 8 (Claiming), Section 6 (ProcessingJob model, index)
      Output: src/data/ProcessingJobRepository.ts · integration test: simulated concurrent claim attempts never claim the same row twice
      **Proven by removing the mechanism, not by the test merely passing.** With `FOR UPDATE SKIP LOCKED` deleted outright, 8 concurrent claims over 8 jobs returned as few as 4 distinct jobs (work silently unclaimed) and 8 claims over 1 job returned that same job 4 times (a genuine double-claim) — failing on every run. `SKIP LOCKED` alone removed (keeping `FOR UPDATE`) blocks the claim instead, which the deterministic test catches 3/3: it holds the row lock in a second transaction and asserts the claim answers null without waiting. Timing was measured first, because which of the statistical tests catches the missing clause varies run to run; only the lock-holding test fails reliably, so that is the one the guarantee rests on.
      The claim deliberately does **not** increment `attemptCount` — Section 8 puts that in the failure path, and counting both would double every ordinary failure, making `MAX_ATTEMPTS` mean half what it says.
- [x] T6.2.2 — Implement `src/domain/jobs/JobService.ts`: `claimNextJob` (with stale-job reclamation via `STALE_THRESHOLD_MS`), `completeJob` (transactional result write + job status), `failJob` (retry/backoff bookkeeping, `MAX_ATTEMPTS` → `failed_needs_review`).
      **`JOB_TYPES` was MOVED, not copied**, from `src/domain/submission/SubmissionService.ts` to `src/domain/jobs/jobTypes.ts` (with `isJobType`), as E5's comment invited. The alternative was JobService and the worker loop importing the submission *service* — and through it the content loader and scoring engine — to obtain two string literals. Same reasoning as `src/shared/types/sections.ts`. `SubmissionService` and its test now import from the new home; no re-export was left behind.
      `completeJob` deliberately leaves `writingOverallScore` null (the calculator is T7.1.1, called from here by T7.3.1), so **E7 has less to add than its task text implies**: the criteria scores, the feedback, and the Student Problems derived write already happen here, for both job types. T7.3.1 adds the score calculation; T7.4.1's derived-column write already exists.
      Retry policy is a parameter (`maxAttempts` + a `backoffMs` schedule), so no test waits on a clock. Section 8's "a schema-validation failure is retryable **once**" is implemented as a two-attempt budget for `AIValidationError` specifically.
      Ref: PRD Section 9.4 (FR-WRITE-011), Section 9.5 (FR-PROB-013); ARCHITECTURE Section 8 (Retries and backoff, Stale jobs), Section 6 (Transaction boundaries #4), Section 18
      Output: src/domain/jobs/JobService.ts + test · integration test: retry/backoff transitions are correct; a stale job is re-claimed after the threshold; exhausted retries produce `failed_needs_review`; the original response is never touched on failure
- [x] T6.2.3 — Implement `SubmissionRepository.getEvaluationContext(submissionId, jobType)`: resolves authoritative response text + `contentVersion` from the `Submission` row only, never from `ProcessingJob` fields.
      Ref: ARCHITECTURE Section 8 (What a job contains vs. what the worker resolves), Section 18
      Output: src/data/SubmissionRepository.ts (getEvaluationContext) · unit+integration test: returns the correct shape for both job types; throws clearly if the expected field is missing (e.g. a `writing_eval` job for a submission with no writing answer)

### Feature 6.3 — Worker Loop

- [x] T6.3.1 — Implement `src/background/workerLoop.ts`: a `setInterval` poll tick (7s) with an `isRunning` guard against overlapping ticks; claims one job, resolves evaluation context and frozen content version, invokes `AIEvaluationService`, validates output, persists via `JobService`, and routes failures to `failJob`.
      **The `isRunning` guard was proven by removing it**: two ticks fired together then both reached the provider (2 calls, not 1) — the single-in-flight-request constraint Section 8 designs around. `tick()` also never rejects, which is a contract rather than caution: its caller is a `setInterval` callback, and a rejection there is an unhandled rejection that ends the process running the API. `POLL_INTERVAL_MS`/`STALE_THRESHOLD_MS`/`MAX_ATTEMPTS`/backoff are `WorkerLoopSettings` parameters defaulting to Section 8's illustrative values, so no test waits on a clock.
      Ref: ARCHITECTURE Section 8 (workerLoop illustrative code), Section 3 (Data Flow — Background Writing Evaluation)
      Output: src/background/workerLoop.ts · integration test (with `FakeAIEvaluationService`): a pending job is claimed, processed, and marked succeeded within a few poll ticks
- [x] T6.3.2 — Wire the worker loop into the `src/server.ts` boot sequence, started after the Express server per the documented startup order.
      Ref: ARCHITECTURE Section 16 (Startup behavior — steps 3–4)
      Output: src/server.ts · starting the app starts the HTTP server and the worker loop exactly once each
      **There is no production AI provider in this build, so what a production boot does is a decision, not an omission.** `selectAIEvaluationService()` is the explicit injectable seam (Section 17's "selected via configuration") and returns `null`; on `null`, `server.ts` boots the API, does **not** start the loop, and logs why, naming T7.2.3. The rejected alternative — starting the loop against a provider that answers every call with an error — would write `failed_needs_review` onto real submissions, which claims *"processing failed, a human should look at this"* when the truth is *"processing was never attempted"*; the jobs correctly stay `pending` instead. **T7.2.3 is a one-line change to this function and nothing else.**
      Verified live, both ways. Unpatched: `HTTP 200`, log reads `background worker loop was NOT started`. With the seam temporarily returning a fake (patched, run, reverted — not committed), the boot log showed `background worker started (polling every 7000ms, up to 3 attempts per job)` **exactly once** alongside a single `listening on …`, and a real submission driven over HTTP through `PILOT-2026` went `pending/pending → succeeded/pending (t+3.1s) → succeeded/succeeded (t+9.9s)` on the 7s poll — the first time `ReportPage`'s poll has had a status that can actually move. `writingOverallScore` was still `null` in the live row, confirming the E6 boundary holds outside the suite. Rows deleted from `lexora_dev` afterwards.

---

## E7 — Writing Evaluation & Student Problems AI Processing

**Rationale:** Implements the two concrete AI evaluation flows and the deterministic scoring layered on top of Writing's LLM output, completing the report data that student-facing and staff-facing views depend on.

**What Done Means:**
- `WritingScoreCalculator` produces correct 0–100 scores from fixture criteria and weights.
- A full `writing_eval` job run (fake provider) produces persisted criteria scores, overall score, and feedback, visible on the report.
- Student Problems AI processing writes only to derived fields, never overwriting the original open-text response.
- Failure paths for both job types preserve original data and surface "needs review" without blocking the rest of the report.

**Prerequisites:** E6 complete — the worker loop claims, processes, and completes a job end-to-end against `FakeAIEvaluationService`, and retry/stale/failure transitions are proven.

**Files to Read:**
- `CLAUDE.md` — persistent Claude Code operating rules for this repository
- `PRD.md` — product requirements and behavioral constraints
- `ARCHITECTURE.md` — approved technical architecture
- `TASK_PLAN.md` — this Epic's task order, outputs, and completion state
- `src/ai/` — `AIEvaluationService.ts`, `schemas.ts`, `errors.ts`
- `src/domain/jobs/JobService.ts`, `src/background/workerLoop.ts`
- `content/versions/v1/writing-rubric.json` — rubric instructions and externalized weights
- `src/api/student.routes.ts`, `frontend/src/pages/student/ReportPage.tsx` — report surfaces to extend

### Feature 7.1 — Writing Score Calculation

- [x] T7.1.1 — Implement `src/domain/scoring/WritingScoreCalculator.ts`: a pure function computing the 0–100 overall score via the fixed weighted-sum formula from the five criterion scores plus `writingRubricWeights` read from the versioned content bundle (never hardcoded).
      Ref: PRD Section 9.4 (FR-WRITE-006/009); ARCHITECTURE Section 7 (WritingScoreCalculator), Section 18
      Output: src/domain/scoring/WritingScoreCalculator.ts + test · unit tests assert formula correctness against fixture weights, including boundary values (0, 100)

### Feature 7.2 — Ollama Provider Integration

- [x] T7.2.1 — Implement `src/ai/OllamaProvider.ts`: the only file that knows about Ollama; builds the fixed rubric prompt from `content.writingRubricInstructions`, requests structured JSON, enforces a request timeout (e.g. 60s), and reads `OLLAMA_API_KEY`/`OLLAMA_BASE_URL` from environment variables only.
      Ref: PRD Section 9.4 (FR-WRITE-003/004); ARCHITECTURE Section 1 (AI-assisted scoring), Section 8, Section 13 (API key protection), Section 14 (Timeouts), Section 18
      Output: src/ai/OllamaProvider.ts · test (against a stubbed HTTP layer, never real Ollama) confirms request shape, timeout enforcement, and that no route/log line ever includes the API key
- [x] T7.2.2 — Implement `evaluateWriting()` and `processStudentProblemsText()` on `OllamaProvider`, validating responses against `src/ai/schemas.ts` before returning.
      Ref: PRD Section 9.4 (FR-WRITE-005/007/008), Section 9.5 (FR-PROB-010/011); ARCHITECTURE Section 3 (Data Flow — Background Writing Evaluation)
      Output: src/ai/OllamaProvider.ts (evaluateWriting, processStudentProblemsText) · unit test with mocked HTTP responses: malformed JSON throws `AIValidationError`, network/timeout throws `AIRetryableError`
- [x] T7.2.3 — Wire `OllamaProvider` as the production `AIEvaluationService` implementation selected via configuration, with `FakeAIEvaluationService` used in all automated tests.
      Ref: ARCHITECTURE Section 17 (Alternative/additional AI providers — seam), Section 15 (Mocking Ollama)
      Output: dependency wiring in server/app assembly · the automated test suite never calls real Ollama; production boot uses `OllamaProvider`

### Feature 7.3 — Writing Evaluation Flow Integration

- [x] T7.3.1 — Extend `JobService.completeJob()` so a succeeded `writing_eval` job calls `WritingScoreCalculator.computeOverallScore()` before persisting, writing `writingCriteriaScores`, `writingOverallScore`, `writingFeedback`, and `writingStatus='succeeded'` transactionally.
      Ref: PRD Section 9.4 (FR-WRITE-006/007); ARCHITECTURE Section 3, Section 6 (Transaction boundaries #4), Section 18
      Output: src/domain/jobs/JobService.ts (completeJob writing_eval branch) · integration test: full pending→claimed→succeeded flow (with `FakeAIEvaluationService`) produces the correct `writingOverallScore`
      **The weights are resolved inside `completeJob`, from the version it is given.** `CompleteJobOptions.contentVersion` (required, from `getEvaluationContext`) is resolved through the `ContentLoader` the service now takes, so the weights a result is scored against are always the frozen version's. Three tests pin it: the score is the weighted sum read from the bundle; a version that does not exist throws (`/Unknown content version/`) and writes nothing; an evaluation missing a weighted criterion throws and leaves the row at `pending` rather than storing a plausible short total.
- [x] T7.3.2 — Verify writing-evaluation failure handling end-to-end: original response text preserved, retries exhausted, `writingStatus='failed_needs_review'`.
      Ref: PRD Section 9.4 (FR-WRITE-011), Section 19 (EDGE-004); ARCHITECTURE Section 8 (Retries and backoff)
      Output: integration test using a `FakeAIEvaluationService` configured to always fail · after `MAX_ATTEMPTS`, `writingStatus='failed_needs_review'` and `answers.writing.essayText` is unchanged
      **Driven through the loop, not through `failJob`.** The provider fails *retryably*, so only the attempt budget can end the job — three ticks with `nextAttemptAt` rewound between them. The essay is compared byte-for-byte against the row as it stood before the first attempt, and the three deterministic scores are asserted unchanged (FR-FEEDBACK-007).
- [x] T7.3.3 — Update `GET /api/student/report` and `ReportPage.tsx` to surface writing results once `writingStatus='succeeded'` (criterion scores, overall score, strengths/weaknesses/corrections/suggestions) or the "processing failed / needs review" status.
      Ref: PRD Section 9.4 (FR-WRITE-007), Section 9.6 (FR-FEEDBACK-003/007), Section 13 (Feedback and Result States table)
      Output: src/api/student.routes.ts (GET report — writing fields), frontend ReportPage.tsx · integration/manual verification: all four states in Section 13's table render correctly
      **`writing` is a field separate from `writingStatus`**, because "your feedback is ready" is only true if the response carries feedback — the page branches on `writing !== null`, not on `succeeded`, so it can never announce results it was not handed. Criteria are ordered and labelled from `writingRubric.criteria` in the submission's frozen version, never restated in code; the rubric's instructions and weights are asserted absent from the response. Verified live against the built production server with a local stub standing in for Ollama (no external call, no quota): draft → pending → succeeded with the full block → `failed_needs_review` with the essay byte-identical. The frontend is rendered from that response but was **not** checked in a browser — Section 15 makes frontend coverage manual, and none was available in this session.

### Feature 7.4 — Student Problems AI Processing

- [x] T7.4.1 — Extend `JobService`/`completeJob` so a succeeded `student_problems_text` job writes only to `problemsTextDerived` (normalizedText, categories), never touching `problemsOpenTextOriginal`, and sets `problemsTextStatus='succeeded'`.
      Ref: PRD Section 9.5 (FR-PROB-009/010/011); ARCHITECTURE Section 6 (problemsOpenTextOriginal vs. problemsTextDerived), Section 12 (Original data preservation)
      Output: src/domain/jobs/JobService.ts (completeJob student_problems_text branch) · integration test: derived data is written; the original column is provably unchanged before and after
      **The write already existed from E6** — this task was verification, and the test was strengthened to cover the whole of "only the derived column": the stored value is asserted to be exactly `{normalizedText, categories}`, and `problemsLikertAnswers` and `answers` are now asserted unchanged alongside the original open text.
- [x] T7.4.2 — Verify Student Problems processing failure handling: original open-text response preserved, `problemsTextStatus='failed_needs_review'` after retries exhausted, rest of the report unaffected.
      Ref: PRD Section 9.5 (FR-PROB-013), Section 19 (EDGE-008)
      Output: integration test using a failing `FakeAIEvaluationService` · original text preserved, rest of the report unaffected
      **Same loop-driven shape as T7.3.2.** `problemsTextDerived` is additionally asserted `null` — a half-written analysis would be worse than none — and the three deterministic scores plus `writingStatus` are unchanged, which is "the rest of the report is unaffected" read literally.
- [x] T7.4.3 — Confirm Student Problems Likert responses and derived data never influence any English proficiency score (no code path in `DeterministicScoringService` or `WritingScoreCalculator` reads `problemsLikertAnswers`/`problemsTextDerived`).
      Ref: PRD Section 9.5 (FR-PROB-008/012)
      Output: code review checkpoint + unit test asserting the scoring services accept no Student Problems input · test fails if such a dependency is ever introduced
      **Tested by varying the data, not by reading the signature** — a signature check would pass for an implementation that read `answers.studentProblems` directly, which is the mistake actually available. `DeterministicScoringService`: opposite ends of the Likert scale, the section absent entirely, and open text that *is* a correct answer key all produce byte-identical results. `WritingScoreCalculator`: no Student Problems parameter exists, so the guard is structural (arity) plus a no-ambient-state test, with the guard's limits stated in the comment rather than overclaimed. One integration test closes the loop at the system level: two submissions differing only in Student Problems produce identical Grammar, Vocabulary, Reading, and writing-overall scores through `GET /api/student/report`.

---

## E8 — Staff Dashboard & Reporting

**Rationale:** Builds the internal analysis views and export on top of the now-complete submission data model, letting staff view aggregate patterns and individual records. Reuses the staff-session infrastructure from E3.

**Execution order:** `T8.3.2` (staff `LoginPage`) is built **first**, then the remaining tasks in the order listed below.

The reason is that three later tasks carry "manual verification" that is otherwise unreachable: `T8.2.2` and `T8.3.1` are staff pages behind a staff session, and `T8.4.2`'s export control lives on the dashboard. Section 9's route table puts every staff page behind login, and no staff page exists yet — so without a login page the verification step for those tasks can be run only at the API level, which is not what their `Output:` conditions ask for. Doing `T8.3.2` first makes the rest of the Epic checkable in the way the plan intends.

Task **identifiers are unchanged**. `T8.3.2` stays `T8.3.2` and stays listed under Feature 8.3, where it belongs by subject; only the order of execution differs, and it differs explicitly rather than by a session quietly reordering work. `frontend/src/App.tsx` already names this task at the `/staff/login` route.

**What Done Means:**
- The dashboard shows accurate counts/distributions/patterns for seeded fixture data, filterable by cohort.
- The individual submission view is staff-session-gated and logs each access.
- CSV export produces a correct, cohort-filterable file.
- Student Problems derived data is visually distinguished from the original response.

**Prerequisites:** E7 complete — submissions carry deterministic scores, writing evaluation results/status, and Student Problems original + derived data, so there is real data to aggregate.

**Files to Read:**
- `CLAUDE.md` — persistent Claude Code operating rules for this repository
- `PRD.md` — product requirements and behavioral constraints
- `ARCHITECTURE.md` — approved technical architecture
- `TASK_PLAN.md` — this Epic's task order, outputs, and completion state
- `prisma/schema.prisma` — columns and indexes the aggregate queries rely on
- `src/domain/staff/StaffAuthService.ts`, `src/api/middleware/requireStaffSession.ts` — existing staff auth from E3
- `src/api/staff.routes.ts` — existing staff routes
- `src/data/` — repositories available to `DashboardService`
- `frontend/src/pages/staff/` — existing staff pages and the API client

### Feature 8.1 — Dashboard Aggregate Queries

- [x] T8.1.1 — Implement `src/domain/staff/DashboardService.ts`: submission counts + completion status, overall/section-level score distributions (Grammar/Vocabulary/Reading/Writing comparison), most common Student Problems responses, cohort filter.
      Ref: PRD Section 9.7 (FR-STAFF-004/005/006/008/009); ARCHITECTURE Section 14 (Dashboard aggregation — plain SQL, no caching), Section 18
      Output: src/domain/staff/DashboardService.ts + test · integration test: correct counts/averages against seeded fixture data, including cohort filtering
- [x] T8.1.2 — Implement the Basic/Intermediate/Upper-intermediate difficulty-level comparison as a conditional capability that only renders when the underlying content metadata/question distribution supports a meaningful comparison.
      Ref: PRD Section 9.7 (FR-STAFF-007)
      Output: DashboardService difficulty-level query · test confirms the comparison is omitted rather than shown misleadingly when metadata is insufficient
- [x] T8.1.3 — Implement `GET /api/staff/dashboard`.
      Ref: ARCHITECTURE Section 10 (API contract — dashboard)
      Output: src/api/staff.routes.ts (GET dashboard) · integration test: an authenticated staff session receives the aggregate payload; an unauthenticated request is rejected

### Feature 8.2 — Individual Submission Access

- [x] T8.2.1 — Implement `GET /api/staff/submissions/:id`, returning full submission detail (answers, scores, writing evaluation, Student Problems original + derived data) and emitting the structured pino staff-access log line.
      Ref: PRD Section 9.7 (FR-STAFF-010), Section 15 (NFR-PRIV-004); ARCHITECTURE Section 13 (Staff data access is logged), Section 18
      Output: src/api/staff.routes.ts (GET submissions/:id) · integration test: response includes the expected fields; log output contains `{ event: 'staff_submission_access', staffUserId, submissionId, timestamp, action: 'view' }`
- [x] T8.2.2 — Build `SubmissionDetailPage.tsx`, clearly labeling Student Problems AI-derived categories/normalized text as derived, not the student's original words.
      Ref: PRD Section 9.5 (FR-PROB-011), Section 9.7 (FR-STAFF-010)
      Output: frontend/src/pages/staff/SubmissionDetailPage.tsx · manual verification: derived data is visually distinguished from the original response
- [x] T8.2.3 — Add a recent-submissions list to `DashboardPage.tsx`, so an individual submission is reachable from the interface.
      Ref: PRD Section 9.7 (FR-STAFF-010, FR-STAFF-012), Section 8.3 (Staff journey step 3); ARCHITECTURE Section 10 (the API is fixed at ten endpoints — the list rides on `GET /api/staff/dashboard`), Section 18
      Output: DashboardPage.tsx submissions list + `DashboardService.recentSubmissions` · integration test: rows are cohort-filtered, newest first, and capped

      **Added mid-Epic (2026-09-16), not in the original plan.** E8 as written satisfies FR-STAFF-010
      by building the route (T8.2.1) and the page (T8.2.2) but gives staff no way to *reach* the
      page: no task in E8 put a link to it anywhere, so the view existed only at a URL a staff
      member would have to know. FR-STAFF-010 says staff "must be able to view individual
      submissions", which a page with no inbound path does not deliver. This task closes that gap and
      nothing else — it is the smallest list that makes the existing page reachable, deliberately not
      a sortable, searchable, pageable table (FR-STAFF-012), and deliberately not an eleventh
      endpoint (Section 10). Flagged in the commit that added it.

### Feature 8.3 — Dashboard Frontend

- [x] T8.3.1 — Build `DashboardPage.tsx`: fetches aggregate data on load and on cohort-filter change; renders submission counts/completion, score distributions, and Student Problems patterns.
      Ref: PRD Section 9.7 (FR-STAFF-004/005/006/008/009/012); ARCHITECTURE Section 5 (DashboardPage)
      Output: frontend/src/pages/staff/DashboardPage.tsx · manual verification: changing the filter re-fetches and updates the displayed metrics
- [x] T8.3.2 — Build staff `LoginPage.tsx`.
      Ref: PRD Section 9.7 (FR-STAFF-001)
      Output: frontend/src/pages/staff/LoginPage.tsx · manual verification: valid login routes to the dashboard; invalid login shows a generic error

### Feature 8.4 — CSV Export

- [x] T8.4.1 — Implement `GET /api/staff/export.csv` using `csv-stringify` for a streamed export, optionally filtered by cohort, covering the full submission dataset needed for external analysis.
      Ref: PRD Section 9.7 (FR-STAFF-011), Section 4 (G5); ARCHITECTURE Section 2 (csv-stringify), Section 10 (API contract — export)
      Output: src/api/staff.routes.ts (GET export.csv) · integration test: output includes the expected columns/rows for a seeded dataset and respects the cohort filter
- [x] T8.4.2 — Add a staff-facing export trigger in `DashboardPage.tsx`.
      Ref: PRD Section 8.3 (Staff journey step 4)
      Output: DashboardPage.tsx export control · manual verification: clicking export downloads a CSV

---

## E9 — Security, Error Handling & Deployment Hardening

**Rationale:** Closes out the cross-cutting non-functional requirements — generic error surfaces, logging redaction, health/keep-warm endpoint, production deployment configuration — that apply across every flow built in E3–E8, leaving the repository ready for the pilot's actual hosting environment.

**What Done Means:**
- Every failure class in Architecture Section 11 returns its specified generic message without leaking internal detail.
- Logs are structured JSON with API keys/authorization redacted.
- `/health` returns 200 against a reachable database.
- Deployment configuration runs migrations before serving traffic.

**Prerequisites:** E3–E8 complete — every route, session boundary, and background path that this Epic hardens already exists.

**Files to Read:**
- `CLAUDE.md` — persistent Claude Code operating rules for this repository
- `PRD.md` — product requirements and behavioral constraints
- `ARCHITECTURE.md` — approved technical architecture
- `TASK_PLAN.md` — this Epic's task order, outputs, and completion state
- `src/api/` — all routes and middleware (error surfaces, validation)
- `src/auth/` — session and password configuration
- `src/server.ts`, `src/app.ts` — boot order, logging, static asset serving
- `package.json` — build/start scripts referenced by the deployment configuration

### Feature 9.1 — Error Handling

- [x] T9.1.1 — Implement centralized Express error-handling middleware mapping each failure class in Architecture Section 11's table to its user-facing response (validation 400, identity-not-found generic message, authorization 401/403, database 500 with a generic message), never leaking stack traces, SQL, or prompt content.
      Ref: ARCHITECTURE Section 11 (Error Handling Strategy)
      Output: src/api/middleware (error handler) · integration test: each failure class returns the specified generic message and status; full detail is retained server-side in logs

      **The handler is the recipient those `next(error)` calls never had.** Every route already ended
      its handler with `next(error)` because Express 4 does not forward async rejections, but no error
      middleware existed to receive them, so they fell through to Express's built-in handler — which
      answers `text/html` with the stack embedded outside production. `src/api/middleware/errorHandler.ts`
      is mounted last in `createApp()` (Express dispatches error middleware in registration order, so a
      handler mounted above the routers would be inert) and maps: a 4xx status carried on the error →
      that status; `ZodError` → 400 with the field-level body; `res.headersSent` → delegate to
      Express's own handler so a mid-stream CSV failure truncates the download instead of pretending
      to have completed; everything else → 500 with Section 11's generic message, full detail logged.
      Identity-not-found (400 generic) and authorization (401) are answered by `StudentIdentityService`
      and `requireSession` before any error is raised, so the handler does not re-answer them — the
      integration test asserts all four classes against the real assembled app instead.

      **A regression this task introduced, caught by probing rather than by the test suite.** The first
      version answered every non-`ZodError` with 500 — including `express.json()`'s own pre-classified
      400 for an unparseable body, which Express's default handler had been honouring. Section 11 files
      a malformed payload under "Validation error" → 400, so that would have quietly reclassified a
      client mistake as a server failure. The 4xx branch above is the fix, and it is the whole 4xx range
      rather than a special case for the parser, which keeps behaviour identical to what it replaced.
      Measured, not assumed: `node dist/prove-error-mapping.mjs` and `node dist/probe-json-body.mjs`
      build the pre-T9.1.1 assembly (routers, no handler) beside `createApp()` and force one failure
      each. Before: `500 text/html` carrying `PrismaClientKnownRequestError`, the SQL, and the stack /
      `400 text/html` carrying the `SyntaxError` stack. After: `500 application/json
      {"error":"Something went wrong — your answers are saved"}` / `400 application/json
      {"error":"Invalid request body"}`, with the stack retained server-side. (Both scripts live in
      gitignored `dist/`, alongside E8's `dist/drive-ui.mjs` — they are scratch verification harnesses,
      not build output, and they are re-runnable after `npm run build`.)

      **Logging here is the same interim `src/server.ts` uses** — `console.error` with the T9.2.1 note —
      because the project-wide `pino` configuration is T9.2.1's task and this one precedes it. What
      T9.1.1 owes is that the detail is *retained* rather than discarded, which is what makes the
      browser's generic message a reduction instead of a deletion. The test spies on the `console.error`
      call rather than intercepting `process.stderr.write` (the technique `staff.routes.test.ts` uses for
      `pino`'s stdout): vitest replaces `console` with its own buffering object, so a stream interceptor
      observes an empty string that reads as "nothing was logged" — confirmed with a throwaway probe
      before the test was written. `npm test`: 438 passed, 27 files.
- [x] T9.1.2 — Confirm submission-conflict handling (retry/double-click on an already-submitted draft) returns the existing report as a success, not an error.
      Ref: ARCHITECTURE Section 11 (Submission conflict), Section 12 (Safe retries on submit)
      Output: regression test on POST /api/student/submit · a duplicate submit returns 200 with the same report body

      **Confirmed against existing coverage; no second test written.** The task is worded "Confirm",
      and the `Output:` condition is met verbatim by `src/api/student.routes.test.ts` —
      *"treats a second submit as success and answers with the same report"* asserts both POSTs
      `.expect(200)` and `expect(second.body).toEqual(first.body)`, which is "200 with the same report
      body" exactly. Alongside it, *"does not enqueue a second round of jobs on a repeated submit"*
      pins the consequence that a duplicate transition would otherwise show up as (a second pair of
      jobs, and a second AI evaluation the student would see twice). `src/domain/submission/SubmissionService.test.ts`
      carries the same guarantee one layer down, including that the second call returns the *same row*
      with the same `submittedAt` and scores rather than a fresh transition that happens to look alike.

      **The one plausible gap — concurrent submits — is already covered, so it is not a gap.** The
      route is a pass-through of `finalize`'s outcome (`student.routes.ts` maps `finalized` and
      `already_submitted` to the same `res.json(toStudentReport(...))`), so the race lives entirely in
      the service, and `SubmissionService.test.ts` exercises it twice: two simultaneous finalizes
      resolve to exactly one `finalized` and one `already_submitted`, and five simultaneous finalizes
      to one and four — each leaving one submission row, one `submittedAt`, and exactly two jobs. That
      is Section 15's "concurrent simultaneous submit requests (simulated) never create two rows" and
      Section 12's "the finalize transaction is idempotent by construction". Adding a route-level
      concurrency test would re-assert a guarantee the layer that owns it already proves.

### Feature 9.2 — Logging & Observability

- [x] T9.2.1 — Configure `pino` structured JSON logging to stdout across the application, with redaction of any field named `apiKey`/`authorization`.
      Ref: ARCHITECTURE Section 13 (API key protection — pino redact), Section 16 (Logging)
      Output: logging configuration module · test confirms a log line containing an `apiKey` field is redacted in output

      **A move, not an addition.** E8 put a module-level `pino` instance in `src/api/staff.routes.ts`
      to emit Section 13's one access line, with a comment saying the project-wide logging task would
      decide where the instance lives. `src/config/logger.ts` is that decision, and it is the process's
      only logger. Section 18 records the canonical location for the *log line* — `staff.routes.ts` —
      and the line did not move; only the configuration did. `console.*` is now gone from `src/` except
      for the test harness's own startup warnings.

      **Three details were carried over unchanged, and each would have failed silently.** The
      destination stays `pino({…}, process.stdout)` with the stream named explicitly rather than left to
      the fd default, because a module-level logger binds an fd destination at *import* time and the
      tests that read the real line off stdout would see nothing. The `redact` paths keep their `*.`
      forms alongside the two bare names Section 13 spells out. And there is one instance, so a field
      is redacted everywhere or nowhere.

      **A limit discovered while testing, and documented rather than papered over.** One `*` spans
      exactly one level and `fast-redact` has no recursive wildcard, so `{req:{headers:{authorization}}}`
      is *not* redacted — the secret sits two levels below a matched name. That is a real limit of
      expressing "any field literally named `apiKey`" as a path list; it is acceptable here because
      nothing in this application logs a whole request object, and every field reaching the logger is
      written out explicitly at its call site. `src/config/logger.ts` says so, and the test asserts the
      one-level case (which the bare paths alone would miss) rather than claiming more.

      **The E8 redaction test was proving a copy.** It constructed its own `pino` instance with the
      same options inline, so it would have kept passing had `src/config/logger.ts` lost its `redact`
      block entirely. It now reads the application's logger. `src/config/logger.test.ts` covers the
      configuration directly: top-level and one-level-nested redaction, an unrelated field left alone
      (so redaction is not a blanket censor), and one parseable JSON object per line on stdout.
      `errorHandler.test.ts` moved from spying on `console.error` to intercepting stdout, because the
      handler logs through the real logger now. `npm test`: 446 passed, 30 files.
- [x] T9.2.2 — Implement `GET /health`, performing a trivial DB query, for use as an external keep-warm ping target.
      Ref: ARCHITECTURE Section 16 (Mitigation — external free scheduled ping)
      Output: src/api (health route) · integration test: returns 200 when the DB is reachable, 5xx when it is not

      **The mount order is the whole task.** In production `createApp()` calls `mountFrontendBundle(app)`
      *before* the routers, and that registers a catch-all for anything not under `/api`. A `/health`
      registered after it is never reached: production answers a health check with `index.html` and a
      **200**. That is the worst failure mode this endpoint can have — it reports healthy no matter what
      the database is doing, so Render would stay awake, the database would still go cold, and the
      keep-warm ping would be the last thing to notice. `app.use('/health', healthRouter)` is therefore
      mounted *above* the bundle, with the reason at the call site.

      **Proven by removing the fix, not by the test passing.** With the mount moved back below
      `mountFrontendBundle`, `src/api/health.production.test.ts` fails with exactly the predicted
      symptom — `expected 'text/html; charset=UTF-8' to match /application\/json/` at status 200. That
      test builds the app in a module graph that has never seen `NODE_ENV=test` (`vi.resetModules()` plus
      a dynamic import), because **the assembled test app cannot see this bug at all**: the SPA branch
      does not run outside production. It asserts both halves — `/health` answers JSON *and* a client
      route answers the SPA shell — so a build where no catch-all existed could not pass it by accident.

      **The failure case is a real unreachable database, not a stub.** A rejected `pingDatabase` mock
      would prove the catch block is spelled correctly and nothing about whether a database that is down
      produces that rejection. The test drops the memoized client, points the connection string at a
      closed port, and the ping genuinely cannot connect: `PrismaClientInitializationError: Can't reach
      database server at 127.0.0.1:1`, logged in full server-side while the response carries only
      `{"error":"Service unavailable"}`. The failure is 503 rather than 500 because it is the answer the
      request asked for, not an unexpected request failure — so this route deliberately does not delegate
      to `errorHandler`, and says so.

      `pingDatabase()` lives in `src/data/prismaClient.ts` (Section 18 keeps Prisma inside `src/data/`;
      there is no entity to name, so a repository for `SELECT 1` would be a repository for nothing). The
      endpoint is not under `/api` and Section 10's ten-endpoint table is unchanged — it is an
      operational probe with no session and no body, not a client contract. `npm test`: 446 passed.

### Feature 9.3 — Security Verification

- [x] T9.3.1 — Verify session cookie configuration (httpOnly, Secure, SameSite=Lax) and the CSRF posture (SameSite + origin-checking on state-changing requests) end-to-end.
      Ref: ARCHITECTURE Section 13 (Sessions, CSRF)
      Output: integration test inspecting Set-Cookie headers and rejecting a cross-origin state-changing request

      **Reading taken: implement-then-verify, not verify.** Section 13 states the posture in one
      sentence — *"`SameSite=Lax` plus origin-checking on state-changing requests is sufficient here"*
      — and only the first half existed. Grepping `src/` for `origin`, `referer`, or `csrf` found
      nothing, and `src/api/middleware/` held only the session guards, rate limiting, and body
      validation. The browser enforces `SameSite`; nothing enforced the origin. Since a supertest
      request carries whatever headers a test sets, a "cross-origin" POST arrives *with* the cookie
      regardless of `SameSite` — so a test asserting refusal would have been red until the server
      could refuse it. `src/api/middleware/requireSameOrigin.ts` is that half, mounted globally in
      `createApp()` (it holds no per-request state, unlike the session middlewares Section 9 requires
      per router) and before `express.json()`, so a cross-origin request is refused without spending
      a body parse.

      **The posture is exactly what Section 13 specifies, and no more.** The document considered a
      CSRF-token scheme and rejected it as *"unjustified complexity for this threat model"*, so there
      is no token, no double-submit cookie, and no new dependency. Safe methods are exempt because a
      link from another site to `/assessment` is a legitimate cross-origin GET; a *missing* `Origin` is
      allowed because non-browser clients send none and have no victim's cookie to abuse; `Origin: null`
      is refused because it cannot be shown to be this origin.

      **The test that matters is the attack, not the header.** `POST /api/staff/login` with the
      *correct* password **and** a foreign `Origin` is refused with 403 and issued no session — every
      other control is defeated there (the password is right, the body is valid, the route is public by
      design), so the middleware is the only thing standing. Its complement — the same credentials from
      this origin do get the session — is what stops a middleware that refused every login from
      passing. `requireSameOrigin.test.ts`: 10 tests, including PATCH coverage so the guard is not
      POST-only, the `X-Forwarded-Proto` case that makes the check depend on `trust proxy: 1`, and an
      unparseable `Origin`.

      **The cookie half.** `src/auth/session.test.ts` already proved httpOnly/SameSite/Secure on a
      hand-built harness, and `session.routes.test.ts` already proved the student cookie's Secure
      behaviour through the real route. What was missing was the staff cookie end to end and the
      httpOnly/SameSite attributes read off a real route response, so both were added: the staff
      cookie's attributes are now asserted on the real `POST /api/staff/login` (they were not covered
      at route level at all), and the student cookie's are asserted on the real
      `POST /api/session/student-verify`. Both include the not-Secure-over-plain-HTTP case, since
      forcing `secure: true` would make the cookies library throw locally.
- [x] T9.3.2 — Verify no ID-bearing student route exists and that report access is reachable only via identity re-verification.
      Ref: PRD Section 15 (NFR-SEC-009); ARCHITECTURE Section 9 (no /report/:id)
      Output: route audit + integration test confirming `/report` requires an active session, not a URL parameter

      **The audit enumerates the route table rather than sampling URLs.** Section 9's guarantee is a
      property of what is *mounted* — *"There is deliberately no `/report/:id` or any route parameter
      that identifies a submission"* — so `src/api/routeSurface.test.ts` walks the assembled app's
      router stack recursively and asserts two things: every `/api/student` path is one of the four
      Section 10 specifies and no others, and no `/api/student` path contains a `:` at all. The second
      is the generalisation — the guarantee is about parameters, not about one route name.

      **A walk that finds nothing passes everything, so the complement is a test of its own.** The
      first two attempts at this file captured the mount path wrongly: Express records a mounted
      router's prefix only in its mount regex, whose source is `^\/api\/student\/?(?=\/|$)` — escaped
      slashes, and a leading `^` that is a *character* in it rather than an anchor to match at position
      zero. The result was an empty route list, which made both assertions above pass vacuously. The
      test that catches it asserts `/api/staff/submissions/:id` **is** found, proving the walk descends
      into mounted routers; the escaping bug was found by exactly that assertion failing, not by
      inspection.

      **Behavioural tests, then, for what the shape is for.** Two students with submitted rows and
      their own live sessions: an id supplied as a path segment 404s (the route does not exist, which is
      stronger than a refusal); an id supplied as `?submissionId=`, `?id=`, or `?submission=` is simply
      not read, and each session still receives its own report, identified by its own `submittedAt`
      rather than by "a report came back". Re-verification is shown to be the only entry point, and the
      wrong-name case is refused. 8 tests.
- [x] T9.3.3 — Verify every API boundary is validated via zod and every database write goes through Prisma's parameterized queries, with no raw SQL string concatenation anywhere.
      Ref: ARCHITECTURE Section 13 (Input validation)
      Output: code review checkpoint + a CI check scanning for raw/unsafe query usage · passes

      **Reading taken: there is no CI, so the check runs in the suite.** No `.github/` and no workflow
      file exist, so T9.3.3's "CI check" has nowhere to live. `src/test/rawQueryScan.test.ts` is that
      check, enforced by `npm test` — which is what CI would run anyway, and which cannot drift out of
      sync with the code the way a separately-configured pipeline step can. A README-level npm script
      was the alternative; a test is the one that actually fails a build.

      **A grep for "Raw" would be wrong in both directions, and both are present here.** Flagging it
      would catch `SubmissionRepository` and `ProcessingJobRepository`, which use `$queryRaw` /
      `$executeRaw` as **tagged templates** — Prisma's parameterized form, where interpolated values
      become bind parameters — for the two statements no ORM builder expresses: the atomic `jsonb ||`
      section merge (Section 12) and the `FOR UPDATE SKIP LOCKED` job claim (Section 8). And it would
      miss `$queryRawUnsafe`, the actual unsafe variant. So the rules are: `$queryRawUnsafe(` /
      `$executeRawUnsafe(` refused in production code, and `$queryRaw(` / `$executeRaw(` refused *as
      calls* — the call form takes a string, which is the shape concatenation arrives in, while the
      tagged-template form is safe. The scan does not match table names at all, which is why it is
      unaffected by this schema being PascalCase and quoted (`"Submission"`) rather than `snake_case`.

      **Scoped to production code, deliberately.** Two places legitimately need the unsafe form and
      both are tests: `src/test/db.ts` truncates every table discovered at runtime, so the table names
      *are* the query; and `SubmissionRepository.test.ts` inserts a hand-written row to prove **Postgres
      itself** rejects a duplicate `(cohortId, rollNumberNormalized)` — Section 6's guarantee, which
      cannot be shown through the ORM being bypassed. Its values are `$1..$4` bind parameters. Neither
      is reachable from a request, which is what Section 13's "no raw SQL string concatenation
      anywhere" is about. Test code is therefore out of scope by file location and by name.

      **Proven non-vacuous by planting a violation.** Adding an `$executeRawUnsafe` call to a throwaway
      file under `src/data/` fails the scan with `src/data/__scanProbe.ts:2 [unsafe raw query]`, and the
      file was removed afterwards. The complement test also asserts the safe tagged-template form exists
      in production code, so a scan that walked no files could not pass. 2 tests; the zod half is the
      review checkpoint below.

      **Zod review checkpoint (Section 13, "every API boundary is validated via `zod`").** Every route
      that accepts a body validates it: `POST /api/session/student-verify` and `POST /api/staff/login`
      and `PATCH /api/student/draft` through `validateBody`; `GET /api/staff/dashboard` and
      `GET /api/staff/export.csv` through `dashboardQuerySchema.safeParse` on the query string (a query
      value is `string | string[] | ParsedQs`, so `?cohortId=a&cohortId=b` would otherwise reach a
      service as an array). Two routes take no input to validate by design and are the complete
      exception list: `POST /api/student/submit` resolves everything from the session — there is no
      field a caller could use to name another record — and `POST /api/staff/logout` has no body. That
      is the whole surface: ten endpoints, eight of them validated, two with nothing to validate.

### Feature 9.4 — Deployment Configuration

- [ ] T9.4.1 — Configure the Render production deployment: build command (`npm ci && npm run build`), start command (`node dist/server.js`), and environment variables per Section 16's table.
      Carry-over from E3, verify on the real deployment: `app.set('trust proxy', 1)` in `src/app.ts`. Render terminates TLS at its proxy, so without it `req.protocol` reports `http` and `req.ip` is the proxy's address — the session cookies silently lose the `Secure` attribute Section 13 requires, and every student shares a single rate-limit allowance. Confirm on the live instance that a login sets a `Secure` cookie and that two different `X-Forwarded-For` values get separate rate-limit budgets. It must remain `1`, never `true`: `true` trusts a client-supplied header, which would let a student reset their own budget with every request. See `src/auth/session.ts` and `src/api/middleware/rateLimit.ts`.
      Ref: ARCHITECTURE Section 16 (Production deployment, Environment variables), Section 13 (Sessions, Rate limiting)
      Output: deployment configuration (render.yaml or documented dashboard settings) · a fresh deploy serves the built frontend and API from one process · a live check confirming a `Secure` session cookie and per-address rate-limit budgets

      **NOT VERIFIED — the live half of this task could not be performed, and it is left unticked for
      that reason.** The task has two halves and only one of them is reachable from here. No Render
      account or instance was available to this session, so the required live check — a deployed
      service setting a `Secure` session cookie, and two `X-Forwarded-For` values receiving separate
      rate-limit budgets — was not performed. Ticking this on the strength of the code being correct is
      precisely the mistake the task was written to prevent: both defects it looks for are **silent**,
      and both are invisible outside a real proxy hop.

      **What was delivered.** `render.yaml` at the repository root: one free web service, build command
      `npm ci && npx prisma generate && npm run build && npx prisma migrate deploy`, start command
      `node dist/server.js`, and Section 16's five environment variables with the three secrets marked
      `sync: false` so Render prompts for them rather than storing them in a committed file. No
      `healthCheckPath`, deliberately: pointing Render's health check at `/health` would turn a database
      outage into a deploy failure rather than a degraded service, and that endpoint exists for the
      optional external ping instead. The file carries a header stating plainly that it is unverified
      against a live deploy.

      **`trust proxy` is already correct in code, and the reasoning is in a comment at the call site.**
      `src/app.ts` sets `app.set('trust proxy', 1)`, so the E3 carry-over is satisfied as written; what
      remains is only its confirmation on a live instance. The setting is load-bearing in three places,
      all now covered by tests that would catch it being weakened: the `Secure` cookie attribute
      (`session.routes.test.ts`, `staff.routes.test.ts`), per-address rate limiting
      (`rateLimit.routes.test.ts`), and — new in E9 — origin checking, where an
      `https://` page would be refused as cross-origin without it (`requireSameOrigin.test.ts`).

      **The local half is verified.** `npm run build` succeeds, and
      `node dist/verify-production-boot.mjs` (gitignored scratch, re-runnable after `npm run build`)
      boots `dist/server.js` under `NODE_ENV=production` behind
      the same commands `render.yaml` names, then checks the result: structured JSON on stdout from the
      real logger (`worker_started`, `content_versions_loaded`, `server_listening`), `/health` → `200
      {"status":"ok"}`, `/assessment` → `200 text/html` (the built SPA shell), and `/api/student/draft`
      without a session → `401 application/json`. One process, both surfaces. The same script prints the
      paragraph above rather than a pass, so a green run cannot be mistaken for the live check.
- [x] T9.4.2 — Confirm `prisma migrate deploy` runs as part of the build/release step, before the new instance serves traffic.
      Ref: ARCHITECTURE Section 16 (Database migrations)
      Output: build/release script · the deploy log shows the migration step completing before the server starts

      **Where it runs, and why there.** `render.yaml`'s build command ends with `npx prisma migrate
      deploy`, which is Section 16's *"as part of the Render build/release step, before the new instance
      starts serving traffic"* — the build completes before the instance is released. Render's
      `preDeployCommand` hook would express the same ordering more explicitly but is not available on
      every plan, and Section 16's $0 constraint fixes the plan, so the build command is where it goes.

      **It is placed *after* `npm run build`, not before.** Both positions satisfy Section 16; this one
      additionally means a compile error aborts the deploy *without* having already migrated the
      database. The other order leaves production running the old build against a newer schema, which
      is survivable for additive migrations and not worth the risk for any other kind when the fix is
      one reordering. `migrate deploy` applies committed migration files only — it never generates,
      resets, or prompts — so it is safe unattended.

      **Verified locally for the ordering that matters.** `node dist/verify-production-boot.mjs` runs
      `prisma migrate deploy` first and then boots the server, printing `1 migration found in
      prisma/migrations · No pending migrations to apply.` and `PASS migrate deploy exit code: 0` ahead
      of the `server_listening` line — the same sequence the deploy log would show. **The gap, stated
      plainly:** no Render deploy log was observed, because no Render instance was reachable from this
      session. This confirms the command and its ordering, not a live deployment.

      **The reason this task exists at all.** `npm ci && npm run build` never generated the Prisma
      client — there is no `postinstall` and no `prisma generate` in any script — so a clean Render
      build compiled `tsc` against a `@prisma/client` whose generated types did not exist. It worked on
      developer machines only because `prisma generate` had been run by hand at some point. `npx prisma
      generate` is now the first step of the build command, ahead of `npm run build`, and the reason is
      written next to it.
- [x] T9.4.3 — Document the optional external keep-warm ping (e.g. a GitHub Actions workflow hitting `/health` every ~10 minutes) as an operational runbook note.
      Ref: ARCHITECTURE Section 16 (Mitigation for both)
      Output: README/runbook section · documented as optional, not required for MVP function

      **`docs/RUNBOOK.md`**, a new file — the repository had no README or runbook to add a section to.
      It documents the deployment settings that `render.yaml` encodes (so the service can be configured
      by hand instead, which T9.4.1's Output allows as an alternative), the two log lines worth knowing
      by name, the health endpoint, and the keep-warm ping.

      **The ping is documented as optional, in Section 16's own terms.** Section 16 calls it *"an
      **optional operational mitigation** available if the pilot's actual usage pattern turns out to
      have idle gaps longer than a few days; it is not required for the architecture to function."* The
      runbook says that first and says the pilot works without it, then names the two thresholds that
      would justify it — Render's ~15-minute sleep and Supabase's 7-day pause — so the decision is made
      against observed behaviour rather than set up "just in case".

      **Documented, not implemented — deliberately.** The example is a GitHub Actions workflow in the
      runbook text, and no `.github/workflows/` file was created: the task says *document*, and adding a
      scheduled workflow would be introducing infrastructure the architecture does not require, into a
      repository that has no CI at all (T9.3.3). The two flags that make the example safe are called out
      — `--max-time 90`, because a timeout shorter than Render's 30–60 second wake would fail a request
      that is working, and `--fail`, so a `503` from a cold database is a failed run rather than a
      silent success. That last point is the whole distinction between this and a ping that reports
      healthy no matter what.

---

## Open Items Carried Into E10 — AI Prompt & Context Audit

**This is a register, not an Epic.** It records what an audit of the two AI evaluation prompts
(`evaluateWriting`, `processStudentProblemsText`) left unresolved, so the state lives where the plan's
state lives rather than only in commit messages. The audit's fixes are on `ai-prompt-audit` based on
`ca3a12a`.

**Nothing here blocks E10.** Each item is either a content decision that belongs to the team, an
accepted risk with its reasoning recorded, or a measurement to revisit against real pilot data. What
several of them do block is **running the pilot**, which is why they are written down rather than left
in a commit body.

### Content awaiting team sign-off before the pilot

All three are `contentStatus: "provisional"` with a `statusNote` naming the PRD Section 23.1 item that
defers them. The pattern is deliberate — provisional content ships clearly labelled — so none of these
is a build defect. They are the three things a student's score depends on that nobody has approved.

| Item | Where | State |
|---|---|---|
| Rubric weights | `writing-rubric.json` → `weights` | `20/20/20/20/20` is a placeholder so the scoring formula has a testable input. PRD Section 23.1 item 1. |
| Free-writing task prompt | `writing-prompt.json` → `task` | A development stand-in of the approved shape. PRD Section 23.1 item 2. |
| Band descriptors | `writing-rubric.json` → `bands` | **New in the audit.** A first proposal written to a structure the team agreed (four bands, per criterion); the PRD does not specify anchors at all. These are the most calibration-sensitive content in the file — they are what makes a 55 mean the same thing for two students. |

### Open decisions

1. **`temperature: 0` does not deliver determinism.** Measured live against `gemma4:31b-cloud`: two
   identical calls with the same prompt returned `sentenceStructure` 75 and 70, with different
   corrections; the other four criteria matched. So the sampling choice reduces variation but does not
   remove it, and the rationale recorded in `OllamaProvider.ts` is weaker than it reads. Options: keep
   `0` as the lower-variance choice, adopt the model's published `temperature=1.0 / top_p=0.95 /
   top_k=64`, or accept the variance as inherent to a cloud endpoint. **Closes with:** a calibration run
   over real essays, not with reasoning.

2. **Category comparability across students.** The dashboard counts AI categories by exact label string
   (`DashboardRepository.derivedCategoryCounts`, `GROUP BY category ->> 'label'`), while `label` is the
   model's own free-form wording. The prompt now asks for consistent, reusable wording and no
   near-duplicates, and a live check produced three well-formed reusable labels — but nothing enforces
   it. **Make it exact** requires a controlled vocabulary, which requires the Student Problems call to
   receive versioned instruction text, and its signature is fixed as `processStudentProblemsText(text)`.
   That is an architecture change, and PRD Section 23.2 item 5 defers the aggregation strategy anyway.
   **Decide:** does the pilot need cross-student comparability, or is the prompt instruction enough?

3. **Schema-level enforcement of `maxCorrections`.** FR-WRITE-008's cap is now enforced — but in
   `JobService.completeJob`, by truncation against the submission's frozen rubric, not by
   `src/ai/schemas.ts`. That is deliberate: the schema layer cannot see a content version, and the
   file's own documentation records that a cap compiled in there would be a code copy that drifts the
   first time a v2 changes it. **Decide:** is enforcement in the job layer sufficient, or should the
   validation boundary be parameterized by the frozen rubric?

4. **Which model.** The tag is settled and verified (`gemma4:31b-cloud`; the plausible mis-spelling
   `gemma4:b31-cloud` does not exist). The *choice* is still PRD Section 23.2 item 4's. Cost from the
   model page: `$0.14/1M` input, `$0.40/1M` output.

### Accepted risks, with the reasoning recorded

- **Prompt injection is not mitigated.** Student text is concatenated into the user message behind
  `---` delimiters. Section 13's threat model is explicitly a small, non-adversarial pilot, the
  realistic worst case is a student affecting only their own record, and every available mitigation
  costs more than the exposure — stripping instruction-like phrases would corrupt legitimate essays that
  quote instructions. Not a gap; a decision.
- **Validation failures carry no structural diagnostics.** `AIValidationError` reports zod issue paths
  but not the shape of what came back. Key names and response length are available within the
  no-student-text invariant; deliberately not implemented, because it touches the message
  `src/ai/errors.ts` is most careful about. Revisit if `failed_needs_review` rates are hard to
  diagnose in the pilot.
- **zod's `unrecognized_keys` writes model-authored key names into `ProcessingJob.lastError`.** Bounded
  by `MAX_LAST_ERROR_LENGTH` (500). Left as-is: it is the single most useful diagnostic for a
  wrong-shape response, and the value is a key name rather than student text.
- **`scoreRange.min` is authored but read by nothing,** while `src/ai/schemas.ts` hardcodes the `0`–`100`
  bounds as literals. Inert today — a changed range would fail loudly in `WritingScoreCalculator`, not
  silently — and structurally the same constraint as item 3.
- **Grounding is measured, not gated.** Live check: 8 of 8 corrections quoted the source verbatim and
  3 of 3 Arabic category quotes were grounded and in the student's own language. A grounding gate would
  trade a silent quality problem for a loud availability problem on evidence that does not show the
  quality problem exists. Revisit only if real data disagrees.

### Already settled by the audit — recorded so they are not reopened

The composed writing prompt now states the JSON keys the strict schema requires, the task the response
is graded against, the scoring anchors, the criterion keys, the score range, and the correction cap —
all derived from the frozen content bundle rather than restated in code. Each evaluation call sends its
own system prompt. `format: 'json'` is no longer assumed to return a bare body. A 404 for an unknown
model is a named failure that says which model was requested.

---

## E10 — Final QA & End-to-End Verification

**Rationale:** Validates the complete pilot against the PRD's critical flows and edge cases before the MVP is considered ship-ready.

**What Done Means:**
- All automated end-to-end, integration, and security-boundary tests pass in CI.
- The full student and staff critical paths from the PRD are verified against a running instance.
- Startup and stale-job recovery behavior is verified under a simulated restart.
- The repository is tagged/committed as MVP-complete with a fully green test suite.

**Prerequisites:** E1–E9 complete. All Epic-level checkpoints are committed and the working tree is clean before final QA begins.

**Files to Read:**
- `CLAUDE.md` — persistent Claude Code operating rules for this repository
- `PRD.md` — product requirements and behavioral constraints
- `ARCHITECTURE.md` — approved technical architecture
- `TASK_PLAN.md` — this Epic's task order, outputs, and completion state
- `src/`, `frontend/src/` — the full implementation under test
- existing test suites and fixtures, including `FakeAIEvaluationService`
- `package.json` — test/build scripts exercised by the final checkpoint

### Feature 10.1 — End-to-End Flow Tests

- [ ] T10.1.1 — Automate the full student flow: entry → draft with section-level autosave → submit → report showing deterministic results immediately, with writing status transitioning pending→succeeded using `FakeAIEvaluationService`.
      Ref: ARCHITECTURE Section 15 (End-to-end student flow); PRD Section 8.1
      Output: e2e test suite (student flow) · passes headless in CI
- [ ] T10.1.2 — Automate the returning-visit flow: re-entering identity for an already-submitted student shows the saved report and blocks any re-attempt.
      Ref: PRD Section 8.2, Section 19 (EDGE-003)
      Output: e2e test (returning visit) · passes
- [ ] T10.1.3 — Automate draft recovery: a student leaves mid-draft and returns; previously autosaved answers are present.
      Ref: PRD Section 19 (EDGE-001/002), Section 9.2 (FR-ASSESS-006)
      Output: e2e test (draft recovery) · passes
- [ ] T10.1.4 — Automate multi-tab autosave behavior: two tabs editing different sections both persist; two tabs editing the same section resolve last-write-wins for that section only.
      Ref: ARCHITECTURE Section 12 (Section-level autosave — multi-tab cases)
      Output: integration test (multi-tab simulation) · passes
- [ ] T10.1.5 — Automate duplicate-submission prevention and post-submission immutability checks.
      Ref: PRD Section 19 (EDGE-003), Section 9.2 (FR-ASSESS-008)
      Output: integration test · a duplicate submit is idempotent/rejected; no edit is possible after submission

### Feature 10.2 — AI Failure & Recovery Tests

- [ ] T10.2.1 — Automate Writing evaluation success, malformed-output, provider-timeout, retry, and `failed_needs_review` paths using `FakeAIEvaluationService` variants.
      Ref: ARCHITECTURE Section 15 (AIEvaluationService/OllamaProvider test row, JobService test row)
      Output: integration test suite (AI failure matrix) · all five paths pass
- [ ] T10.2.2 — Automate Student Problems AI processing success and failure paths, confirming original-text preservation in both cases.
      Ref: PRD Section 9.5 (FR-PROB-013), Section 19 (EDGE-008)
      Output: integration test · passes

### Feature 10.3 — Staff Flow Tests

- [ ] T10.3.1 — Automate staff authentication, dashboard aggregate view, individual submission access (with access-log verification), and CSV export.
      Ref: PRD Section 8.3, Section 9.7; ARCHITECTURE Section 15 (Dashboard aggregation, CSV export test rows)
      Output: integration/e2e test suite (staff flow) · passes

### Feature 10.4 — Security & Boundary Tests

- [ ] T10.4.1 — Automate security-boundary checks: one student cannot access another's report via guessing/modifying identifiers, staff routes reject student sessions and vice versa, and rate limiting engages on repeated failed attempts.
      Ref: PRD Section 15 (NFR-SEC-006/009/010); ARCHITECTURE Section 9, Section 13
      Output: integration test suite (security boundaries) · passes

### Feature 10.5 — Deployment/Startup Verification

- [ ] T10.5.1 — Verify startup behavior end-to-end: the process fails fast on malformed content, connects to Postgres, and starts Express + the worker loop in the documented order; verify a stale/claimed-but-incomplete job is correctly re-claimed after a simulated restart.
      Ref: ARCHITECTURE Section 16 (Startup behavior), Section 8 (Stale jobs, Render sleep interaction)
      Output: integration test (startup sequence + stale job re-claim) · passes
- [ ] T10.5.2 — Verify historical content interpretability end-to-end: with a fixture `v2` content version present and `current-version.json` pointing at it, a submission frozen under `v1` still scores, renders on the student report, and displays on the staff submission detail view against `v1`'s questions, explanations, prompt, and rubric weights — never against `v2`.
      Ref: PRD Section 9.8 (FR-CONTENT-001/003); ARCHITECTURE Section 2 (versioned content), Section 6 (contentVersion frozen at draft creation), Section 12 (Historical content interpretability)
      Output: integration test (v1 submission + v2 current version) · passes
- [ ] T10.5.3 — Run the full test suite and perform the final Epic-level checkpoint: all automated tests pass, `npm run build` succeeds for both backend and frontend, repository committed/tagged as MVP-complete.
      Output: green CI run · git tag/commit marking MVP completion

---

## Epic 11 — Cohort Provisioning (post-v1.1 addition)

**Status:** complete. **This is a scope expansion, not a task the plan already contained**, and it is
recorded here rather than folded in silently. The PRD does not describe cohort management.

It exists because a deployed instance had **no cohorts at all**: `render.yaml` runs
`prisma migrate deploy` and nothing else, no migration inserts data, and `prisma/seed.ts` is a
development convenience a deploy never runs. Every student would have been told "we couldn't find a
matching record". The full argument, and why this clears Section 10's "one endpoint per real user
action" standard, is in ARCHITECTURE Section 9's amendment.

**Create-and-read only, deliberately.** There is no update and no delete: changing a cohort's `code`
locks out every student already given it, and deleting one either cascades into immutable
submissions (which the product forbids) or has to refuse once a submission exists.

**Staff accounts remain non-creatable in-app**, per FR-STAFF-002. `prisma/provision.ts` is the manual
step made repeatable, not a route.

### Feature 11.1 — Cohort provisioning

- [x] T11.1.1 — Add `create` and `findAllWithSubmissionCounts` to `CohortRepository`, and a `CohortService` owning the uniqueness decision and the code-normalisation rule.
      Ref: ARCHITECTURE Section 10, Section 18; PRD Section 9.1 (FR-STU-001)
      Output: repository + service · exercised through the route suite
- [x] T11.1.2 — Add `GET /api/staff/cohorts` and `POST /api/staff/cohorts`, both behind `requireStaffSession`, refusing a duplicate code with `409` and a malformed body with a field-level `400`.
      Ref: ARCHITECTURE Section 9 (amendment), Section 10, Section 11
      Output: integration tests · 10 cases pass (auth on both, ordering, counts, normalisation, exact and case-insensitive duplicates, blank and missing fields)
- [x] T11.1.3 — Add the `/staff/cohorts` page, a third sidebar item, and a creation confirmation dialog that shows the code students will be given.
      Ref: ARCHITECTURE Section 9; DESIGN.md
      Output: page renders inside the staff shell · create flow verified end to end
- [x] T11.1.4 — Extract `normaliseCohortCode` to `src/shared/cohortCode.ts` so the dialog's preview and the stored value cannot disagree, and move `isUniqueConstraintViolation` to `src/data/prismaErrors.ts` so two repositories share one definition rather than each holding a copy.
      Ref: CLAUDE.md ("A rule implemented in two places is a bug")
      Output: one definition of each, imported by every caller

### Feature 11.2 — Staff account provisioning

- [x] T11.2.1 — Add `prisma/provision.ts`: upserts one staff account against an explicitly-named `DATABASE_URL`, prompting for the password without echoing it and confirming the target database before writing.
      Ref: PRD Section 9.7 (FR-STAFF-002); ARCHITECTURE Section 16
      Output: verified four ways — refuses when `DATABASE_URL` is unset, the stored hash verifies against the verifier `StaffAuthService` uses, re-running rotates the password instead of duplicating the row, and declining the confirmation writes nothing
- [x] T11.2.2 — Document the procedure in `docs/RUNBOOK.md`, which had no provisioning section at all — the reason this gap was invisible until it was asked about.
      Ref: ARCHITECTURE Section 16
      Output: runbook section added, covering the idempotency, the `.env` ordering, and the cohort step that follows

---

## Final Verification Checklist

Before declaring the MVP complete, confirm:

- [ ] All tasks across Epics 1–10 are checked off, plus Epic 11 (a post-v1.1 addition — see its own note on why it is a scope expansion rather than a planned task).
- [ ] `npm test` (backend) and the frontend build both pass with no known failures.
- [ ] Every PRD functional requirement (FR-STU, FR-ASSESS, FR-DET, FR-WRITE, FR-PROB, FR-FEEDBACK, FR-STAFF, FR-CONTENT) has at least one implementation or verification task above.
- [ ] Every PRD edge case (EDGE-001 through EDGE-008) is covered by an implementation task (E4/E5/E7) or a verification task (E10).
- [ ] Every PRD non-functional/security requirement (NFR-SEC, NFR-PRIV, NFR-GEN) has a corresponding implementation task (E3/E9) or verification task (E10).
- [ ] Every canonical file location in ARCHITECTURE Section 18 has been created by some task above.
- [ ] The database schema, API contracts, background job model, and AI abstraction all match ARCHITECTURE Sections 6, 8, 10 exactly — no unapproved architectural deviation was introduced.
- [ ] No task references infrastructure outside the approved architecture (no Redis, no queue library, no CMS, no student accounts, no additional staff roles).
- [ ] Content versioning holds: a submission frozen under an older content version still resolves against that version after a newer version is added (T10.5.2).
- [ ] The repository builds, runs, and passes its full test suite from a clean checkout.
- [ ] `CLAUDE.md`, `PRD.md`, `ARCHITECTURE.md`, and `TASK_PLAN.md` are committed at the repository root and reflect what was actually built.
