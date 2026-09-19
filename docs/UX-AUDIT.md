# UX Audit — Lexora

**Date:** 2026-09-19
**Scope:** the behavioural UX layer of the existing application — states, feedback, transitions,
recovery, consistency, accessibility of interaction, and responsiveness of behaviour.
**Not in scope:** visual redesign. `DESIGN.md` records the incumbent system and is treated as the
authority. One exception was raised by the team and is tracked separately (§6).

**Method.** Source inspection of all 10 frontend modules and all 8 routes against the real API
contract; cross-checked against `docs/English_Assessment_Pilot_PRD_v1.1.md` (esp. §9.6), `docs/ARCHITECTURE_v1.1.md`
(esp. §5, §9, §11, §13), and `docs/TASK_PLAN_v1.1.md`. The app was booted and probed
(`node src/server.ts`, `GET /`, `GET /api/student/report` → `401 {"error":"Authentication required"}`,
unmatched `/api/*` → HTML 404). **No browser automation was available this session**, so findings are
source- and contract-derived rather than screenshot-derived; every claim below carries a `file:line`
so it can be confirmed in the running app. Verification method is called out per finding.

---

## 1. Application map

**Stack (verified, not assumed).** React 18.3 + Vite 5.4, TypeScript. Routing is hand-rolled
(`frontend/src/router.tsx`, ~60 lines) — no router package (`package.json` dependencies list has no
router). No state library; each page fetches on mount (`ARCHITECTURE` §5). Icons are `lucide-react`.
Animation libraries: **none**. Design tokens: plain CSS custom properties in
`frontend/src/styles.css` (1773 lines).

### 1.1 Screens

| # | Screen | Route | Purpose | Data dependency |
|---|---|---|---|---|
| 1 | `EntryPage` | `/` | Identify the student; route to assessment or report | `POST /api/session/student-verify` |
| 2 | `AssessmentPage` | `/assessment` | Five-section assessment, autosaved | `GET /api/student/draft`, `PATCH /api/student/draft`, `POST /api/student/submit` |
| 3 | `ReportPage` | `/report` | Results, polling while writing is pending | `GET /api/student/report` |
| 4 | `LoginPage` | `/staff/login` | Staff credential exchange | `POST /api/staff/login` |
| 5 | `DashboardPage` | `/staff/dashboard` | Cohort aggregates, CSV export | `GET /api/staff/dashboard`, `GET /api/staff/export.csv` |
| 6 | `SubmissionsPage` | `/staff/submissions` | Recent-submissions list | `GET /api/staff/dashboard` (reuses `recentSubmissions`) |
| 7 | `SubmissionDetailPage` | `/staff/submissions/:submissionId` | One full internal record | `GET /api/staff/submissions/:id` |
| 8 | `NotFound` | any other | Dead-end recovery | none (`App.tsx:83`) |

#### 1. `EntryPage` — `/` (`pages/student/EntryPage.tsx`)
- **Entry:** direct link, `navigate('/', {replace})` from `AssessmentPage` on 401 (`:74`), `ReportPage` on 401 (`:89`).
- **Exit:** `/assessment` or `/report` by returned `status` (`:77`); link to `/staff/login`.
- **Actions:** three text fields, one submit.
- **Loading:** button label → "Checking…", fields + button `disabled` (`:129,142`).
- **Empty:** n/a.
- **Error:** two kinds, correctly distinguished (`:79-89`) — validation failures map to per-field
  `details`; identity mismatch renders as a `role="alert"` notice above the form. Values preserved.
  Field error clears as the student types (`:58-62`).
- **Success:** navigation only. No confirmation — appropriate, since the next screen *is* the result.
- **Interactive states:** focus ring via global `:focus-visible`; invalid field border + `aria-invalid`
  + `aria-describedby`. **No autofocus** on the first field.
- **Transition:** none.

#### 2. `AssessmentPage` — `/assessment` (`pages/student/AssessmentPage.tsx`)
- **Entry:** `EntryPage` on `draft`; returning student; browser Back.
- **Exit:** `navigate('/report', {replace})` on submit (`:288`); `navigate('/', {replace})` on 401 (`:74`); `navigate('/report', {replace})` if already submitted (`:62`).
- **Actions:** section chips ×5, Previous/Next section, radio answers, essay textarea, Likert scale,
  EN/AR toggle, open-text textarea, Submit.
