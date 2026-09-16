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

- [ ] T6.1.1 — Define `src/ai/AIEvaluationService.ts` (interface: `evaluateWriting(text, rubricInstructions)`, `processStudentProblemsText(text)`) and `src/ai/errors.ts` (`AIValidationError`, `AIRetryableError`, `AINonRetryableError`).
      Ref: ARCHITECTURE Section 4 (src/ai/), Section 18
      Output: src/ai/AIEvaluationService.ts, src/ai/errors.ts
- [ ] T6.1.2 — Implement `src/ai/schemas.ts`: zod schemas for the expected LLM JSON output (criterion-level writing scores, Student Problems categories).
      Ref: PRD Section 9.4 (FR-WRITE-005/007), Section 9.5 (FR-PROB-011); ARCHITECTURE Section 2 (zod), Section 3 (schema validation step)
      Output: src/ai/schemas.ts · unit test: a well-formed fixture passes; a missing field, wrong type, or out-of-range score fails
- [ ] T6.1.3 — Implement a `FakeAIEvaluationService` test double implementing `AIEvaluationService`, used throughout the test suite so CI never depends on Ollama Cloud reachability.
      Ref: ARCHITECTURE Section 15 (Mocking Ollama)
      Output: test fixture/fake provider · reused across job, worker, and end-to-end tests

### Feature 6.2 — Job Persistence & Lifecycle

- [ ] T6.2.1 — Implement `src/data/ProcessingJobRepository.ts` including the claim query (`UPDATE ... WHERE id = (SELECT ... FOR UPDATE SKIP LOCKED)`).
      Ref: ARCHITECTURE Section 8 (Claiming), Section 6 (ProcessingJob model, index)
      Output: src/data/ProcessingJobRepository.ts · integration test: simulated concurrent claim attempts never claim the same row twice
