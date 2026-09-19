---
name: Lexora
description: English-language assessment and diagnostic pilot — a calm, credible instrument for one cohort of students and the two staff who run it.
colors:
  ink: "#16191d"
  ink-soft: "#565f6b"
  ink-faint: "#8892a0"
  paper: "#ffffff"
  page: "#f3f5f8"
  surface-sunken: "#eceef2"
  line: "#dde1e7"
  line-soft: "#e9ecf0"
  accent: "#1e5c8c"
  accent-strong: "#134369"
  accent-soft: "#e9f1f8"
  accent-soft-strong: "#d7e6f2"
  success: "#2b7a53"
  success-soft: "#e9f6ee"
  warning: "#8a5a12"
  warning-line: "#e5c98a"
  warning-soft: "#faf1e2"
  danger: "#b3261e"
  danger-soft: "#fbeceb"
  derived: "#6a4f9c"
  derived-soft: "#f1edf8"
typography:
  display:
    fontFamily: "Lora, Georgia, 'Times New Roman', serif"
    fontSize: "1.6rem"
    fontWeight: 600
    lineHeight: 1.25
  headline:
    fontFamily: "Lora, Georgia, 'Times New Roman', serif"
    fontSize: "1.2rem"
    fontWeight: 600
    lineHeight: 1.3
  body:
    fontFamily: "'Public Sans', ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, 'Noto Sans', sans-serif"
    fontSize: "1rem"
    fontWeight: 400
    lineHeight: 1.6
  lede:
    fontFamily: "'Public Sans', ui-sans-serif, system-ui, sans-serif"
    fontSize: "1rem"
    fontWeight: 400
    lineHeight: 1.6
  label:
    fontFamily: "'Public Sans', ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.72rem"
    fontWeight: 600
    letterSpacing: "0.04em"
  arabic:
    fontFamily: "'Noto Naskh Arabic', 'Public Sans', ui-sans-serif, system-ui, sans-serif"
    fontSize: "1rem"
    fontWeight: 400
    lineHeight: 1.6
rounded:
  sm: "6px"
  md: "10px"
  pill: "999px"
spacing:
  xs: "0.35rem"
  sm: "0.6rem"
  md: "1rem"
  lg: "1.5rem"
  xl: "2rem"
  page-bottom: "4rem"
components:
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "#ffffff"
    typography: "{typography.body}"
    rounded: "{rounded.sm}"
    padding: "0.65rem 1.2rem"
  button-primary-hover:
    backgroundColor: "{colors.accent-strong}"
  button-primary-disabled:
    backgroundColor: "{colors.accent}"
    textColor: "#ffffff"
  button-secondary:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.accent}"
    rounded: "{rounded.sm}"
    padding: "0.65rem 1.2rem"
  button-secondary-hover:
    backgroundColor: "{colors.accent-soft}"
  card:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    padding: "1.5rem"
  input:
    backgroundColor: "{colors.page}"
    textColor: "{colors.ink}"
    rounded: "{rounded.sm}"
    padding: "0.65rem 0.8rem"
  nav-item:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink-soft}"
    rounded: "{rounded.sm}"
    padding: "0.55rem 0.7rem"
  nav-item-current:
    backgroundColor: "{colors.accent-soft-strong}"
    textColor: "{colors.accent-strong}"
    rounded: "{rounded.sm}"
    padding: "0.55rem 0.7rem"
  chip:
    backgroundColor: "{colors.page}"
    textColor: "{colors.ink-soft}"
    rounded: "{rounded.pill}"
    padding: "0.45rem 0.9rem"
  chip-current:
    backgroundColor: "{colors.accent}"
    textColor: "#ffffff"
    rounded: "{rounded.pill}"
    padding: "0.45rem 0.9rem"
  submission-card:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    padding: "1.1rem 1.25rem"
---

# Design System: Lexora

## Overview

**Creative North Star: "The Quiet Examination Hall"**