- **Loading:** full-page `"Loading your assessment…"` in a bare card (`:106-115`).
- **Empty:** n/a.
- **Error:** load failure → red notice + reassurance that answers are safe (`:88-104`); submit refusal
  → red notice in the submit panel (`:313-317`).
- **Success:** autosave indicator (`idle|saving|saved|error`) — a `role="status" aria-live="polite"`
  line with reserved height (`:343-357`). Submit success is the navigation.
- **Interactive states:** current chip inverted via `aria-current`; option rows tint on
  `:has(input:checked)`; Previous disabled at position 0, Next at the last section (`:207,215`);
  Submit disabled until `assessCompleteness` reports complete (`:320`).
- **Transition:** none between sections.

#### 3. `ReportPage` — `/report` (`pages/student/ReportPage.tsx`)
- **Entry:** post-submit navigation; `EntryPage` on `submitted`; `AssessmentPage` on `submitted`.
- **Exit:** none. Terminal by design.
- **Actions:** disclosures (question detail ×3), nothing else.
- **Loading:** full-page `"Loading your report…"` (`:137-146`).
- **Empty:** n/a — a submission always has deterministic scores.
- **Error:** load failure → red notice + "Reload this page to try again." (`:122-135`).
- **Success/pending:** `WritingPanel` renders four distinct status states (`:272-318`) including the
  `aria-live` line "Checking for your feedback…". Failure copy explicitly protects the student
  (`FAILED_WRITING`, `:328-334`).
- **Polling:** 10s while writing is non-terminal (`:56,105-120`); failed polls swallowed silently (`:112-116`).
- **Interactive states:** disclosures only.
- **Transition:** none when the poll flips pending → succeeded; the panel's content is replaced in place.

#### 4–7. Staff screens
- **`LoginPage`:** same field/refusal pattern as `EntryPage`. Loading label "Signing in…".
  Generic error preserved (`:83-89`). No autofocus.
- **`DashboardPage`:** cohort `<select>` (disabled while loading), CSV export button, 4 KPI cards,
  metrics list, submission grid, chart + distribution disclosure, weakest topics, writing criteria,
  Student Problems panel.
  - **Loading:** bare card `"Loading dashboard…"` **without `StaffLayout`** (`:159-167`); filter change
    keeps old numbers and announces "Updating…" (`:248-250`); export label → "Preparing export…" (`:265-269`).
  - **Empty:** handled well and specifically — no submissions (`:344`), no topics cleared threshold
    (`:555`), no writing evaluated (`:605`), no statements (`:816`), no derived categories (`:855`).
  - **Error:** load failure → bare card **without `StaffLayout`** (`:145-157`); 404 on a stale cohort
    drops the filter and shows a notice (`:87-91`); export failure → notice (`:277-281`); 401 →
    `navigate('/staff/login', {replace})`.
- **`SubmissionsPage`:** reuses the dashboard payload; says so when the 25-row cap is hit (`:158-160`).
  Empty state is bare text: `"No submissions yet."` (`:120`).
- **`SubmissionDetailPage`:** scores, writing panel keyed off status, Student Problems with the
  original/derived split and a normalised-text disclosure (`:367-381`). 404 renders a notice with a
  link back (`:70-82`).

#### 8. `NotFound` (`App.tsx:83-94`)
Renders `page--toggle` + floating theme toggle + card + "Back to the start".

### 1.2 Components with meaningful behaviour

| Component | File | Behaviour | States handled |
|---|---|---|---|
| `useAutosave` | `hooks/useAutosave.ts` | Debounced (1.5s) section-scoped PATCH; 3 attempts, 4s apart | `idle/saving/saved/error` |
| `ThemeToggle` | `components/ThemeToggle.tsx` | `localStorage` + `data-theme` | light/dark, `aria-pressed` |
| `ChoiceQuestions` | `components/ChoiceQuestions.tsx` | Radio groups, section-scoped names | checked/unchecked, no per-question feedback |
| `StaffLayout` | `components/StaffLayout.tsx` | Sidebar + topbar shell | `activeItem` via `aria-current`; **no collapse** (documented) |
| `StudentProblemsSection` | `pages/student/StudentProblemsSection.tsx` | 5-point scale, EN/AR toggle, RTL field | `aria-pressed` toggle; no announcement on switch |
| `Link` | `router.tsx:150-167` | Intercepts plain left-click only | honours modifier/middle-click |
| `assessCompleteness` | `assessmentCompleteness.ts` | Advisory submit gate | per-section complete/incomplete |

