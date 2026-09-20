# UX Implementation Plan — Lexora

**Date:** 2026-09-19
**Companion to:** `UX-AUDIT.md` (findings, evidence), `DESIGN.md` (the visual system, unchanged),
`PRODUCT.md` (product truth), `UX-DECISIONS.md` (conventions established, and what was not done).
**Status:** **approved and implemented** 2026-09-19, with decision G1 taken as option (b). See
`UX-DECISIONS.md` §3 for the four consolidation patterns that were deliberately not built and §4 for
exactly what has and has not been verified. **The browser verification below has not been run** —
it is the outstanding step.

---

## A. Executive summary

### What is missing

Lexora's **static** state handling is unusually good — the report never claims a result it lacks, an
empty set is never rendered as zero, refusals are split correctly into "fix your form" and "we can't
tell you which field", and derived AI data is separated by structure rather than by caption. That
foundation is sound and this plan does not touch it.

What is missing is the layer **between** those states:

1. **The application does not know it has navigated.** Eight routes share one `<title>`, focus is
   never moved, and the window scroll offset is never reset. Every route change is a silent
   subtree swap.
2. **Failure is handled per-call-site, not per-class.** Each page invents its own error markup; none
   of them inspect `ApiError.status` beyond `401`. That is why a `409` reads as "check your
   connection" (P0-1), why a `429` cannot say how long to wait (P1-4), and why a truncated download
   looks like success (P0-5).
3. **The staff half of the app has no shell continuity.** Loading and error states drop the sidebar
   entirely, so the app visibly falls apart exactly when it is already failing.
4. **There is no motion vocabulary and no reduced-motion mechanism** — four transitions, no
   keyframes, no preference handling.
5. **The system has no completion model made visible.** `assessCompleteness` already computes which
   sections are done; the navigation that would show it was designed (`.section-nav .tick`) and
   never built.

### The strategy

Fix the **shared mechanisms** first, then let the screens inherit them. Three findings (P0-1, P0-4,
P0-5) are specific bugs and get fixed specifically. The rest are one of five cross-cutting gaps, and
are solved once each:

| Gap | Solved by | Screens that inherit it |
|---|---|---|
| Route change is invisible | one effect in `App.tsx` (focus + title) + `navigate()` scroll reset | all 8 |
| Failure handled ad hoc | a typed `ApiError` policy + one `Notice` component | all 8 |
| Page states re-invented per page | `PageShell` (student) and shell-preserving staff states | 6 |
| Live status markup repeated | one `LiveStatus` component | 4 |
| No motion vocabulary | motion tokens + a reduced-motion block | all |

This is deliberately **not** eight screens × five states of bespoke work. It is five patterns and a
handful of targeted fixes.

### Explicit non-goals

- No visual redesign. `DESIGN.md` records the incumbent system and the palette, type, spacing, and
  component language stay as they are.
- No new dependencies. `ARCHITECTURE` §2 pins the dependency set; everything below is plain React,
  plain CSS, and native `<dialog>`.
- No new analysis, aggregation, endpoint, or schema change. The only server-side touch is P0-5, and
  it is flagged for a decision rather than assumed.
- The "visually louder" request (§6 of the audit) is **not** in this plan. It is a separate pass.

---

## B. UX principles for this application

Derived from the product's own principles and the existing implementation's demonstrated values.

1. **Every async action states its condition, and never invents one.** Waiting, saved, failed, and
   finished are four different things and must never share a representation. A spinner that resolves
   into a silent failure is worse than no spinner.
2. **A refusal says what happened and what to do next — or says nothing at all.** If the user can fix
   it, it is specific and attached to the field. If naming it would help someone guess another
   student's identity, it is generic and deliberate. There is no third kind.
3. **Irreversible actions are legible before they are taken.** Submitting cannot be undone, so the
   consequence is stated in advance and confirmed at the moment of action — not explained afterwards.