Lexora is an instrument, not a destination. A student arrives once, under some pressure, to do
something they cannot redo, and the interface's job is to get out of the way. That is why the
surface is cool and near-monochrome, why there is exactly one accent hue, and why nothing on the
student's path moves unless it is reporting a state change. The restraint is not timidity — it is
the design. A screen that competes for attention is a screen that costs a student attention they
need for the questions.

The second influence is documentary rather than commercial. Headings are set in a serif (Lora) while
everything functional is set in Public Sans, so a screen reads as a university document rather than
a web app — the same instinct that puts the report's band descriptions in prose rather than a chart.
The palette is a cool blue-grey built from a paper-and-ink pair, with a single desaturated navy
(`#1e5c8c`) carrying every interactive and emphasis role.

Depth is communicated by tone and hairline borders, not by shadow. Surfaces are a three-step ladder —
page (`#f3f5f8`) → paper (`#ffffff`) → sunken (`#eceef2`) — and a card is legible because it is
lighter than what it sits on, not because it floats. There is one shadow token in the whole system,
and it is reserved for surfaces that genuinely overlap other content.

One colour is reserved. `--ai` (a muted purple, `#6a4f9c`) appears **only** on non-scoring,
AI-derived, or research-only content, never on anything that contributes to an English score. Its
rarity is what makes it a signal.

> **Note for future work.** The team has asked (2026-09-19) for a slightly bolder visual expression —
> "a little louder, without it turning into chaos." That is tracked as a separate `bolder` pass, not
> yet applied. Until it lands, this file records the incumbent system and the restraint above is
> still the authority. Anything that changes it should change this file in the same commit.

**Key Characteristics:**

- Calm, credible, unhurried; the interface recedes behind the task.
- One accent hue; colour is functional and rare, never decorative.
- Serif headings over a sans body — documentary, not commercial.
- Tonal layering and hairline borders instead of shadow and elevation.
- A single reserved hue for non-scoring and AI-derived content.
- Motion is reserved for state change; the system currently has almost none.

## Colors

A cool blue-grey neutral ladder carrying one desaturated navy accent, plus four reserved semantic
hues that each mean exactly one thing.

### Primary

- **Examination Navy** (`#1e5c8c`): the only interactive colour. Every primary button, every link,
  every selected chip, every focus ring, and the fill of every bar in every chart. Hover deepens it
  to **Deep Examination Navy** (`#134369`). It is deliberately desaturated — a brighter blue would
  read as a consumer product.
- **Navy Wash** (`#e9f1f8`) / **Navy Wash Strong** (`#d7e6f2`): the accent's tint pair. Wash is a
  hover background and a selected-option background; Wash Strong is the selected sidebar item and a
  chip border. Neither is ever used as a text colour — the text on both is `--accent-strong` or
  `--ink`.

### Secondary

- **Retention Green** (`#2b7a53`) on **Green Wash** (`#e9f6ee`): used for exactly two things — a
  "Submitted" status pill, and the confirmation that a save was accepted (`.save-status--saved`,
  and its `●` marker). It never appears on a score.
- **Review Amber** (`#8a5a12`) on **Amber Wash** (`#faf1e2`) with border **Amber Rule** (`#e5c98a`):
  the neutral notice treatment (`.notice`), for information that is neither success nor failure.

### Tertiary

- **Defect Red** (`#b3261e`) on **Red Wash** (`#fbeceb`): errors, invalid fields, "Incorrect"
  verdicts, and the one KPI card that must not blend in (`--attention`). A notice promoted to
  `role="alert"` takes this pair instead of the amber one.

### Neutral

- **Ink** (`#16191d`): all primary text. Near-black with a trace of blue, never pure black.
- **Soft Ink** (`#565f6b`): secondary text — ledes, hints, metric labels, explanatory prose.
- **Faint Ink** (`#8892a0`): tertiary text — captions, "None.", timestamps, muted metadata.
- **Paper** (`#ffffff`): the card surface. The lightest step; a card is always the lightest thing
  in its own region.
- **Page** (`#f3f5f8`): the body background and the input background at rest.
- **Sunken** (`#eceef2`): recessed surfaces — passages, writing prompts, chart tracks, bar tracks.
  Also the "In progress" status pill.