**Destructive/irreversible operations:** exactly one — **Submit assessment** (`AssessmentPage.tsx:279-293`).
No confirmation step.

### 1.3 User journeys

```
J1  Student, first visit
    /  → identify → /assessment → 5 sections → submit → /report (writing pending) → poll → complete

J2  Student, returning                      J3  Student, already submitted
    /  → identify → /assessment (draft)         /  → identify → /report
    (resumes; autosave continues)

J4  Student, session expired mid-assessment J5  Staff
    /assessment → 401 → / (replace)             /staff/login → /staff/dashboard
                                                → filter → /staff/submissions → detail → export

J6  Student, tab closed mid-edit            J7  Any, dead link
    flush on unmount (best effort)              → NotFound → /
```

---

## 2. Findings — P0 (usability / blocking / silent failure)

### P0-1 · Autosave misroutes a student whose submission already exists
`hooks/useAutosave.ts:107-119` catches every failure identically. It never reads `ApiError.status`.
After a submission exists — the student submitted in another tab, or pressed Back, or left the page
open — `PATCH /api/student/draft` returns **409 forever** (`student.routes.ts:181`, message *"This
assessment has already been submitted, so it can no longer be changed"*). The hook retries 3× over
~8s, then renders *"We could not save your last changes — check your connection."*

The student is told their connection is at fault and is left on an assessment that no longer accepts
writes, with no route to their report. `ReportPage` already handles 409 as a navigation
(`:88`); the autosave path does not.
**Verify:** submit in tab A, type in tab B, wait ~10s.

### P0-2 · Navigation never resets scroll position
`router.tsx:38-46` calls `pushState`/`replaceState` and dispatches `NAVIGATION_EVENT`. Nothing
anywhere calls `scrollTo` (grep: no `scrollTo` / `scrollRestoration` in `frontend/src`). React swaps
the route's subtree but the window keeps its offset.

Consequences: opening a submission from the bottom of the dashboard lands mid-record; opening
`/report` from a scrolled `/assessment` lands mid-report; `NotFound` renders at whatever offset.
**Verify:** scroll to the bottom of `/staff/dashboard`, click any submission card.

### P0-3 · No route-change focus management, and the document title never changes
`frontend/index.html:12` sets `<title>English Assessment</title>` and no code ever updates it
(grep: no `document.title` in `frontend/src`). Focus is never moved on navigation.

For a keyboard or screen-reader user this is the classic SPA failure: after activating a link,
nothing announces that the page changed, and focus remains on the (now unmounted) link. Every entry
in browser history carries the same title.
**Verify:** Tab to a submission card, Enter, then read the focused element.

### P0-4 · Staff cannot sign out
`POST /api/staff/logout` is implemented (`src/api/staff.routes.ts:151`) and integration-tested
(`staff.routes.test.ts:166-190`), but **no frontend code calls it** (grep: `logout` appears in
`src/api/*` only). `StaffLayout` renders a brand, two nav items, and a footer — no account control.

The staff session is 8 hours absolute (`ARCHITECTURE` §9) with no way to end it early. This is the
one remaining way the UI contradicts `NFR-SEC-010`'s intent that staff access be held more tightly
than student access.

### P0-5 · A truncated CSV export is undetectable and silent
`src/api/staff.routes.ts:353` routes a stream error to `next(error)`; `errorHandler.ts:60-63` sees
`headersSent` and destroys the connection. The client receives a **200 status line with a partial
body**, so `downloadStaffExportCsv` (`api/client.ts:286-317`) resolves normally and
`DashboardPage.handleExport` (`:119-143`) saves the file. Staff get a corrupt CSV with no indication.

The client cannot distinguish this today. Any fix must either compare received length against
`Content-Length` or make the export non-streaming; this is called out as a **backend-adjacent
decision** in the plan, not something the frontend can solve alone.

### P0-6 · Submission is irreversible and takes one click, with no confirmation
`AssessmentPage.tsx:319-323` — a single activation of **Submit assessment** finalizes permanently.
The copy immediately above it states the consequence clearly (`:298-301`), which is good, but there
is no confirmation step, no "are you sure", and no undo. `FR-ASSESS-008` and `FR-STU-007` make
immutability normative; nothing in the requirements forbids a confirmation, and the product's own
Principle 3 says consequential actions must be legible *before* they happen.
**Note:** the button is also unreachable by keyboard-Enter on the page level — there is no `<form>`,
so Enter in the essay textarea does not submit (correct) but Enter anywhere else does nothing.

---

## 3. Findings — P1 (missing feedback, recovery, or interaction clarity)

### P1-1 · The section navigation cannot show which sections are complete
`styles.css:528-535` defines `.section-nav .tick` — a green completion marker inside the section
chips, with an inverted variant for the current chip. **No markup ever renders `.tick`** (verified:
no `className` in `frontend/src` contains `tick`). The capability was designed and never built.

`assessCompleteness` already computes per-section completeness on every render
(`AssessmentPage.tsx:274`) and is used only to disable the submit button and list unfinished
sections *on the last section only* (`:233,297-311`). A student on section 2 of 5 has no way to learn
that section 4 is unfinished without visiting all of them.

Related: the Submit control does not exist until the last section is reached (`:233`), so "am I
ready?" is unanswerable early.

### P1-2 · Staff loading and error states drop the entire application shell
`DashboardPage.tsx:145-167`, `SubmissionsPage.tsx:69-91`, `SubmissionDetailPage.tsx:70-92` all
return `<main className="page"><div className="card">…` with **no `StaffLayout` and no `ThemeToggle`**.

Loading `/staff/dashboard` therefore renders a single narrow centred card, then swaps to a full
sidebar shell — a full-page layout jump on every visit. On a load error the staff member loses the
sidebar entirely, including the only navigation they have; `SubmissionsPage` and `DashboardPage`
offer "Reload this page" as the sole recovery, and `SubmissionDetailPage` offers one link back.

### P1-3 · The server's own list of unfinished sections is discarded
A refused submit returns `400 { error, incompleteSections: [...] }`
(`student.routes.ts:232-235`) — a **different shape from the validation `details` envelope**. The
client renders `error.message` only (`AssessmentPage.tsx:290`), dropping `incompleteSections`.

The client-side gate normally prevents reaching this state, so the impact is low — but this is the
exact case where the server is authoritative and the client's own model was wrong, and the specific
diagnosis is thrown away rather than shown.

### P1-4 · Rate-limit refusals don't say how long to wait
`429` responses carry a `Retry-After` header in whole seconds (`rateLimit.ts:62,125-127`). The client
never reads it (grep: no `Retry-After` in `frontend/src`). The server's message is
*"Too many attempts — please try again later"* and the fallback is *"Too many attempts — please wait
a moment and try again"*. Neither says whether that is thirty seconds or fifteen minutes, on the two
screens where a student or staff member is stuck.

### P1-5 · No `prefers-reduced-motion` support anywhere
Grep across `frontend/src`: no `prefers-reduced-motion`, no `@keyframes`, no `animation`. There are
four `transition` declarations (`styles.css:392,429,1152,1481`), including a `300ms` height animation
on the comparison chart's bars (`:1481`). Small in volume, but the system has no mechanism at all for
honouring the preference, so any motion added later inherits that gap.

### P1-6 · The staff shell has no responsive rules
Grep of every `@media` block in `styles.css`: none mention `.staff-shell`, `.staff-sidebar`,
`.staff-topbar`, `.bar-row`, `.rank-row`, `.criteria-row`, or `.compare-chart`. `--sidebar-w` is a
fixed `15.5rem`.

At 375px the sidebar occupies 248px, leaving ~127px for content, and the three-column data grids
(`6.5rem 1fr 3rem`) overflow. The student screens have breakpoints; the staff screens have none.
No requirement asks for this (`CLAUDE.md` states there is no mobile target) — recorded here as a
team-confirmed scope addition, not a requirement gap.

### P1-7 · The report has no print treatment
No `@media print` rule exists. The report is the one screen a student is most likely to want to keep
or share with a teacher, and printing it today would include the floating theme toggle, every card
border, and the collapsed disclosures in whatever state they were left.

### P1-8 · Autosave's "Saved" never decays
`useAutosave` sets `status: 'saved'` on success (`:106`) and nothing ever returns it to `idle` — the
only path back is a *section change* (`:142`). A student who edited Grammar twenty minutes ago and
has been reading Reading since still sees a green "Saved" beside the Reading section they have not
touched. The indicator reports the last accepted request, which is honest, but it sits next to
content it does not describe.

### P1-9 · Switching sections moves content without moving the reader
Selecting a section chip (or Previous/Next) replaces the card body (`:192-200`). Nothing scrolls the
window to the new section heading and nothing moves focus. On a long section — Reading renders every
passage and every question in one card — a student who scrolls to the bottom of Reading, then clicks
"Grammar", stays at a scrolled offset inside a much shorter section.

### P1-10 · `--card` is an undefined design token
`styles.css:552` sets `background: var(--card)` on `.summary-item`. No `--card` is defined anywhere
(a scripted diff of all `var(--x)` uses against all `--x:` declarations returns exactly one
undefined name: `--card`). The declaration is invalid and `.summary-item` renders with a transparent
background — invisible in light mode against a white card, but not in dark mode, where the intent
(a distinct tile surface) is lost. Dead CSS nearby: `.card--emphasis` (defined `:179-183`, rendered
nowhere).

### P1-11 · No unsaved-work protection on the way out
The only defence is the unmount cleanup (`useAutosave.ts:168-172`), which fires a request the browser
is not obliged to finish. Nothing listens for `beforeunload`, so closing the tab during the 1.5s
debounce window — or during a retry — can lose the last edit with no warning. The comment at
`:160-167` acknowledges this honestly; it is recorded here because the student-visible consequence
is silent data loss, which Principle 2 forbids.

### P1-12 · Report polling replaces content with no announcement
When the 10s poll returns `writingStatus: 'succeeded'`, `setReport` swaps `WritingPanel`'s body from
the "still being prepared" panel to full results (`ReportPage.tsx:110`). The `aria-live` region
belongs to the panel that is removed, so the newly arrived feedback is not announced. A student
using a screen reader, or simply not looking at that panel, has no signal that anything changed.

---

## 4. Findings — P2 (polish, consistency, micro-interaction)

| # | Finding | Evidence |
|---|---|---|
| P2-1 | Duplicate breakpoint spellings: `480px` at `:572` and `30rem` at `:1630,1679` are the same width. | `styles.css` |
| P2-2 | `--warning` is defined but never used (only `--warning-line` and `--warning-soft` are). | `styles.css:32` |
| P2-3 | No autofocus on the first field of `EntryPage` or `LoginPage` — a student on a phone taps an extra time. | `EntryPage.tsx:118` |
| P2-4 | `SubmissionsPage` empty state is bare text with no next action, unlike the dashboard's specific empties. | `SubmissionsPage.tsx:120` |
| P2-5 | `NotFound` and staff error shells render without the shell the surrounding area uses, so "page not found" looks unlike the app. | `App.tsx:83` |
| P2-6 | No `aria-busy` on any submitting form; the disabled button + label change is the only signal. | `EntryPage.tsx:142` |
| P2-7 | `ThemeToggle`'s accessible name changes with state ("Dark mode" / "Light mode") *and* `aria-pressed` is set — the name describes the action while `aria-pressed` describes the state. | `ThemeToggle.tsx:60-63` |
| P2-8 | The EN/AR toggle announces nothing on switch; the surrounding statements change language silently. | `StudentProblemsSection.tsx:101-116` |
| P2-9 | `ChoiceQuestions` gives no answered/unanswered affordance within a section. | `ChoiceQuestions.tsx:36-67` |
| P2-10 | A failed dashboard poll leaves stale numbers on screen with no staleness marker — the notice reports the error but not that the figures above it are old. | `DashboardPage.tsx:222-226` |
| P2-11 | The `title` attribute is the only affordance for truncated Likert labels; on touch there is no tooltip at all. | `StudentProblemsSection.tsx:157` |
| P2-12 | No loading skeleton anywhere; every load is a text line in a bare card. | all pages |

---

## 5. What is already good (do not regress)

The audit is not a list of failures — most of this is more careful than a product at this stage
usually is, and the plan below deliberately preserves it.

- **The two kinds of refusal are genuinely distinguished.** Validation failures map to fields;
  identity failures stay generic and are never attributed to a field (`EntryPage.tsx:79-89`,
  `LoginPage.tsx:79-89`). This is the hard part of `ARCHITECTURE` §11 and it is right.
- **The report never claims a result it does not have.** `WritingPanel` keys its results branch off
  `writing !== null`, not off `status === 'succeeded'` (`ReportPage.tsx:279`) — so a `succeeded`
  status with no feedback falls through to the honest "we could not prepare this" copy rather than
  announcing results that do not exist. `FR-FEEDBACK-008` is implemented structurally, not by
  convention.
- **Empty is distinguished from zero.** "The mean of an empty set is undefined, not zero"
  (`DashboardPage.tsx:510-511`); `—` for a null score (`SubmissionDetailPage.tsx:170`); "None."
  rather than an empty heading (`ReportPage.tsx:407`).
- **Derived data is separated by design, not by label.** The Student Problems original and derived
  blocks differ in border, background, and placement *and* carry a tag (`SubmissionDetailPage.tsx:272-291`),
  which is what `FR-PROB-011` actually requires.
- **The save indicator is a live region with reserved height**, so it never shifts layout (`:343-357`).
- **Selection state is expressed through ARIA and styled from it** (`aria-current`, `aria-pressed`),
  so visual and accessible state cannot drift.
- **Failure copy protects the student.** `FAILED_WRITING` leads with "your written response has been
  saved exactly as you wrote it" (`ReportPage.tsx:328-334`).

---

## 6. Out-of-scope finding, raised by the team

**Visual amplification.** On 2026-09-19 the team asked for the app to be *"a little bit visually
louder… without it turning into chaos"*, and clarified that the dashboard may become **visually**
more dashboard-like **provided the analysis does not change and no PRD rule is bypassed**.

This sits outside the behavioural brief and is recorded rather than actioned. It has one hard
constraint that must travel with it: `FR-STAFF-012` states the dashboard *"is explicitly not a full
business-intelligence platform"*, and that is a limit on **function** (no drill-down, no sorting, no
paging, no new analysis), not on presentation. Any amplification must therefore be expressible
entirely in `styles.css` and existing markup.