4. **The interface may never lose work silently.** A save that did not happen must say so; a page
   that cannot save must not pretend it can; a closed tab must not be the moment work disappears.
5. **Motion reports state; it does not decorate.** Every animation answers "what changed?". If the
   answer is "nothing", it is not added. Every motion respects `prefers-reduced-motion`.
6. **Navigation is a place, not a re-render.** Changing route resets position, moves focus, and names
   the page — so the back button, a screen reader, and a pair of eyes all agree on where they are.
7. **Empty, zero, and unknown are three different things.** Already true in the data; it becomes a
   rule for every new state.
8. **Failure never removes the way out.** An error screen keeps the navigation, the theme control,
   and a route back to a working state.

---

## C. Screen-by-screen plan

Legend: **Cur** = current behaviour · **Miss** = missing UX · **Prop** = proposed behaviour.

---

### C1 · `EntryPage` — `/` (`pages/student/EntryPage.tsx`)

- **Cur:** correct two-kind refusal handling; field errors clear on type; values preserved; disabled
  inputs while submitting; label swaps to "Checking…".
- **Miss:** no autofocus; no `aria-busy`; the refusal notice is rendered *above* the form while focus
  stays on the submit button, so a keyboard user must reverse-tab to read it; no focus move to the
  first invalid field.
- **Prop:** autofocus the first field; mark the form `aria-busy` while submitting; on a validation
  refusal, move focus to the first field carrying an error; on an identity refusal, move focus to the
  notice. Values and the existing copy are untouched.
- **Loading:** unchanged (disabled + "Checking…" + `aria-busy`).
- **Empty / Success:** n/a — success is the navigation.
- **Error:** unchanged wording; focus now lands on it.
- **Interaction:** add `:focus-visible` verification on the submit button; no visual change.
- **Motion:** none. The notice appears without animation (see D1 note on why error appearance is
  exempt from the motion layer).
- **Priority:** P1 (focus management), P2 (autofocus).

---

### C2 · `AssessmentPage` — `/assessment` (`pages/student/AssessmentPage.tsx`)

- **Cur:** five sections, bidirectional navigation, section-scoped autosave with a four-state live
  status, server-authoritative submit, advisery completeness gate that lists unfinished sections.
- **Miss:**
  - The section navigation cannot show which sections are complete, though `assessCompleteness`
    already knows (P1-1).
  - Submit is unreachable and invisible until the last section (P1-1).
  - Autosave routes a `409` into a generic connection error (P0-1).
  - "Saved" never decays to idle (P1-8).
  - Changing section keeps the scroll offset and focus (P1-9).
  - Submit is irreversible with no confirmation (P0-6).
  - A server `400`'s `incompleteSections` is discarded (P1-3).
  - No unsaved-work warning on unload (P1-11).
- **Prop:**
  - **Completion ticks.** Render the existing `.section-nav .tick` from `assessCompleteness`, so each
    chip shows done/not-done. This is the piece `.section-nav .tick` was written for.
  - **An always-available readiness line.** A persistent, unobtrusive progress line — "3 of 5
    sections complete" — visible on every section, so the question "am I done?" is answerable
    without reaching the end. The existing submit *panel* stays last-section-only; the *status* does not.
  - **Autosave status policy.** `useAutosave` reads `ApiError.status`: `409` → stop retrying and
    navigate to `/report` (the work is already final); `401` → stop retrying and navigate to `/`;
    `400` → stop retrying and surface immediately (retrying cannot help); network/`5xx` → keep the
    existing 3-attempt backoff. The error copy stays, but only for errors where it is true.
  - **Saved decays to idle.** After a short dwell (~4s) `saved` returns to `idle`. The indicator then
    describes the current section rather than the last request.
  - **Section change is a position change.** Scroll the section heading into view and move focus to
    it on section change, including via the chips.
  - **Submit confirmation.** A native `<dialog>` (`showModal()`) stating plainly that answers become
    final and cannot be changed or retaken, with "Go back" and "Submit final answers". `showModal()`
    supplies focus containment and Esc for free — no dependency, no hand-rolled trap. The dialog
    flushes the pending autosave *before* opening, so what the student confirms is what will be sent.
  - **Surface the server's diagnosis.** On a `400`, render `incompleteSections` as the same list the
    client gate builds, marking the discrepancy honestly.
  - **Unload guard.** A `beforeunload` handler registered only while (a) a save is in flight or
    (b) an edit is pending, removed the moment the queue is clean. No prompt during normal navigation.
