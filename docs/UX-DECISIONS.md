# UX Decisions — Lexora

Behavioural conventions established by the UX engineering pass of 2026-09-19. Read this before
changing how the application behaves; read `DESIGN.md` before changing how it looks.

Companion documents: `UX-AUDIT.md` (what was wrong and the evidence), `UX-IMPLEMENTATION-PLAN.md`
(the approved plan), `PRODUCT.md` (product truth), `DESIGN.md` (the visual system).

---

## 1. Conventions this pass established

### Every route change is a navigation, not a re-render

`frontend/src/router.tsx` resets scroll on `pushState`/`replaceState`, and `useRouteAnnouncement`
in `frontend/src/App.tsx` sets `document.title` and moves focus to the arriving page's `h1` (or its
`<main>`). **Anything that adds a route must let those two do their job**, and anything that renders
a page must render a `<main>` with an `h1` in it or the announcement silently does nothing — which is
exactly what happened to the staff area until `StaffLayout` was given a real `<main>` landmark.

Two consequences worth knowing:

- **The first render is deliberately skipped.** A page the browser loaded has already announced
  itself, and moving focus on mount would fight a form's own autofocus. Only client-side navigations
  are announced.
- **Focus rings are suppressed on programmatically focused headings**, in `styles.css`. That rule is
  written out longhand rather than as `[tabindex='-1']:focus` so it cannot silence a genuine control
  that a page has taken out of the tab order.

### A refusal is retried only if retrying could change the answer

`useAutosave` reads `ApiError.status` and routes each class of failure rather than retrying them all:

| Status | Meaning | Behaviour |
|---|---|---|
| `409` | Submission already final | Stop. `navigate('/report')` |
| `401` | Session gone | Stop. `navigate('/')` |
| `400` | Payload refused | Stop. Surface immediately |
| `0`, `5xx` | Blip | Retry ×3, 4s apart, then surface |

The retry policy is for failures that might not happen twice. It is not a licence to retry a
decision. **Any new autosave-like caller should follow this table** rather than catching everything
alike — catching everything alike is what told students their connection had failed when their work
was already submitted.

### Async feedback is text, in a live region, with reserved height

There is no spinner anywhere in this application and there should not be one. A control that is
waiting changes its own label ("Submitting…", "Checking…", "Preparing export…"), and a state that
changes on its own is announced through a `role="status" aria-live="polite"` region with a reserved
`min-height` so its appearance never shifts the layout beneath it.

Two rules that came out of getting this wrong:

- **The live region must outlive the thing it describes.** The report's "feedback has arrived"
  announcement sits above the panel it is about, because a region inside the panel was removed at
  the exact moment it had something to say.
- **Do not tick.** A countdown in a live region announces every second. The rate-limit refusal states
  the wait in words ("about 12 minutes") rather than counting down.

### Irreversible actions are confirmed, and the confirmation flushes first

`ConfirmDialog` is the native `<dialog>` with `showModal()`. Native gives focus containment, an
inert background, and Escape for free; a focus-trap dependency would be a new dependency for
behaviour the platform ships. **The cancelling action is first in the DOM** so the default focus is
the safe one.

The assessment flushes its pending autosave *before* opening the dialog, not after. A confirmation
that describes one set of answers while a different set is on the way is worse than no confirmation.

### Motion reports state; it does not decorate

Three duration tokens (`--motion-fast`/`-base`/`-slow`) and **two** easings, in `styles.css`.

The two easings encode a distinction that is easy to lose:

- **`--ease-standard`** is for motion that should read as the interface *responding* — a hover, a
  focus ring, content arriving, a section changing. It is meant to be felt rather than watched.
  **Noticing it during navigation usually means it is too slow**; motion you don't notice is the
  point.
- **`--ease-emphasis`** overshoots slightly. It is for the three moments that are *acknowledgements*
  rather than responses: a section being finished, a save being accepted, writing feedback arriving.
  Those are the interface telling the reader something they did, and **a confirmation nobody notices
  has not confirmed anything.**

Every animation, and which of the two it uses:

| What | Duration | Easing | Why |
|---|---|---|---|
| Completion tick | 300ms | emphasis | An acknowledgement. Was 120ms — over before it registered |
| Save dot appearing | 200ms | emphasis | The "accepted" half of the save pair |
| Section change | 200ms | standard | Continuity, not acknowledgement |
| Writing feedback arriving | 200ms | standard | The panel the page promised, replacing the promise |
| Disclosure chevron | 120ms | standard | A small control responding |
| Chart bar height | 300ms | standard | The filter changed the data |