- **Rule** (`#dde1e7`) / **Soft Rule** (`#e9ecf0`): borders. `--line` outlines a card or control;
  `--line-soft` is the internal divider between list rows and report items.
- **Derived Violet** (`#6a4f9c`) on **Violet Wash** (`#f1edf8`): reserved. See the rule below.

Dark mode is a full parallel ramp defined twice — once under `@media (prefers-color-scheme: dark)`
guarded by `:root:not([data-theme='light'])`, and once under `:root[data-theme='dark']`. The
explicit toggle always wins over the OS preference. In dark mode Paper becomes `#1b1f26` and Page
`#14171c`, so the ladder inverts: cards stay *lighter* than the page, and the accent lightens to
`#6fa8d8` to hold contrast against a dark ground.

### Named Rules

**The Reserved Hue Rule.** `--ai` / `--ai-soft` mark content that is AI-derived, non-scoring, or
research-only, and nothing else, ever. It currently appears on the Student Problems banner, the
Student Problems scale options, the "Derived data" blocks, and the dashboard's Student Problems
panel. If it ever appears beside a number that counts toward an English score, that is a bug — the
hue exists so a student can tell "this is not a result" without reading.

**The One Accent Rule.** There is one interactive hue. New features do not get their own colour;
they get the accent, or a reserved semantic hue, or ink. The palette has no room for a fifth
expressive colour and does not want one.

**The Never-For-A-Score Rule.** Green and red carry *status* (submitted, saved, incorrect) and never
carry *magnitude*. No score, mean, band, or bar is coloured by how good or bad it is — the sole
exception is the weakest-topics severity ramp, which is a deliberate four-step scale (`.sev-1`
through `.sev-4`) and is labelled as such in CSS.

## Typography

**Display Font:** Lora (with Georgia, 'Times New Roman', serif)
**Body Font:** Public Sans (with ui-sans-serif, system-ui, and the platform sans stack)
**Arabic Font:** Noto Naskh Arabic (with Public Sans as fallback)

**Character:** A documentary pairing — a transitional serif for headings, a neutral grotesque for
everything you have to read or operate. Lora gives a screen the gravity of a printed document
without ornament; Public Sans is deliberately anonymous so the questions, options, and numbers carry
no personality of their own. All three families are loaded from Google Fonts in `frontend/index.html`
with weights 400/500/600/700 (Public Sans), 500/600 (Lora), and 400/600 (Noto Naskh Arabic).

### Hierarchy

- **Display** (600, 1.6rem, 1.25): the `h1` of a screen. Lora. One per page.
- **Headline** (600, 1.2rem, 1.3): `h2` — section headings inside a card. Lora. The staff topbar
  uses the same family at 1.3rem.
- **Title** (600, 1rem): `h3` — sub-headings within a card, and the four block headings inside the
  writing feedback. **Switches back to Public Sans**, deliberately: below `h2` the text is
  functional, not editorial.
- **Body** (400, 1rem, 1.6): all prose and all form text. `body` is set at exactly 16px with no
  scaling, so nothing shrinks below a readable size on a phone.
- **Lede** (400, 1rem, 1.6, Soft Ink): the one-sentence orientation at the top of a card.
- **Hint** (400, 0.9rem, Soft Ink) and **Muted** (400, 0.85rem, Faint Ink): two steps of de-emphasis
  with a real distinction — `hint` is guidance the reader may need, `muted` is metadata they usually
  will not.
- **Label** (600, 0.72rem, 0.04em, uppercase): the summary-strip labels, the "Derived data" tag, the
  scale category headings, and the correct/incorrect verdicts. The only uppercase in the system.
- **Score** (600, 0.9rem, tabular figures, Soft Ink, `white-space: nowrap`): every `n / max` figure.
  `font-variant-numeric: tabular-nums` is used on every number that sits in a column or a chart, so
  digits align and a value never jitters as it changes.

### Named Rules