- **Loading:** replace the bare `"Loading your assessment…"` card with a skeleton that matches the
  assessment's own shape (nav chips, section heading, question blocks) so the layout does not jump.
- **Empty:** n/a.
- **Error:** unchanged copy; the shell/pattern now comes from `PageShell`.
- **Success:** the save indicator, now with decaying state and correct 409 handling.
- **Interaction:** chips gain a completion state; Previous/Next already disable correctly; add
  `aria-busy` on the submit panel while submitting.
- **Motion:** save-status state changes and the completion tick get the motion layer (D1). Section
  content does not cross-fade.
- **Priority:** **P0** (409 handling, submit confirmation) · **P1** (ticks, readiness, saved decay,
  section scroll/focus, server diagnosis, unload guard).

---

### C3 · `ReportPage` — `/report` (`pages/student/ReportPage.tsx`)

- **Cur:** immediate deterministic results; four honest writing states; 10s polling that stops when
  settled; failures swallowed on poll; `409`/`401` routed as navigations.
- **Miss:** the poll result is not announced when it arrives (P1-12); no print treatment (P1-7); the
  terminal screen offers no exit at all.
- **Prop:**
  - **Announce the arrival.** Move the live region out of the panel that gets replaced — a persistent
    `LiveStatus` on the page announces "Your writing feedback is ready" when the status transitions
    from waiting to settled. The panel itself then renders in place.
  - **Print stylesheet.** `@media print` hiding the theme toggle and the summary card's chrome,
    forcing the disclosures open, and using black-on-white. Reveals the report as the document it is.
  - **A way onward.** One quiet footer line linking back to the start, so the terminal screen is not
    a dead end for a student who has finished reading.
- **Loading:** skeleton matching the summary strip + panels.
- **Empty:** n/a.
- **Error:** unchanged copy.
- **Success/pending:** the four states are already correct and are **not changed**. Only the arrival
  announcement is added.
- **Interaction:** disclosures keep native behaviour.
- **Motion:** the pending → ready swap gets a single restrained fade/slide (D1). This is the one place
  new content genuinely arrives while the student is looking at it.
- **Priority:** P1.

---

### C4 · `LoginPage` — `/staff/login` (`pages/staff/LoginPage.tsx`)

- **Cur / Miss / Prop:** identical treatment to `EntryPage` (C1) — autofocus, `aria-busy`, focus move
  on refusal. The generic-refusal requirement (`ARCHITECTURE` §11) is preserved exactly; focus moves
  to the notice, which still names nothing.
- **Rate limiting:** on `429`, render the wait implied by `Retry-After` (P1-4) — "Too many attempts.
  Try again in about 12 minutes." with a quiet live countdown that does not block the form.
- **Priority:** P1.

---

### C5 · `DashboardPage` — `/staff/dashboard` (`pages/staff/DashboardPage.tsx`)

- **Cur:** thorough, specific empty states; the one attention-tinted KPI; filter keeps old numbers
  and announces "Updating…"; export with a labelled in-flight state; `404` on a stale cohort drops
  the filter.
- **Miss:** loading and error states drop `StaffLayout` entirely (P1-2); stale numbers are not marked
  as stale after a failed refetch (P2-10); no responsive rules (P1-6); export failure is
  indistinguishable from a truncated success (P0-5).