**The section-change transition is the one that was actually missing.** Switching sections replaced
the card's contents without changing the route, so the only cue was the scroll — and
`scrollIntoView` does nothing at all when the new section's heading is already where the old one was,
which is the common case for two sections of similar length. Two sections swapped under a stationary
viewport with no transition whatsoever. The transition is therefore on the *content*, so it is
visible whether or not there was anywhere to scroll to. It is keyed on the section
(`key={activeSection}`) so the remount is what triggers it.

**Errors deliberately do not animate in.** A failure should be immediately present, not sliding into
view. A single `prefers-reduced-motion` block collapses every animation and transition to nothing,
so an animation added later is covered without opting in.

### Empty, zero, and unknown are three different things

Already true in the data layer and now a rule for states: `—` is not `0`, "None." is not an empty
heading, and a mean of an empty set is undefined rather than zero. A placeholder (skeleton) is
`aria-hidden` with its loading state announced once in words beside it.

### Every failure keeps the way out

Loading and error states render **inside** the shell. A page that drops its own navigation while
loading, or because loading failed, has taken away the only way out at the moment the reader most
needs it. The staff pages all do this correctly now; keep it that way.

### The server's detail is not thrown away

`ApiError` carries `body` and `retryAfterSeconds` alongside the message. When the API says more than
a sentence — `incompleteSections` on a refused submit, `Retry-After` on a `429` — the page reads it.
Read fields defensively; a body from a proxy is not the shape Section 11 promises.

---

## 2. Decisions made during implementation

**Export buffered rather than streamed (approved by the team).** `GET /api/staff/export.csv`
assembles the whole CSV before responding, so it can set a `Content-Length`. A streamed response
cannot, which left the client unable to tell a complete download from one that died half-way — and
`errorHandler` destroyed the connection after a `200` status line, so the staff member saved a
truncated file as if it were the data. This is a **deliberate departure** from Section 2's phrasing
("Streaming CSV export"), documented in the route's own doc comment. The client verifies the byte
count against `Content-Length`, skipping the check when the response is content-encoded.

**Completion ticks built, and `.section-nav .tick` is no longer dead CSS.** The style had existed
since the design system was written with no markup behind it. It now renders from
`assessCompleteness`, and each chip's accessible name carries the state, because a tick is a mark
rather than a word.

**`--card` did not exist.** `.summary-item` set `background: var(--card)`, which was invalid and
rendered transparent. Changed to `--surface-sunken`, the token for a recessed area inside a card.

**`.card--emphasis`, `--radius-lg`, and `App.tsx`'s `NotBuiltYet` were removed.** All three were
unreachable. `DESIGN.md` and `.impeccable/design.json` were updated in the same change, because a
design document describing a component that no longer exists is worse than no document.

**`StaffLayout` renders a real `<main>`.** It was a `<div>`, so the staff pages had no main landmark
and the route announcement queried for an element that did not exist.

**`ThemeToggle`'s label no longer contradicts its `aria-pressed`.** It read "Light mode, pressed"
while the page was dark. The label now names the mode ("Dark mode") and `aria-pressed` carries the
state, so the name is stable and the announcement is true. The icon still previews the action.

**Scope additions confirmed by the team, not by the requirements.** Accessibility and responsiveness
are in scope for this pass **as baseline quality**, not as compliance: the PRD has no `NFR-ACC-*`
family, no WCAG target, and no breakpoint requirement, and `CLAUDE.md` says there is no mobile
target. Recorded in `PRODUCT.md` so future work does not mistake it for a specified standard.

**P2-11 closed: the Likert scale is now five circles, not five labelled pills (2026-09-20).** The
deferred item was *"a touch-friendly affordance for truncated Likert labels — the `title` attribute
is the current mechanism and does nothing on touch."* The fix removes the truncation rather than
adding a way to read through it: the labels are no longer displayed, so there is nothing left to
truncate.

The old row was five full-text pills held on one line by `flex: 1 1 0` and allowed to scroll
horizontally below 26rem — on the device this section is built for it truncated its longest labels,
scrolled sideways under the reader's thumb, and offered a `title` tooltip that never fires on touch.
It is now five bare circles with only the two poles named ("Disagree" / "Agree"), carrying meaning on
two channels that cost no width: **size is intensity** (largest at the poles, smallest at the neutral
centre) and **colour is direction** (the `--sp-scale-*` ramp). Selection is a *fill* rather than a
colour change, so it survives greyscale — colour is never the only signal.

Three things this deliberately preserves, because they are what the refactor could most easily have
broken:

- **The accessible names.** The per-option text moved into a visually-hidden `<span>` inside each
  `<label>`; it was hidden, never removed. A circle has no name of its own, and `title` is not an
  accessible name, so deleting the text would have left all five radios announcing as unlabelled.
  Verified in the accessibility tree: every radio still reports its full label.
- **The data model.** Answers are still `{ statementId: 1–5 }` through the same
  `PATCH /api/student/draft` path. The content schema pins the scale to exactly five points
  (`contentSchemas.ts`), and the reference screenshot's seven circles were **not** copied — this was
  a presentation change only, so no migration and no scoring change.
- **The tap target.** The circles are small by design; the boxes around them are 44×44px, measured.

**A named design rule was bent to do it, with the team's agreement.** The Reserved Hue Rule reserved
`--ai` for Student Problems content *including its scale options*, precisely so the section could not
be mistaken for a result. With the labels gone a single hue cannot express direction across five
points, so the scale now uses a five-step ramp from purple to green. This was put to the user as a
choice, with the rule and its rationale quoted, and they chose the ramp. The deviation is recorded as
an amendment to the rule itself in `DESIGN.md` rather than left as drift between the document and the
code, and it is kept as small as it can be: no new hues (the poles are the existing Derived Violet
and Success values, the middle steps are midpoints through neutral grey) and the ramp is scoped as a
component custom property rather than a palette token. Contrast for every step was measured against
`--paper` rather than eyeballed — the neutral moved from `#9aa3ae` (2.55:1, failing the 3:1 UI
boundary threshold) to `#7d8794` (3.64:1) for that reason alone.

---

## 3. Not done — deliberately

These were in the approved plan and were **not** implemented. They are all internal
consolidations: they reduce duplication and would make future changes cheaper, but they change no
user-visible behaviour, and doing them alongside the behavioural fixes would have added regression
risk to the working parts for no user benefit.

| Pattern | Would have replaced | Status |
|---|---|---|
| `Notice` component | 8 hand-written `.notice` blocks | Not done |
| `PageShell` | 6 repeated student-page openings | Not done |
| `LiveStatus` | 4 separate live regions | Not done |
| `useFormRefusal` | the duplicated form state machine in `EntryPage`/`LoginPage` | Not done |

The behaviour those patterns would have unified **is** in place — implemented directly in each page
rather than through a shared component. Worth doing as a follow-up with the browser available to
verify it.

Also deferred, from the P2 list:

- **A per-question answered/unanswered affordance** in `ChoiceQuestions` (P2-9). Real work, not a
  tweak, and it changes how the assessment reads.

(P2-11, the touch affordance for truncated Likert labels, is no longer deferred — see section 2.)

---

## 4. Verification status — read this before trusting any of the above

**Verified:**

- `npm run typecheck` clean (backend and frontend).
- `npm test` — **498 tests passing, 33 files**, including one added by this pass asserting the
  export's `Content-Length` matches its bytes, using an Arabic student name so the check is
  exercised over genuinely multi-byte content.
- `npm run build` — production build succeeds.
- The production server boots and serves the SPA shell, the hashed CSS and JS assets, and the API
  routes, with `/api/*` not swallowed by the SPA fallback.
- The new components' markup, rendered to static HTML and read: `ConfirmDialog` has both labelled
  actions with the cancelling one first and locks correctly when busy; the skeleton is
  `aria-hidden` with its state announced separately; `ThemeToggle` names the mode and reports
  honestly. That harness was temporary and has been deleted.

**Not verified — needs a browser, and this is the important caveat:**

No screenshot was taken and no page was driven in a real browser. **Every claim below rests on
source inspection and reasoning, not observation:**

- The appearance of any state, in either theme.
- Real keyboard traversal, focus visibility, and screen-reader output.
- Behaviour at each breakpoint, including the new staff-shell rules at ≤40rem.
- The motion layer and `prefers-reduced-motion`.
- The confirmation dialog's native focus containment and Escape handling.
- The `beforeunload` guard's timing.
- Contrast ratios. `--ink-faint` (`#8892a0`) on `--paper` (`#ffffff`) computes to roughly 3.2:1,
  which would fail WCAG AA for body text. **That is arithmetic on token values, not a measurement**,
  and it is used for `muted` metadata rather than body copy. Measure before acting, and note that
  changing it is a *visual* change requiring the team's agreement.

Playwright MCP is configured at user scope and the `impeccable` plugin is installed; both load at
session start, so the next session can verify all of the above. **Do that before treating this pass
as finished.**