---

## 7. Coverage and confidence

**Verified by direct execution:** the API contract (status codes, exact message strings, error
envelope shapes, rate limits, idempotency) — extracted from source and confirmed against the running
server for `401`, the `/api/*` HTML-404 path, and server boot.

**Verified by source inspection:** every screen's state handling, every mapping in §1, and every
finding above, each with a `file:line`.

**Not verified this session — requires the running app in a browser:**
- Actual visual appearance of any state (no screenshot was taken).
- Real keyboard traversal order, focus visibility at each control, and screen-reader output.
- Behaviour at each breakpoint, including the staff-shell overflow in P1-6.
- The truncation in P0-5 (needs a mid-stream failure to reproduce).
- Contrast ratios: no measurement was taken. `--ink-faint` (`#8892a0`) on `--paper` (`#ffffff`) is
  approximately 3.2:1, which would **fail WCAG AA for body text** and pass only for large text — this
  is a *hypothesis from the token values*, not a measurement, and must be confirmed with a contrast
  tool before being treated as a defect. `--ink-soft` (`#565f6b`) on white is approximately 7:1 and
  is fine.

**Playwright MCP is configured at user scope** (`~/.claude.json`, Edge channel, headless) but was
**not available to this session**; the `impeccable` plugin was installed during this session and
likewise loads at session start. Both become usable on the next session, which is when the
verification steps in the plan should be run.