**The Two Families, Three Jobs Rule.** Lora is for `h1` and `h2` only. Public Sans is for everything
else, including `h3`. If a third family is ever proposed, the answer is no.

**The Tabular Rule.** Any number that appears in a column, a chart label, a metric row, or a bar is
set with `font-variant-numeric: tabular-nums`. Numbers that do not align are numbers that cannot be
compared.

**The Arabic Is Not A Fallback Rule.** `[dir='rtl']` switches the typeface to Noto Naskh Arabic and
flips the alignment and border side of blockquotes. Naskh is the correct face for Arabic prose, not
a substitute for a missing glyph — do not let Public Sans render Arabic body text.

## Layout

A single centred column of stacked cards, on a grey page, with generous vertical rhythm.

- **Page column.** `.page` is `max-width: 42rem` (672px) with `2rem 1.25rem 4rem` padding — the
  reading width for forms and prose. `.page--wide` is `62rem` (992px), used by the assessment and
  the student report, which carry grids and long lists. `.page--toggle` adds `3.4rem` of top padding
  to reserve room for the floating theme toggle.
- **Card stack.** `.card` is `1.5rem` padding, `1px solid var(--line)`, `--radius-md`. Vertical
  rhythm between cards is `--gap` (1rem), applied by `.card + .card` rather than by the page — so a
  card is self-contained and the gap is a property of the stack, not the container.
- **Staff shell.** A two-column flex shell: a `15.5rem` sidebar (`position: sticky; height: 100vh`)
  and a flexible main column with its own sticky topbar and `1.75rem 2rem 4rem` content padding.
- **Dashboard grids.** Four-up KPI strip (`repeat(4, 1fr)`), auto-filling submission grid
  (`minmax(15.5rem, 1fr)`), and three-column bar rows (`6.5rem 1fr 3rem` for distributions,
  `11rem 1fr 3rem` for ranked topics, `9rem 1fr 3rem` for writing criteria).
- **Responsive.** The existing breakpoints are `480px`, `26rem` (416px), `30rem` (480px), and
  `40rem` (640px) — applied to the summary strip (4→2 columns), the scale options (equal-share →
  fixed-width, horizontally scrollable), the KPI row (4→2), and the ranked/criteria rows
  (three-column → stacked). Two of these are the same width spelled two ways.

**Known gap, recorded not fixed:** the staff shell has **no responsive rules at all**. At 375px the
`15.5rem` sidebar consumes two-thirds of the viewport and the three-column data grids overflow. This
is tracked in the UX implementation plan; no breakpoint requirement exists in the PRD.

## Elevation & Depth

Tonal, not lifted. This system conveys depth by surface lightness and hairline borders, and treats
shadow as an exception rather than a default. There is exactly one shadow token.

The ladder runs **Sunken** (`#eceef2`) → **Page** (`#f3f5f8`) → **Paper** (`#ffffff`). Recessed
content (a reading passage, a writing prompt, a chart track) sits at the bottom of the ladder;
the page is the middle; cards are the top. Because a card is always the lightest surface in its
region, it separates from the page without a shadow, and this survives dark mode where the same
relationship is preserved with inverted values.

### Shadow Vocabulary

- **`--shadow-raised`** (`0 1px 2px rgba(15, 23, 32, 0.04), 0 4px 14px rgba(15, 23, 32, 0.06)`): the
  only shadow in the system. Three uses, all of which genuinely overlap other content: the floating
  theme toggle (pinned over a card), the confirmation dialog (a modal in the top layer), and a
  submission card on hover/focus.

### Named Rules

**The Flat-By-Default Rule.** Surfaces are flat at rest. A shadow appears only where content
actually floats above other content, or as a response to pointer/focus state. A new shadow token is
a design decision, not a styling convenience.

**The Ladder Rule.** Never place a darker surface on top of a lighter one. Paper on page, sunken
inside paper. Inverting the ladder is the fastest way to make this system look broken, in either
theme.

## Shapes