- **Prop:**
  - **Keep the shell.** Loading and error render *inside* `StaffLayout`, so the sidebar and theme
    control never disappear. The error state keeps navigation and adds "Reload" as an action.
  - **Mark staleness.** When a refetch fails, the notice says the figures on screen are from the last
    successful load *and* when that was. A number that might be old must not look current.
  - **Responsive shell.** A single `@media (max-width: 40rem)` block: the sidebar becomes a
    horizontal bar (brand + nav items + theme control), and the three data grids collapse to stacked
    label-above-bar rows. Presentational only — no analysis changes.
  - **Export integrity.** See §G — needs a decision before implementation.
- **Loading:** skeleton for the KPI strip and the chart rather than "Loading dashboard…".
- **Empty:** already good; unchanged.
- **Error:** shell preserved, staleness marked, navigation retained.
- **Success:** export completes by downloading, unchanged.
- **Interaction:** filter `disabled` while loading already; add `aria-busy` to the results region.
- **Motion:** chart bar heights already animate at 300ms (kept, and now gated on reduced motion).
- **Priority:** **P0** (export integrity, pending decision) · **P1** (shell, staleness, responsive).

---

### C6 · `SubmissionsPage` — `/staff/submissions` (`pages/staff/SubmissionsPage.tsx`)

- **Cur:** reuses the dashboard payload, states the 25-row cap plainly, cards are the link.
- **Miss:** shell dropped on load/error (P1-2); bare empty state with no next action (P2-4); the list
  cannot show status at a glance beyond the pill.
- **Prop:** keep the shell; give the empty state a sentence and a link to the dashboard; no other
  change. The cap notice and the card pattern stay exactly as they are.
- **Priority:** P1 (shell) · P2 (empty state).

---

### C7 · `SubmissionDetailPage` — `/staff/submissions/:submissionId` (`pages/staff/SubmissionDetailPage.tsx`)

- **Cur:** the original/derived separation is structurally correct; status copy is per-state; the
  normalised text is collapsed by default.
- **Miss:** shell dropped on load/error (P1-2); a `404` offers only a link back with no explanation
  of *why* (a deleted id, a mistyped URL, and a stale link are all "No such submission").
- **Prop:** keep the shell; on `404`, state that the record does not exist and offer the submissions
  list as the next action rather than only the dashboard.
- **Priority:** P1.

---

### C8 · `NotFound` (`App.tsx:83`)

- **Cur:** floating theme toggle, a card, a link home.
- **Miss:** shows the raw pathname without saying whether it is a typo or a removed page; no way back
  to where the user probably came from.
- **Prop:** keep it minimal, add a second route back (`history.back()` as "Go back") alongside "Back
  to the start". No staff shell — this route has no known audience.
- **Priority:** P2.

---

## D. Flow-by-flow plan

### D1 · Motion layer (cross-cutting)

Applied **after** the P0 fixes and the shared patterns, and only to the four places where motion
reports something.

**Tokens** (added to `:root` in `styles.css`):

```
--motion-fast:  120ms;   /* already the de-facto hover/focus duration */
--motion-base:  200ms;   /* state swaps inside a panel */
--motion-slow:  300ms;   /* the chart's existing bar height */
--ease-standard: ease;
```

**A `prefers-reduced-motion` block** collapses all three durations to `1ms` and removes transforms,
so every animation below degrades to an instant state change rather than being individually
special-cased:

```css
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 1ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 1ms !important;
    scroll-behavior: auto !important;
  }
}
```

| Where | What changes | Communicates | Duration |
|---|---|---|---|
| Save status (`C2`) | opacity/colour cross-fade between `saving` → `saved` → `idle` | the save completed | `--motion-base` |
| Completion tick (`C2`) | tick scales in | this section just became complete | `--motion-fast` |
| Report pending → ready (`C3`) | panel content fades and lifts ~4px | new feedback arrived in place | `--motion-base` |
| Disclosures (`C3`, `C5`) | `::before` glyph rotate | open/closed | `--motion-fast` |
| Chart bars (`C5`) | existing 300ms height | the filter changed the data | `--motion-slow` |
| Section change (`C2`) | smooth `scrollIntoView` for the heading | you moved to a different section | `--motion-base` |

