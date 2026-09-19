# CLAUDE.md

Operating instructions for Claude Code in this repository. Loaded automatically at the start of every session.

## Project

English-Language Assessment & Diagnostic Pilot: a single-deployable web application that delivers one five-section English assessment (Grammar, Vocabulary, Reading, Writing, Student Problems) to a small cohort of university students with no accounts, scores it, and gives two staff members a simple internal dashboard and CSV export.

Scope is the approved MVP in the PRD. Nothing more.

## Source of truth

The project documents live in `docs/`:

| Document | Path | Referred to as |
| --- | --- | --- |
| Product requirements | `docs/English_Assessment_Pilot_PRD_v1.1.md` | the PRD |
| Technical architecture | `docs/ARCHITECTURE_v1.1.md` | the Architecture |
| Implementation plan | `docs/TASK_PLAN_v1.1.md` | the Task plan |
| UX audit | `docs/UX-AUDIT.md` | the UX audit |
| UX implementation plan | `docs/UX-IMPLEMENTATION-PLAN.md` | the UX plan |
| UX conventions | `docs/UX-DECISIONS.md` | the UX decisions |

1. PRD — product behavior and requirements.
2. Architecture — technical decisions, canonical file locations (Section 18), schema, API contracts.
3. Task plan — implementation order, task scope, verification criteria, completion state.
4. The three UX documents — the behavioural UX layer: what was wrong and the evidence
   (`UX-AUDIT.md`), the approved plan (`UX-IMPLEMENTATION-PLAN.md`), and the conventions a future
   change must follow (`UX-DECISIONS.md`). **Read `UX-DECISIONS.md` before changing how the
   application behaves.**
5. `CLAUDE.md` — how to operate in this repository.

### Files that live at the repository root, and why

`PRODUCT.md`, `DESIGN.md`, and `.impeccable/` stay at the root **by tooling contract, not by
preference** — the `impeccable` plugin resolves them relative to the project root (verified: its
`context` command reports `productPath: "PRODUCT.md"` and `designPath: "DESIGN.md"`). Moving them
into `docs/` breaks `/impeccable document`, `/impeccable critique`, and the live panel.

- `PRODUCT.md` — durable product truth (users, purpose, constraints). Not visual.
- `DESIGN.md` — the visual system: tokens, components, and the named rules. **Read it before
  changing anything visual.**
- `.impeccable/design.json` — generated sidecar (tonal ramps, motion, components). Regenerate it
  with `DESIGN.md`, never by hand.

Everything else belongs in `docs/`.

Section numbers cited below (e.g. "Section 15") always refer to the Architecture document unless stated otherwise. The Task plan is the checklist of record; tick a box there only after its `Output:` condition is verified.

Read these from disk when you need them. They are not imported into context automatically — reading a section on demand is cheaper and more accurate than assuming.

On a contradiction between documents: do not silently redesign. Name the contradiction, keep the PRD's product behavior, keep the Architecture's technical decisions, and continue if a safe reading exists. Escalate only when the contradiction actually blocks implementation.

## Development environment

- Node.js + TypeScript backend (Express), React + Vite frontend, PostgreSQL via Prisma, single process serving API + static bundle + in-process worker loop.
- Claude Code runs from the repository root, in the VS Code integrated terminal, against the local repository.
- There is no Flutter, no mobile target, no offline mode. Ignore any convention from a generic task-plan template that contradicts the Architecture document.
- **Node 24+ is required.** Development runs the backend TypeScript directly via Node's native type-stripping (`node --watch src/server.ts`) rather than a transpiler dependency, which keeps the dependency set exactly as the Architecture's Section 2 specifies.
  - Consequence: **every relative import in `src/` carries an explicit `.ts` extension** (`import { app } from './app.ts'`). This is not stylistic — Node cannot resolve an extensionless relative import at runtime. `tsconfig.json` sets `rewriteRelativeImportExtensions` so `tsc` emits `.js` specifiers into `dist/`.
  - Type-stripping erases types only; it does not transform syntax. Avoid `enum`, `namespace`, and parameter properties in `src/` (use `const` objects and plain classes instead).
  - `frontend/` is bundled by Vite and is unaffected — it uses ordinary extensionless imports.

## Session start

A new session has no memory of previous ones. Reconstruct state from the repository:

1. Read this file, then the PRD, Architecture, and Task plan in `docs/`.
2. Run `git status` and `git log --oneline -10`.
3. Identify the current Epic and which tasks are checked off in `TASK_PLAN.md`.
4. Verify the Epic's **Prerequisites** actually exist in the code — a checked box is a claim, the repository is the evidence.
5. Read the files listed under the Epic's **Files to Read** before writing anything.