Gently curved, restrained, and consistent. Radii are two steps plus a pill: **`--radius-sm` (6px)**
for controls (buttons, inputs, options, nav items), **`--radius-md` (10px)** for containers (cards,
notices, passages, panels, submission cards, the confirmation dialog), and **`--radius-pill`
(999px)** for anything that reads as a tag or a toggle — status pills, chips, band pills, verdicts,
language toggle, theme toggle, and every progress track.

There was a fourth step, `--radius-lg` (14px), for a single `.card--emphasis` surface that no
component ever rendered. Both were removed together rather than left as a radius nothing can reach.

Borders are always `1px` and always a neutral from the rule pair — never a colour, except where a
semantic state is being stated (an invalid field, an alert notice, a derived-data block). The
default control border is `--line`; the default internal divider is `--line-soft`.

One asymmetry exists deliberately: blockquotes and the RTL variant of them use a `3px` inline-start
border as a quote mark, flipped to the right under `[dir='rtl']`.

## Components

### Buttons

Restrained and confident, with no elevation and no transform on press.
- **Shape:** `--radius-sm` (6px), `1px` border, `0.65rem 1.2rem` padding.
- **Primary:** Navy fill, white text, weight 600. Hover deepens to `--accent-strong` over `120ms`.
- **Focus:** the global `:focus-visible` ring — `3px solid var(--accent)`, `2px` offset — is never
  removed from a button.
- **Disabled:** `opacity: 0.5` with `cursor: not-allowed`. There is no separate disabled palette.
- **Secondary:** Paper background, navy text, `--line` border; hover fills with `--accent-soft` and
  the border strengthens to `--accent-soft-strong`. Used for "Previous section", "Next section",
  "Show normalized text".
- **In-flight:** a button that is waiting replaces its label rather than adding a spinner —
  "Checking…", "Signing in…", "Submitting…", "Preparing export…". The label *is* the feedback.

### Chips

The section navigation and the assessment's band/status pills share a pill geometry.
- **Style:** `.section-nav button` — `--page` fill, `--ink-soft` text, `--line` border, pill radius.
  The selected chip inverts: navy fill, white text, navy border.
- **State:** selection is expressed with `aria-current="true"` (nav) or `aria-pressed` (the EN/AR
  toggle), and the CSS keys off that attribute — so the visual state and the accessible state cannot
  drift apart.
- **Status pills** (`.submission-status`, `.verdict`, `.band-pill`, `.derived-tag`) reuse the pill
  radius with a semantic wash fill and a matching text colour at 0.72–0.78rem.

### Cards / Containers

- **Corner Style:** `--radius-md` (10px).
- **Background:** Paper, always. Nested recessed content uses Sunken instead.
- **Shadow Strategy:** none. See Elevation — a card separates by lightness and a `1px --line` border.
- **Border:** `1px solid var(--line)`. Internal dividers are `1px solid var(--line-soft)`.
- **Internal Padding:** `1.5rem`.
- **Notices** are cards with a semantic wash fill and matching border: amber by default, red when
  `role="alert"`, navy-tinted when `.notice--privacy`.
- **Derived-data blocks** (`.derived`) are the one place a card takes a saturated border and a wash
  fill, in the reserved violet. This is intentional and is the Reserved Hue Rule in practice.

### Inputs / Fields

- **Style:** `--page` background, `1px solid var(--line)`, `--radius-sm`, `0.65rem 0.8rem` padding.
  Textareas are `min-height: 11rem` with `resize: vertical`. The Student Problems free-text field
  uses `dir="auto"`.
- **Focus:** the outline is removed and replaced by a three-part treatment — border to `--accent`,
  background lifts to Paper, and a `0 0 0 3px var(--accent-soft)` ring. All three over `120ms`.
- **Error:** `.field--invalid` turns the border red; the message renders below in `--danger` at
  0.87rem and is wired to the field with `aria-describedby` + `aria-invalid`. The message replaces
  the hint rather than stacking with it.
- **Select:** matches the input treatment, `min-width: 12rem`.

### Navigation