**Explicitly rejected:** page/route transitions (the audit's J1–J7 journeys are short and a transition
would add latency to every one); hover animation beyond the existing colour transitions (decorative);
staggered list reveals on the dashboard (the page is read, not watched); celebratory motion of any
kind — the team confirmed the product must not be competitive or gamified, and submission is
irreversible rather than an achievement.

**Error notices deliberately do not animate in.** A failure should be immediately and unambiguously
present, not sliding into view.

---

### D2 · Journey: student identifies and starts (`J1` entry)

- **Current:** fill three fields → "Checking…" → either field errors, a generic refusal, or a
  replace-navigation to `/assessment` or `/report`.
- **Missing states:** focus never lands on the failure; the new page is not announced.
- **Proposed:** on refusal, focus moves to the notice or the first invalid field. On success, the
  route change announces the new page (shared mechanism). No confirmation is added — the destination
  *is* the confirmation.
- **Failure/recovery:** unchanged; a refused identity keeps all three values so a typo can be fixed
  without retyping.
- **Notes:** the two-kind refusal logic is correct and is not touched.

---

### D3 · Journey: student works through five sections (the core journey)

- **Current:** chips switch sections; answers autosave after 1.5s or on blur; a status line reports
  the last accepted save; Submit appears only on the last section and is disabled until everything is
  answered.
- **Missing states:** no completion visibility; no readiness answer before the end; a save that
  failed for a reason retrying cannot fix is reported as a connection problem; a `409` strands the
  student; the last click is irreversible and unconfirmed; a section change does not move the reader.
- **Proposed:**
  ```
  answer typed
     ↓
  saving (1.5s debounce, then PATCH one section)
     ↓
  ├── 200  → saved → (decays to idle after ~4s)
  ├── 409  → stop; "this is already submitted" → navigate /report
  ├── 401  → stop; session ended → navigate /
  ├── 400  → stop; surface immediately (retrying cannot help)
  └── 0/5xx → retry ×3 @4s → error, with the existing honest copy
  ```
  Readiness is always visible; completion is marked in the navigation; leaving a section moves the
  reader to the next one; submitting opens a confirmation that names the consequence.
- **Failure/recovery:** every branch above has a defined destination. No branch leaves the student on
  a screen that cannot accept their work.
- **Notes:** the server remains the authority on completeness. The client gate stays advisory and the
  server's `incompleteSections` is now shown when the two disagree.

---

### D4 · Journey: student submits and reads the report

- **Current:** submit → replace to `/report` → deterministic results immediately → writing panel
  says "still being prepared" → 10s poll → results appear in place.
- **Missing states:** the arrival is silent; the terminal screen has no exit; the report cannot be
  printed.
- **Proposed:** the confirmation dialog precedes finalization; the report announces the arrival via a
  persistent live region; a print stylesheet makes the report a document; a footer link ends the dead
  end.
- **Failure/recovery:** unchanged and already correct — `failed_needs_review` preserves the original
  response and says so, which satisfies `FR-FEEDBACK-007` and `FR-WRITE-011`.
- **Notes:** the polling interval, the stop condition, and the four status copy blocks are unchanged.

---

### D5 · Journey: staff signs in and reviews the cohort

- **Current:** login → dashboard → filter → open a submission → export.
- **Missing states:** no sign-out; the shell vanishes on load and on error; stale figures are
  unmarked; the export can silently truncate; the shell breaks below tablet width.