- [ ] T6.2.2 — Implement `src/domain/jobs/JobService.ts`: `claimNextJob` (with stale-job reclamation via `STALE_THRESHOLD_MS`), `completeJob` (transactional result write + job status), `failJob` (retry/backoff bookkeeping, `MAX_ATTEMPTS` → `failed_needs_review`).
      Ref: PRD Section 9.4 (FR-WRITE-011), Section 9.5 (FR-PROB-013); ARCHITECTURE Section 8 (Retries and backoff, Stale jobs), Section 6 (Transaction boundaries #4), Section 18
      Output: src/domain/jobs/JobService.ts + test · integration test: retry/backoff transitions are correct; a stale job is re-claimed after the threshold; exhausted retries produce `failed_needs_review`; the original response is never touched on failure
- [ ] T6.2.3 — Implement `SubmissionRepository.getEvaluationContext(submissionId, jobType)`: resolves authoritative response text + `contentVersion` from the `Submission` row only, never from `ProcessingJob` fields.
      Ref: ARCHITECTURE Section 8 (What a job contains vs. what the worker resolves), Section 18
      Output: src/data/SubmissionRepository.ts (getEvaluationContext) · unit+integration test: returns the correct shape for both job types; throws clearly if the expected field is missing (e.g. a `writing_eval` job for a submission with no writing answer)

### Feature 6.3 — Worker Loop

- [ ] T6.3.1 — Implement `src/background/workerLoop.ts`: a `setInterval` poll tick (7s) with an `isRunning` guard against overlapping ticks; claims one job, resolves evaluation context and frozen content version, invokes `AIEvaluationService`, validates output, persists via `JobService`, and routes failures to `failJob`.
      Ref: ARCHITECTURE Section 8 (workerLoop illustrative code), Section 3 (Data Flow — Background Writing Evaluation)
      Output: src/background/workerLoop.ts · integration test (with `FakeAIEvaluationService`): a pending job is claimed, processed, and marked succeeded within a few poll ticks
- [ ] T6.3.2 — Wire the worker loop into the `src/server.ts` boot sequence, started after the Express server per the documented startup order.
      Ref: ARCHITECTURE Section 16 (Startup behavior — steps 3–4)
      Output: src/server.ts · starting the app starts the HTTP server and the worker loop exactly once each

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

- [ ] T7.1.1 — Implement `src/domain/scoring/WritingScoreCalculator.ts`: a pure function computing the 0–100 overall score via the fixed weighted-sum formula from the five criterion scores plus `writingRubricWeights` read from the versioned content bundle (never hardcoded).
      Ref: PRD Section 9.4 (FR-WRITE-006/009); ARCHITECTURE Section 7 (WritingScoreCalculator), Section 18
      Output: src/domain/scoring/WritingScoreCalculator.ts + test · unit tests assert formula correctness against fixture weights, including boundary values (0, 100)

### Feature 7.2 — Ollama Provider Integration

- [ ] T7.2.1 — Implement `src/ai/OllamaProvider.ts`: the only file that knows about Ollama; builds the fixed rubric prompt from `content.writingRubricInstructions`, requests structured JSON, enforces a request timeout (e.g. 60s), and reads `OLLAMA_API_KEY`/`OLLAMA_BASE_URL` from environment variables only.
      Ref: PRD Section 9.4 (FR-WRITE-003/004); ARCHITECTURE Section 1 (AI-assisted scoring), Section 8, Section 13 (API key protection), Section 14 (Timeouts), Section 18
      Output: src/ai/OllamaProvider.ts · test (against a stubbed HTTP layer, never real Ollama) confirms request shape, timeout enforcement, and that no route/log line ever includes the API key
- [ ] T7.2.2 — Implement `evaluateWriting()` and `processStudentProblemsText()` on `OllamaProvider`, validating responses against `src/ai/schemas.ts` before returning.
      Ref: PRD Section 9.4 (FR-WRITE-005/007/008), Section 9.5 (FR-PROB-010/011); ARCHITECTURE Section 3 (Data Flow — Background Writing Evaluation)
      Output: src/ai/OllamaProvider.ts (evaluateWriting, processStudentProblemsText) · unit test with mocked HTTP responses: malformed JSON throws `AIValidationError`, network/timeout throws `AIRetryableError`
- [ ] T7.2.3 — Wire `OllamaProvider` as the production `AIEvaluationService` implementation selected via configuration, with `FakeAIEvaluationService` used in all automated tests.
      Ref: ARCHITECTURE Section 17 (Alternative/additional AI providers — seam), Section 15 (Mocking Ollama)
      Output: dependency wiring in server/app assembly · the automated test suite never calls real Ollama; production boot uses `OllamaProvider`

### Feature 7.3 — Writing Evaluation Flow Integration

- [ ] T7.3.1 — Extend `JobService.completeJob()` so a succeeded `writing_eval` job calls `WritingScoreCalculator.computeOverallScore()` before persisting, writing `writingCriteriaScores`, `writingOverallScore`, `writingFeedback`, and `writingStatus='succeeded'` transactionally.
      Ref: PRD Section 9.4 (FR-WRITE-006/007); ARCHITECTURE Section 3, Section 6 (Transaction boundaries #4), Section 18
      Output: src/domain/jobs/JobService.ts (completeJob writing_eval branch) · integration test: full pending→claimed→succeeded flow (with `FakeAIEvaluationService`) produces the correct `writingOverallScore`
- [ ] T7.3.2 — Verify writing-evaluation failure handling end-to-end: original response text preserved, retries exhausted, `writingStatus='failed_needs_review'`.
      Ref: PRD Section 9.4 (FR-WRITE-011), Section 19 (EDGE-004); ARCHITECTURE Section 8 (Retries and backoff)
      Output: integration test using a `FakeAIEvaluationService` configured to always fail · after `MAX_ATTEMPTS`, `writingStatus='failed_needs_review'` and `answers.writing.essayText` is unchanged
- [ ] T7.3.3 — Update `GET /api/student/report` and `ReportPage.tsx` to surface writing results once `writingStatus='succeeded'` (criterion scores, overall score, strengths/weaknesses/corrections/suggestions) or the "processing failed / needs review" status.
      Ref: PRD Section 9.4 (FR-WRITE-007), Section 9.6 (FR-FEEDBACK-003/007), Section 13 (Feedback and Result States table)
      Output: src/api/student.routes.ts (GET report — writing fields), frontend ReportPage.tsx · integration/manual verification: all four states in Section 13's table render correctly

### Feature 7.4 — Student Problems AI Processing

- [ ] T7.4.1 — Extend `JobService`/`completeJob` so a succeeded `student_problems_text` job writes only to `problemsTextDerived` (normalizedText, categories), never touching `problemsOpenTextOriginal`, and sets `problemsTextStatus='succeeded'`.
      Ref: PRD Section 9.5 (FR-PROB-009/010/011); ARCHITECTURE Section 6 (problemsOpenTextOriginal vs. problemsTextDerived), Section 12 (Original data preservation)
      Output: src/domain/jobs/JobService.ts (completeJob student_problems_text branch) · integration test: derived data is written; the original column is provably unchanged before and after
- [ ] T7.4.2 — Verify Student Problems processing failure handling: original open-text response preserved, `problemsTextStatus='failed_needs_review'` after retries exhausted, rest of the report unaffected.
      Ref: PRD Section 9.5 (FR-PROB-013), Section 19 (EDGE-008)
      Output: integration test using a failing `FakeAIEvaluationService` · original text preserved, rest of the report unaffected
- [ ] T7.4.3 — Confirm Student Problems Likert responses and derived data never influence any English proficiency score (no code path in `DeterministicScoringService` or `WritingScoreCalculator` reads `problemsLikertAnswers`/`problemsTextDerived`).
      Ref: PRD Section 9.5 (FR-PROB-008/012)
      Output: code review checkpoint + unit test asserting the scoring services accept no Student Problems input · test fails if such a dependency is ever introduced

---

## E8 — Staff Dashboard & Reporting

**Rationale:** Builds the internal analysis views and export on top of the now-complete submission data model, letting staff view aggregate patterns and individual records. Reuses the staff-session infrastructure from E3.

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

- [ ] T8.1.1 — Implement `src/domain/staff/DashboardService.ts`: submission counts + completion status, overall/section-level score distributions (Grammar/Vocabulary/Reading/Writing comparison), most common Student Problems responses, cohort filter.
      Ref: PRD Section 9.7 (FR-STAFF-004/005/006/008/009); ARCHITECTURE Section 14 (Dashboard aggregation — plain SQL, no caching), Section 18
      Output: src/domain/staff/DashboardService.ts + test · integration test: correct counts/averages against seeded fixture data, including cohort filtering
- [ ] T8.1.2 — Implement the Basic/Intermediate/Upper-intermediate difficulty-level comparison as a conditional capability that only renders when the underlying content metadata/question distribution supports a meaningful comparison.
      Ref: PRD Section 9.7 (FR-STAFF-007)
      Output: DashboardService difficulty-level query · test confirms the comparison is omitted rather than shown misleadingly when metadata is insufficient
- [ ] T8.1.3 — Implement `GET /api/staff/dashboard`.
      Ref: ARCHITECTURE Section 10 (API contract — dashboard)
      Output: src/api/staff.routes.ts (GET dashboard) · integration test: an authenticated staff session receives the aggregate payload; an unauthenticated request is rejected

### Feature 8.2 — Individual Submission Access

- [ ] T8.2.1 — Implement `GET /api/staff/submissions/:id`, returning full submission detail (answers, scores, writing evaluation, Student Problems original + derived data) and emitting the structured pino staff-access log line.
      Ref: PRD Section 9.7 (FR-STAFF-010), Section 15 (NFR-PRIV-004); ARCHITECTURE Section 13 (Staff data access is logged), Section 18
      Output: src/api/staff.routes.ts (GET submissions/:id) · integration test: response includes the expected fields; log output contains `{ event: 'staff_submission_access', staffUserId, submissionId, timestamp, action: 'view' }`
- [ ] T8.2.2 — Build `SubmissionDetailPage.tsx`, clearly labeling Student Problems AI-derived categories/normalized text as derived, not the student's original words.
      Ref: PRD Section 9.5 (FR-PROB-011), Section 9.7 (FR-STAFF-010)
      Output: frontend/src/pages/staff/SubmissionDetailPage.tsx · manual verification: derived data is visually distinguished from the original response

### Feature 8.3 — Dashboard Frontend

- [ ] T8.3.1 — Build `DashboardPage.tsx`: fetches aggregate data on load and on cohort-filter change; renders submission counts/completion, score distributions, and Student Problems patterns.
      Ref: PRD Section 9.7 (FR-STAFF-004/005/006/008/009/012); ARCHITECTURE Section 5 (DashboardPage)
      Output: frontend/src/pages/staff/DashboardPage.tsx · manual verification: changing the filter re-fetches and updates the displayed metrics
- [ ] T8.3.2 — Build staff `LoginPage.tsx`.
      Ref: PRD Section 9.7 (FR-STAFF-001)
      Output: frontend/src/pages/staff/LoginPage.tsx · manual verification: valid login routes to the dashboard; invalid login shows a generic error

### Feature 8.4 — CSV Export

- [ ] T8.4.1 — Implement `GET /api/staff/export.csv` using `csv-stringify` for a streamed export, optionally filtered by cohort, covering the full submission dataset needed for external analysis.
      Ref: PRD Section 9.7 (FR-STAFF-011), Section 4 (G5); ARCHITECTURE Section 2 (csv-stringify), Section 10 (API contract — export)
      Output: src/api/staff.routes.ts (GET export.csv) · integration test: output includes the expected columns/rows for a seeded dataset and respects the cohort filter
- [ ] T8.4.2 — Add a staff-facing export trigger in `DashboardPage.tsx`.
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

- [ ] T9.1.1 — Implement centralized Express error-handling middleware mapping each failure class in Architecture Section 11's table to its user-facing response (validation 400, identity-not-found generic message, authorization 401/403, database 500 with a generic message), never leaking stack traces, SQL, or prompt content.
      Ref: ARCHITECTURE Section 11 (Error Handling Strategy)
      Output: src/api/middleware (error handler) · integration test: each failure class returns the specified generic message and status; full detail is retained server-side in logs
- [ ] T9.1.2 — Confirm submission-conflict handling (retry/double-click on an already-submitted draft) returns the existing report as a success, not an error.
      Ref: ARCHITECTURE Section 11 (Submission conflict), Section 12 (Safe retries on submit)
      Output: regression test on POST /api/student/submit · a duplicate submit returns 200 with the same report body

### Feature 9.2 — Logging & Observability

- [ ] T9.2.1 — Configure `pino` structured JSON logging to stdout across the application, with redaction of any field named `apiKey`/`authorization`.
      Ref: ARCHITECTURE Section 13 (API key protection — pino redact), Section 16 (Logging)
      Output: logging configuration module · test confirms a log line containing an `apiKey` field is redacted in output
- [ ] T9.2.2 — Implement `GET /health`, performing a trivial DB query, for use as an external keep-warm ping target.
      Ref: ARCHITECTURE Section 16 (Mitigation — external free scheduled ping)
      Output: src/api (health route) · integration test: returns 200 when the DB is reachable, 5xx when it is not

### Feature 9.3 — Security Verification

- [ ] T9.3.1 — Verify session cookie configuration (httpOnly, Secure, SameSite=Lax) and the CSRF posture (SameSite + origin-checking on state-changing requests) end-to-end.
      Ref: ARCHITECTURE Section 13 (Sessions, CSRF)
      Output: integration test inspecting Set-Cookie headers and rejecting a cross-origin state-changing request
- [ ] T9.3.2 — Verify no ID-bearing student route exists and that report access is reachable only via identity re-verification.
      Ref: PRD Section 15 (NFR-SEC-009); ARCHITECTURE Section 9 (no /report/:id)
      Output: route audit + integration test confirming `/report` requires an active session, not a URL parameter
- [ ] T9.3.3 — Verify every API boundary is validated via zod and every database write goes through Prisma's parameterized queries, with no raw SQL string concatenation anywhere.
      Ref: ARCHITECTURE Section 13 (Input validation)
      Output: code review checkpoint + a CI check scanning for raw/unsafe query usage · passes

### Feature 9.4 — Deployment Configuration

- [ ] T9.4.1 — Configure the Render production deployment: build command (`npm ci && npm run build`), start command (`node dist/server.js`), and environment variables per Section 16's table.
      Carry-over from E3, verify on the real deployment: `app.set('trust proxy', 1)` in `src/app.ts`. Render terminates TLS at its proxy, so without it `req.protocol` reports `http` and `req.ip` is the proxy's address — the session cookies silently lose the `Secure` attribute Section 13 requires, and every student shares a single rate-limit allowance. Confirm on the live instance that a login sets a `Secure` cookie and that two different `X-Forwarded-For` values get separate rate-limit budgets. It must remain `1`, never `true`: `true` trusts a client-supplied header, which would let a student reset their own budget with every request. See `src/auth/session.ts` and `src/api/middleware/rateLimit.ts`.
      Ref: ARCHITECTURE Section 16 (Production deployment, Environment variables), Section 13 (Sessions, Rate limiting)
      Output: deployment configuration (render.yaml or documented dashboard settings) · a fresh deploy serves the built frontend and API from one process · a live check confirming a `Secure` session cookie and per-address rate-limit budgets
- [ ] T9.4.2 — Confirm `prisma migrate deploy` runs as part of the build/release step, before the new instance serves traffic.
      Ref: ARCHITECTURE Section 16 (Database migrations)
      Output: build/release script · the deploy log shows the migration step completing before the server starts
- [ ] T9.4.3 — Document the optional external keep-warm ping (e.g. a GitHub Actions workflow hitting `/health` every ~10 minutes) as an operational runbook note.
      Ref: ARCHITECTURE Section 16 (Mitigation for both)
      Output: README/runbook section · documented as optional, not required for MVP function

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

## Final Verification Checklist

Before declaring the MVP complete, confirm:

- [ ] All 90 tasks across all 10 Epics are checked off.
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