Two distinct nav systems, deliberately different.
- **Staff sidebar** (`.staff-nav-item`): full-width rows, `--radius-sm`, `--ink-soft` text at 0.92rem
  with a 1.05rem Lucide icon, `0.55rem 0.7rem` padding. Hover fills with `--surface-sunken`; the
  current item takes `--accent-soft-strong` with `--accent-strong` text at weight 600, driven by
  `aria-current="true"`. A `Lexora` wordmark sits above, a footer line below.
- **Section chips** (`.section-nav`): a wrapping row of pill buttons inside a card, one per
  assessment section, labelled from the content bundle. Hover tints; the current one inverts to navy.
- **Disclosures:** `details`/`summary` with the webkit marker suppressed and a `▸`/`▾` glyph supplied
  in CSS as `::before`, flipping on `[open]`. Used for question-by-question detail, the score
  distribution, and the full statement list.

### Signature Component: the Save Status Indicator

The one component that exists purely to communicate system state, and the model for how this system
does async feedback. `.save-status` is a `role="status" aria-live="polite"` line that reserves
`min-height: 1.4em` so its appearance never shifts the layout beneath it.

It has four states and no spinner: blank when idle, "Saving…" in Soft Ink while in flight, "Saved"
in Retention Green preceded by a `●` glyph, and — on failure — a full sentence in Defect Red at
weight 600: *"We could not save your last changes — check your connection. Your earlier answers are
safe."* The failure state explains what happened **and** what is still true, in one line, without a
retry button the student would have to find.

### Signature Component: the Comparison Chart

`FR-STAFF-006` asks for four differently-scored sections on one axis. It is drawn by hand rather
than by a charting library (the architecture pins none) — a `flex` row of `11rem`-tall columns, each
a grey track with a navy fill whose `height` is `meanPercent`, animated over `300ms`. The label sits
*above* the bar by default and moves *inside* it above 90%, because `SectionComparisonChart`
computes that an 11% bar cannot fit a label above it and CSS cannot ask whether a box's contents fit.
The `n scored` caption sits under each column so nobody reads a two-response mean with the
confidence of a forty-response one.

## Do's and Don'ts

Grounded in the implemented system and in the team's confirmed decisions of 2026-09-19.

### Do:

- **Do** keep one interactive hue. New controls take `--accent`, a reserved semantic hue, or ink.
- **Do** use the surface ladder — Sunken → Page → Paper — to separate regions, and reach for
  `--shadow-raised` only when content genuinely overlaps other content.
- **Do** set every comparable number in `font-variant-numeric: tabular-nums`.
- **Do** express selection through `aria-current` / `aria-pressed` and style from that attribute, so
  the visual and accessible states cannot diverge.
- **Do** reserve `--ai` / `--ai-soft` for AI-derived, non-scoring, and research-only content.
- **Do** say "None." rather than rendering an empty heading — an absent list must be distinguishable
  from a list that failed to load.
- **Do** let a button's label carry its in-flight state ("Submitting…") instead of adding a spinner.
- **Do** label anything the model produced as derived, in a visually distinct container, not merely
  with a caption a reader can skim past.

### Don't:

- **Don't** make the product competitive. No leaderboards, no ranking of students against each other,
  no streaks, no badges, no comparative language. The weakest-topics panel ranks *topics*, and that
  is the only ranking in the product.
- **Don't** imply a result that has not been computed. No placeholder score, no `0` where a value is
  missing (a `—` is not a zero), no mean of an empty set.
- **Don't** present AI-derived categories, normalised text, or interpretations as the student's own
  words, or as diagnostic — `FR-PROB-006` and `FR-PROB-011` forbid both.
- **Don't** add a charting or component library. Charts are hand-drawn from tokens; that is the
  established idiom and the architecture pins no such dependency.
- **Don't** put `h3` in Lora — the serif is for `h1` and `h2` only.
- **Don't** introduce a new radius, a new shadow, or a fourth surface step without changing this file.
- **Don't** change the analysis, the aggregation rules, or the scoring to serve a visual idea. The
  dashboard may present differently; it may not compute differently.