- **Proposed:**
  ```
  login ──► dashboard (shell persists through loading and error)
              │
              ├── filter ──► updating (old figures kept, marked as updating)
              │                 └── failure → figures marked STALE + when they were loaded
              ├── open submission ──► detail (shell persists; 404 names the problem)
              └── export ──► preparing → download
                                 └── failure → notice (P0-5, pending decision)
  ```
  Plus a sign-out control in the staff shell, calling the endpoint that already exists.
- **Failure/recovery:** every staff error state keeps the sidebar and the theme control, and offers a
  concrete next action rather than only "reload".
- **Notes:** no new endpoint, no new query, no change to any aggregate.

---

### D6 · Journey: session expiry (`J4`)

- **Current:** a `401` from any student or staff call navigates to `/` or `/staff/login` with
  `replace`. Correct and already implemented.
- **Missing:** the student is not told *why* they are back at the identity form, so it reads as
  "something went wrong" rather than "your session timed out".
- **Proposed:** pass a one-shot reason to the entry page ("Your session ended after a period of
  inactivity — enter your details to continue") and show it once. Purely presentational: the
  session model, durations, and the `replace` behaviour are unchanged.
- **Priority:** P2.

---

## E. Shared patterns

Each is justified by a count of existing duplication, not by symmetry. All are plain React and CSS.

### E1 · `useRouteChange` — route-change focus, title, and scroll (highest leverage)

**Replaces:** nothing today — this is the missing mechanism (P0-2, P0-3).
**Justified by:** 8 routes × 0 handling.

- `navigate()` (`router.tsx`) resets `window.scrollTo(0, 0)` on every push/replace.
- A small hook in `App.tsx` sets `document.title` per route (`"Assessment · Lexora"`, `"Dashboard ·
  Lexora"`, …) and moves focus to the route's `<h1>` (made programmatically focusable with
  `tabindex="-1"`), which is what makes a screen reader announce the new page.
- Back/forward must **not** reset scroll to top blindly; restore the previous offset on `popstate`.

This is the single change that most improves the app's felt coherence, and every screen inherits it
without modification.

### E2 · `Notice` — one refusal/notice component

**Replaces:** 8 hand-written `<div className="notice" role="alert">` blocks across 6 files.
**Justified by:** 8 occurrences, 3 semantic variants already in CSS (`default`, `alert`,
`--privacy`), and one new need (a non-alert informational notice on the dashboard).

Props: `variant: 'info' | 'alert' | 'privacy'`, `children`. Renders `role="alert"` only for `alert`.
`.notice[role='alert']` already styles itself, so this is a markup consolidation with no visual change.

### E3 · `PageShell` — the student page frame

**Replaces:** the repeated `<main className="page page--toggle">` + `<ThemeToggle variant="floating" />`
+ `<div className="card">` opening, in 6 places.
**Justified by:** 6 occurrences, and the shape is about to gain a live region (C3) and skeletons.

Props: `width: 'default' | 'wide'`, `title`, `children`. One place to add the route `h1`, the toggle,
and later the announce region.

### E4 · `LiveStatus` — one polite live region

**Replaces:** 4 separate `role="status" aria-live="polite"` blocks (save status, report checking,
dashboard updating, dashboard export) plus the new arrival announcement.
**Justified by:** 4 occurrences with 4 slightly different markup shapes, and one of them is currently
structurally unable to announce (P1-12).

Props: `message`, `tone: 'neutral' | 'success' | 'error'`, reserved `min-height` preserved so nothing
shifts.

### E5 · `ConfirmDialog` — native `<dialog>`

**New.** Justified by exactly one use (submit, P0-6), so it stays deliberately small.
Native `showModal()` gives focus containment, Esc-to-close, and an inert background with no
dependency and no focus-trap code. Styling reuses card tokens, so it looks like the rest of the system.

### E6 · `useFormRefusal` — shared field-refusal handling