Do not assume a previous session finished what it started.

## Task execution

One Epic per session. One task at a time, in `TASK_PLAN.md` order.

For every task:

1. Read the task and its `Ref:` sections in the PRD / Architecture.
2. Inspect the existing code it touches.
3. Implement only that task.
4. Run its verification and show the evidence — test output, command output, or the file produced.
5. Fix failures caused by the implementation.
6. Confirm the task's `Output:` condition is met.
7. Tick the checkbox in `TASK_PLAN.md`.

**IMPORTANT: code written is not a task completed.** A task is complete only when its verification passes and you have shown the output.

If a later task's work becomes tempting mid-task, note it and move on. Do not pull work forward.

## Implementation discipline

- Follow the canonical locations in `ARCHITECTURE.md` Section 18. A rule implemented in two places is a bug.
- Inspect before editing; preserve working behavior.
- Keep changes scoped to the active task. No speculative features, no drive-by refactors, no premature optimization.
- Prefer the simplest solution consistent with the approved architecture.

## Architecture protection

Do not introduce Redis, an external queue library, microservices, a CMS, student accounts, additional staff roles, offline support, a frontend state library, an external auth provider, speculative abstractions, or unapproved providers.

Do not change the database schema, frameworks, AI architecture, or session model outside what `ARCHITECTURE.md` specifies.

Non-negotiable invariants:

- One submission per `(cohortId, rollNumberNormalized)` — enforced by the database unique constraint, not application code alone.
- Submission immutability is server-enforced. The browser is never trusted.
- Autosave is section-scoped: `PATCH /api/student/draft` merges one section key into the JSONB `answers` column atomically. Never write the whole `answers` object.
- `problemsOpenTextOriginal` is written once at submission and never overwritten. AI writes only to `problemsTextDerived`.
- Student Problems data never affects any English score.
- `contentVersion` is frozen at draft creation. Scoring, reports, and background jobs resolve content through `ContentLoader.getContent(version)`, never "current".
- Rubric weights come from the versioned content bundle, never hardcoded.
- Background jobs read authoritative input from the `Submission` row via `SubmissionRepository.getEvaluationContext()`, never from `ProcessingJob` fields.

## AI provider

All AI use goes through the `AIEvaluationService` interface. `src/ai/OllamaProvider.ts` is the only file that knows about Ollama. Every model response is validated against `src/ai/schemas.ts` before the domain layer accepts it. The provider returns criterion judgments; `WritingScoreCalculator` computes the score.

`OLLAMA_API_KEY` lives in an environment variable, is read only inside the provider, and never appears in source, client code, logs, or responses.

## Testing

Follow the Architecture document, Section 15.

- Run targeted tests after each relevant change; run the full suite at Epic boundaries.
- Integration tests for API and database behavior run against the real test database.
- Automated tests always use `FakeAIEvaluationService`. Nothing in CI calls Ollama.
- Never weaken, skip, or delete a test to make a task pass. If a test is wrong, say so and explain why.

## Security

Server-side authorization, scoped student sessions, staff sessions, immutable submissions, zod validation at every API boundary, bcrypt-hashed staff passwords, rate-limited login/verify, and generic error messages that never reveal which identity field was wrong.

There is deliberately no ID-bearing student report route. Do not add one. Never bypass a security behavior to make development easier.

## Git and checkpoints

- Check `git status` before substantial changes; read recent history when context is needed.
- Commit at Epic completion: `git commit -m "Epic N complete: <title>"`. Leave the working tree clean.
- Never force-reset, force-push, delete unfamiliar files, or discard uncommitted work as a shortcut. If the working tree has unexpected user changes, preserve them and work around them.
- Never commit `.env`, credentials, or build output.
- Claude Code's own checkpoints only track edits made through file tools; Git is the real record.

## When blocked

Stop and explain the concrete blocker — do not invent architecture — when there is a genuine PRD/Architecture contradiction, a missing dependency, an environment or external-service problem, or product behavior that cannot be safely inferred. Say what decision or correction is needed.

Note that several product details are open in PRD Section 23.1 (rubric weights, final question content, statement wording). Build against the structure, read values from versioned content, and do not invent final numbers as if approved.

For ordinary uncertainty, choose the simplest option consistent with `ARCHITECTURE.md` and continue.

## Starting a session

```text
Read CLAUDE.md, then read the PRD, ARCHITECTURE, and TASK_PLAN in docs/.
Determine the current Epic and completed tasks from the repository state.
Verify the prerequisites for the current Epic.
Then begin with the first incomplete task in that Epic.
Execute tasks sequentially and verify each one before continuing.
```

The repository is the persistent context. Nothing needs to be pasted into chat.
