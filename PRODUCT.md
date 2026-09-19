# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

**Primary: the assessed student.** A university student in a pilot cohort, sitting a five-section
English assessment once. They have no account and no password — they identify themselves with a
cohort code, their university roll number, and their name (FR-STU-002/004). They are very often on a
phone, and a meaningful share of them read Arabic as their first language. They are not using this
product by choice and they cannot retake it; the submission is final and irreversible.

**Secondary: two staff members.** They run the pilot. They log in with email and password, read the
dashboard to understand how the cohort performed, open individual submissions, and export CSV for
analysis in their own tools. They are not analysts and the product is not their analysis tool.

## Product Purpose

Deliver one English-language assessment to a small cohort, score it, and give both the student and
the pilot staff a usable result — with no accounts, no proctoring, and no time limit.

Success for the student is understanding what their English looks like right now and what to work
on. Success for staff is knowing where the cohort is weak well enough to make curriculum decisions.

## Positioning

The assessment is split by what can be known immediately and what cannot, and the product is honest
about the difference. Grammar, Vocabulary, and Reading are scored deterministically at submission
and shown at once. Free-writing feedback is produced by an LLM in the background and may not exist
yet — and the report says so in words rather than showing a plausible-looking blank. A student never
waits on a model to see most of their result, and is never shown a score that has not been computed.

The second mechanism is that Student Problems — a non-scoring instrument about study difficulties —
shares the same submission but is structurally prevented from touching any English score, and is
never shown to the student at all.

## Operating Context

- One pilot cohort, low tens of students. The staff-facing numbers are therefore small, and the
  product says so rather than presenting a two-response mean with the confidence of forty.
- The student sits the assessment in one or more sittings, on any device, with no time limit. They
  may leave and return; the draft is autosaved per section and resumes.
- The student typing Arabic into the open-ended Student Problems field is a first-class case, not an
  edge case — the field follows the direction of what is typed, and the instrument's statements are
  switchable between Arabic and English display.
- Content is versioned. A submission is scored against the content version frozen when its draft was
  created, so an older submission stays interpretable after the question set changes.
- Deployment is a single small web service that idles; the first visitor after a pause may wait for
  it to wake.

## Capabilities and Constraints

**Confirmed capabilities.** Identity verification without accounts; section-scoped draft autosave;
immutable submission; deterministic scoring with per-question explanations and per-section band
descriptions; background LLM evaluation of writing (five rubric criteria, bands, corrections,
strengths, weaknesses, suggestions) and of the Student Problems open text; a staff dashboard with
cohort filtering, score distributions, weakest topics, writing criteria, and Student Problems
aggregates; per-submission staff detail; CSV export.

**Confirmed constraints.**

- No accounts, no student login, no retake, no time limit, no proctoring (PRD Section 5).
- Immutability after submission is server-enforced; the browser is never trusted.
- There is deliberately no ID-bearing student report route. A student session names exactly one
  submission; a submission is never addressable by URL.
- Student Problems data never affects any English score, and no student-facing difficulties report
  exists in the MVP.
- One staff permission level. No roles beyond "staff".
- The dashboard is deliberately not a business-intelligence platform (FR-STAFF-012): no drill-down,
  no sorting, no paging, no charting library. Its job is to be readable, not deep.
- AI output is validated against a schema before the domain layer accepts it, and the provider
  returns criterion judgments rather than a score — the score is computed by the application.

**Explicitly undecided** (PRD Section 23.1 — build against the structure, never invent the value):
rubric weights, final question content, and several pieces of student-facing wording including the
"still being prepared" message, the privacy notice, and processing-status labels. Staleness handling
for long-running evaluations (EDGE-005) and performance targets (NFR-GEN-006) are also open.

## Brand Commitments

The name is **Lexora**. There is no logo asset, no brand guideline document, and no voice guide in
the repository — the visual and verbal identity currently exists only as implemented code
(`frontend/src/styles.css`) and as copy written into the components. Both are the incumbent
authority until something supersedes them.

## Evidence on Hand

- `docs/English_Assessment_Pilot_PRD_v1.1.md` — product requirements, the source of record.
- `docs/ARCHITECTURE_v1.1.md` — technical decisions, schema, API contracts, canonical locations.
- `docs/TASK_PLAN_v1.1.md` — implementation order and completion state (T1–T8 complete; E9 has one
  open task; **all of E10, end-to-end verification, is unchecked**).
- `content/versions/v1` and `content/versions/v2` — the real content bundles. v2 is current.
- No testimonials, no case studies, no press, no benchmarks, and no user research exist. **None may
  be fabricated.** There are no real screenshots and no design reference file: several components
  cite a `LEXORA_Preliminary_UI_UX_Spec_v1.0.md` that is **not present in the repository**, so those
  citations cannot currently be verified against their source.

## Product Principles

1. **Never claim more than is known.** Immediate results are shown immediately; anything still being
   computed is named as such. A failure is stated as a failure and never left as an indefinite
   "in progress", and never dressed up as success.
2. **The student's work is never lost and never silently changed.** Autosave is section-scoped and
   retried; a failed evaluation preserves the original response untouched; a submission is immutable.
3. **Consequential actions are legible before they happen.** Submitting is final, so the student is
   told exactly that, in advance, and told what is still unfinished if they cannot proceed yet.
4. **Refusals explain the next step, and reveal nothing they should not.** A refusal the user can fix
   is specific; a refusal that would help someone guess another student's identity is generic.
5. **Student Problems is research, and must never look like a result.** It is visually distinct,
   explicitly disclaimed, and structurally isolated from scoring.

## Accessibility & Inclusion

No accessibility requirement exists in the PRD, the Architecture, or the Task plan — there is no
`NFR-ACC-*` family, no WCAG target, and no accessibility task or verification checkbox anywhere. The
same is true of responsiveness: there is no viewport or breakpoint requirement, and `CLAUDE.md`
states there is no mobile target.

Two product facts nonetheless make both material, and the team confirmed on 2026-09-19 that both are
in scope for the current UX pass:

- The pilot cohort reads Arabic as a first language; the Student Problems instrument already ships
  an EN/AR display toggle and an RTL text field. RTL is a supported state, not a nicety.
- The assessment is sat on whatever device the student has, and is not proctored or desktop-bound.

This is recorded as a **team decision, not a PRD requirement**. Anything built against it should be
described as baseline quality rather than compliance with a specified standard.