**Replaces:** the near-identical `values` / `fieldIssues` / `refusal` / `submitting` state machine
duplicated in `EntryPage` and `LoginPage` (and the identical `update()` field-error-clearing logic).
**Justified by:** 2 full copies of the same ~40-line pattern, and both need the same P1 fix
(autofocus + focus-on-refusal), which would otherwise be written twice.

Extracted only for the parts that are genuinely identical; the two pages keep their own copy and
their own differing field definitions.

### E7 · Skeletons

**Justified by:** every load in the app is currently a bare text line, and the staff pages
additionally jump layout (P1-2). Two shapes only — an assessment skeleton and a card/panel skeleton —
rather than one per page.

**Not** proposed: a toast/notification system (nothing in the product needs transient notification —
every message belongs to a place on screen); a global async-state wrapper (each page's fetch has a
different destination on failure, which is a product decision, not a pattern); a modal/drawer system
(there is exactly one dialog).

---

## F. Priority

### P0 — blocking, silent failure, or lost work

| ID | Item | Screen |
|---|---|---|
| P0-1 | Autosave stops retrying on 400/401/409 and routes each correctly | Assessment |
| P0-2 | `navigate()` resets scroll; back/forward restores it | all |
| P0-3 | Route change sets `document.title` and moves focus | all |
| P0-4 | Staff sign-out control in the shell | Staff shell |
| P0-5 | Export truncation made detectable *(needs a decision — §G)* | Dashboard |
| P0-6 | Submit confirmation dialog before finalization | Assessment |

### P1 — important: feedback, recovery, interaction clarity

| ID | Item | Screen |
|---|---|---|
| P1-1 | Completion ticks in section nav + always-visible readiness line | Assessment |
| P1-2 | Staff loading/error states keep `StaffLayout` | Dashboard, Submissions, Detail |
| P1-3 | Render the server's `incompleteSections` on a refused submit | Assessment |
| P1-4 | `429` states the wait from `Retry-After` | Entry, Login |
| P1-5 | Motion tokens + `prefers-reduced-motion` block | all |
| P1-6 | Staff shell responsive at ≤40rem | Staff |
| P1-7 | Print stylesheet for the report | Report |
| P1-8 | Autosave "Saved" decays to idle | Assessment |
| P1-9 | Section change scrolls to and focuses the section heading | Assessment |
| P1-10 | Define or remove `--card`; remove dead `.card--emphasis` | `styles.css` |
| P1-11 | Unload guard while an edit is pending or in flight | Assessment |
| P1-12 | Announce writing feedback arriving | Report |
| E1–E7 | Shared patterns (implemented alongside the above) | all |

### P2 — polish

| ID | Item |
|---|---|
| P2-1 | Collapse the duplicate 480px / 30rem breakpoint |
| P2-2 | Use or remove `--warning` |
| P2-3 | Autofocus first field (Entry, Login) — *pulled into C1/C4* |
| P2-4 | `SubmissionsPage` empty state gains a next action |
| P2-5 | `NotFound` and staff error shells look like the app |
| P2-6 | `aria-busy` on submitting forms |
| P2-7 | `ThemeToggle` accessible name describes the action, not the state |
| P2-8 | EN/AR switch announces the language change |
| P2-9 | Answered/unanswered affordance per question |
| P2-10 | Dashboard marks stale figures after a failed refetch |
| P2-11 | ~~Truncated Likert labels: an affordance that works on touch~~ — **done 2026-09-20**, by removing the truncation: the scale is five bare circles now. See `UX-DECISIONS.md` §2. |
| P2-12 | Skeletons — *pulled into C2/C3/C5* |
| D6 | Session-expiry reason shown once on the entry page |
| C8 | `NotFound` gains "Go back" |

### Suggested order

```
P0-1 … P0-6   (six targeted fixes)
      ↓
E1 · E2 · E4  (route change, notice, live status — the mechanisms the rest depend on)
      ↓
P1-1, P1-2, P1-3, P1-8, P1-9, P1-11, P1-12   (feedback and recovery)
      ↓
E3 · E5 · E6 · E7  (shell, dialog, form hook, skeletons)
      ↓
D1 motion layer + P1-5 reduced motion
      ↓
P1-4, P1-6, P1-7   (rate limit, responsive, print)
      ↓
P2 sweep
```

---

## G. Dependencies, risks, and decisions needed

### Decisions needed before implementation

**G1 · Export truncation (P0-5) — the only item that may need a server change.**
The frontend cannot detect a mid-stream failure today, because the response is a `200` with a partial
body. Options:

- **(a) Client-side length check.** Compare the received byte count against `Content-Length`. Requires
  the server to set `Content-Length`, which a streamed response does not do by default — so this is
  still a server change.
- **(b) Buffer the export server-side** and send it with a correct `Content-Length`, so the client can
  verify. Simplest to make correct; costs memory proportional to the export size (pilot scale: small).
- **(c) Accept the risk and document it,** since the export is reproducible and the failure window is
  narrow.

**Recommendation: (b)**, with a client-side check against `Content-Length`. But this touches
`src/api/staff.routes.ts`, which is outside a pure UX pass — so it needs explicit approval, or it
should be split into its own task. **I will not change the endpoint without a decision.**

**G2 · `beforeunload` (P1-11).** Modern browsers show a generic, un-customisable prompt, and it fires
only when the guard is armed. Confirming the intended aggressiveness: arm only while an edit is
pending or a save is in flight (proposed), never during normal navigation.

**G3 · Contrast (audit §7).** `--ink-faint` (`#8892a0`) on `--paper` (`#ffffff`) is ~3.2:1 by
calculation, which would fail WCAG AA for body text. This is a **hypothesis from token values, not a
measurement**, and it is used for `muted` metadata (timestamps, "None.", captions) rather than body
copy. It needs a real measurement before anything changes. If it does fail, the fix is a token-value
change in `styles.css` — which is a **visual** change and therefore needs the team's agreement, since
this pass is not authorised to alter the palette.

### Risks

| Risk | Impact | Mitigation |
|---|---|---|
| `useAutosave` 409 → navigate could interrupt a student legitimately mid-edit in a second tab | They are moved to their report while typing | The submission is already final; the alternative is leaving them to type into a void. Navigation is `replace` and the report explains the state. |
| Scroll-to-top on every navigation can feel abrupt on short pages | Minor | Only reset when the route actually changes; restore offset on `popstate`. |
| `beforeunload` prompts are generic and can feel alarming | Student anxiety | Armed only during a genuinely unsaved window (~1.5s debounce or an in-flight retry). |
| Motion added to an assessment could distract | Undermines the product's calm | Six animations, each justified; reduced-motion honoured globally; no page transitions, no celebration. |
| `<dialog>` styling may differ subtly across browsers | Visual inconsistency | Styled from existing card tokens; verified in both themes at the two breakpoints. |
| Extracting shared patterns touches working code | Regression risk in the best-tested behaviour | E2/E3/E4 are markup consolidations with no behaviour change; the existing refusal logic and report state machine are not modified. |

### Explicitly out of scope

- Any change to scoring, aggregation, schema, or content.
- The "visually louder" request (audit §6) — a separate pass, to be scoped with its own approval.
- New dependencies. `ARCHITECTURE` §2 pins the dependency set; nothing here needs one.
- Completing `TASK_PLAN` Epic 10 (end-to-end verification). Every task in E10 is unchecked; this plan
  adds UX verification but does not claim to close that Epic.

### Verification method

Browser automation (Playwright MCP, Edge) is configured at user scope but was **not available this
session**, and the `impeccable` plugin installed during this session also loads at session start.
**Both are available from the next session**, which is when implementation and its verification
should run. Verification per change: normal state, loading, success, failure/recovery, empty,
disabled/focus, motion, reduced-motion, and both themes at phone and desktop widths — driven in a
real browser, not inferred from a build passing.
