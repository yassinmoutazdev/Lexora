# Product Requirements Document
## English-Language Assessment & Diagnostic Pilot Application

**Version:** 1.1
**Status:** Draft for review — updated per product-decision review
**Document type:** Product Requirements Document (PRD) — not an architecture document or implementation plan

---

## 1. Document Overview

This PRD defines the product requirements for a new web application that assesses the written English ability of a small cohort of university students, gives them immediate feedback, and collects structured data about the difficulties they face when learning and using English. The findings are intended to help an internal team design a more suitable English curriculum.

This document was produced from a single source conversation describing product decisions for this pilot. An earlier, unrelated PRD ("Praxis," a personal AI English-coaching desktop app) was supplied only as a structural and formatting reference. No scope, assumptions, architecture, or design decisions from that document have been carried into this one unless explicitly restated here.

Where a decision was not made in the source conversation, this document marks it as **TBD**, **Open implementation decision**, or **Assumption requiring validation** rather than resolving it silently.

---

## 2. Product Vision

A focused, low-friction web application that lets a cohort of university students complete a single written English assessment — grammar, vocabulary, reading, writing, and a self-report of learning difficulties — and receive immediate, useful feedback, while giving the internal team a reliable, exportable picture of the group's strengths, weaknesses, and learning obstacles to inform curriculum design.

The MVP is intentionally narrow. It is not a learning platform, not a community tool, not a teacher classroom manager, and not an adaptive testing engine.

---

## 3. Problem Statement

The internal team currently lacks a structured, consistent way to:

- Measure the written English ability of pilot students across comparable dimensions (grammar, vocabulary, reading, writing).
- Capture, in a structured and analyzable form, the specific difficulties students report with learning or using English.
- Aggregate this information across a cohort to identify patterns that should inform curriculum design.

Without this, curriculum decisions would rely on informal impressions rather than structured diagnostic data.

---

## 4. Goals

- **G1.** Assess each pilot student's grammar, vocabulary, reading, and writing ability using a uniform assessment.
- **G2.** Give each student immediate, useful feedback on their performance.
- **G3.** Collect structured, five-point-scale data on common English-learning difficulties, plus an open-ended response for difficulties not anticipated by the predefined statements.
- **G4.** Give the internal team a simple dashboard to understand patterns across the pilot group.
- **G5.** Produce exportable data the team can analyze further outside the application (e.g., Excel, Python).
- **G6.** Keep the MVP scope tight enough to ship for a small pilot while remaining structurally extensible later.

---

## 5. Non-Goals (MVP)

The following are explicitly outside the MVP. They may be considered for future phases but must not expand MVP scope:

- Student accounts or passwords.
- Public student self-registration.
- Complex staff roles or permission tiers.
- Speaking recording or automated speaking evaluation (speaking is assessed by the project organizer outside the application).
- Listening assessment (deferred).
- Automated pronunciation scoring.
- Full learning-management system functionality.
- Community features.
- A WhatsApp-replacement communication tool.
- Teacher classroom management tooling.
- Adaptive testing (difficulty does not adjust based on performance).
- A full question-management dashboard/CMS.
- Complex reporting/business-intelligence platform.
- Personalized learning paths.
- A complete AI English coach.
- Strict anti-cheating mechanisms (e.g., proctoring, lockdown browsers, time limits).
- Controlled writing / sentence-level correction tasks (e.g., correcting, constructing, or rewriting sentences) within the Writing section. Grammar, Vocabulary, and Reading provide the structured evidence needed to estimate general English level; the Writing section is open-ended free writing only.

---

## 6. Target Users and User Roles

### 6.1 Students (primary users, no account)
University students in the pilot cohort. They access the assessment using a cohort access code plus identifying information — no student account or password is created.

### 6.2 Staff (internal team)
Currently two staff members, both with identical permissions. Staff accounts are created manually by the team; there is no public staff registration. Staff use email/password login and operate in a separate, non-public area of the application.

No further role differentiation (e.g., admin vs. reviewer) is defined for the MVP. Inventing additional role granularity is explicitly discouraged by the source requirements.

---

## 7. MVP Scope

### In scope
- Student cohort-code-based assessment access (no account).
- Single-attempt, five-section uniform assessment (Grammar, Vocabulary, Reading, Writing, Student Problems).
- Deterministic scoring and prewritten explanations for Grammar/Vocabulary/Reading — the main structured evidence used to estimate general English level.
- One open-ended free-writing task evaluated via LLM against a fixed, approved rubric, with the application (not the LLM) calculating the final score deterministically.
- Immediate deterministic results with background processing for the writing evaluation; the full report is not always complete the instant the student submits.
- Return-and-view of a saved report; no retakes.
- Staff login and a limited internal dashboard for viewing submissions, aggregate analysis, and CSV export.
- Data security and access separation between students and staff.

### Out of scope
See Section 5 (Non-Goals) and Section 16 (Product Boundaries).

---

## 8. User Journeys

### 8.1 Student journey — first visit
1. Student opens the main assessment page (student-first design, with a small **Staff login** link nearby).
2. Student enters the cohort access code.
3. Student enters their university roll number.
4. Student enters their name.
5. System checks for an existing submission for that cohort + roll number.
6. No existing submission found → student begins the assessment.
7. Student completes Grammar, Vocabulary, Reading, Writing (one open-ended free-writing task), and Student Problems sections. Backward navigation and review of previous questions is allowed while the assessment remains a draft. Progress is saved temporarily/autosaved, and the draft remains editable until final submission.
8. Student submits. This is the point the submission becomes immutable — the student can no longer edit, restart, or retake for the same cohort + roll number. Deterministic sections (Grammar, Vocabulary, Reading) are scored immediately; free-writing evaluation begins processing in the background.
9. Student sees the report page immediately, with deterministic results shown and a "Writing feedback is still being prepared" status if the LLM evaluation has not yet completed. The report is not necessarily complete at this point — writing feedback is added to the same saved report once processing finishes.

### 8.2 Student journey — return visit
1. Student opens the main page and enters cohort code, roll number, and name.
2. System detects an existing submission.
3. System shows the saved report and current processing status (never a new assessment).
4. Student cannot edit, restart, or resubmit.

### 8.3 Staff journey
1. Staff opens the Staff login (email + password).
2. Staff views a dashboard: submission counts, completion status, score distributions, Student Problems patterns, cohort filters.
3. Staff can open an individual submission when authorized.
4. Staff can export cohort or full data as CSV (or similarly practical format).

---

## 9. Functional Requirements

### 9.1 Student access & identity
- **FR-STU-001.** The system must allow a student to access the assessment using a cohort/group access code.
- **FR-STU-002.** The system must collect university roll number and name as part of the entry flow.
- **FR-STU-003.** The university roll number, scoped within a cohort, is the primary identity separator; name is supporting identity information.
- **FR-STU-004.** The system must not require creation of a student account or password.
- **FR-STU-005.** The system must check, before starting a new assessment, whether a submission already exists for the given cohort + roll number combination.
- **FR-STU-006.** If a submission exists, the system must show the saved report and its processing status instead of allowing a new attempt.
- **FR-STU-007.** The system must prevent more than one submission per cohort + roll number combination.
- **FR-STU-008.** The student-facing entry page must be designed primarily for students, with a small, clearly labeled Staff login link.

### 9.2 Assessment taking

**Draft vs. submitted.** Before final submission, the student's work is a **draft**: it may be temporarily saved/autosaved, is editable, and the student may leave and return to continue the same in-progress assessment. After final submission, the assessment becomes an **immutable submitted report**: it cannot be edited, restarted, or retaken for the same cohort + university roll number, and a returning student can only view the saved report and its processing status (see Section 13).

- **FR-ASSESS-001.** The assessment must present the same overall structure to every student (uniform, non-adaptive), with difficulty levels (Basic, Intermediate, Upper-intermediate) represented within relevant sections.
- **FR-ASSESS-002.** The system must present five sections: Grammar, Vocabulary, Reading, Writing, and Student Problems.
- **FR-ASSESS-003.** Question order must be fixed for all students (no randomization) in the MVP.
- **FR-ASSESS-004.** Students must be able to move backward and review previously answered questions before final submission.
- **FR-ASSESS-005.** The system must not impose a time limit.
- **FR-ASSESS-006.** While in draft state, the system must save progress temporarily (e.g., autosave) to reduce risk of lost work, and must allow the student to leave and return to continue the same draft. The exact persistence mechanism is an *architecture-phase decision* (see Section 19 and Section 23).
- **FR-ASSESS-007.** All required sections must be completed before final submission; the open-ended Student Problems response may remain optional.
- **FR-ASSESS-008.** Final submission is the transition from draft to submitted: once submitted, the assessment is immutable — no edits, no restarts, no retakes for the same cohort + university roll number. A returning student sees only the saved report and its processing status (see FR-STU-006).

### 9.3 Deterministic scoring (Grammar, Vocabulary, Reading)

Grammar, Vocabulary, and Reading are the main structured, deterministic sections used to estimate the student's general English level; they provide the structured evidence that removes the need for a complex controlled-writing correction system.

- **FR-DET-001.** Each question must support correct/incorrect evaluation without requiring an LLM.
- **FR-DET-002.** Each question must support metadata: section, skill/topic label, difficulty level, question type, correct answer (where applicable), prewritten explanation/feedback, and scoring information.
- **FR-DET-003.** The system must compute and display section-level scores immediately upon submission.
- **FR-DET-004.** The system must display the prewritten explanation for each question according to the student's given answer.

### 9.4 Writing section
- **FR-WRITE-001.** The Writing section consists of **one open-ended free-writing task only**. Controlled writing/language-use tasks (e.g., correcting, constructing, rewriting sentences) are **not** part of MVP scope — Grammar, Vocabulary, and Reading already provide the structured evidence needed to estimate general English level, so a controlled-writing correction system is not required.
- **FR-WRITE-002.** The Writing section must include one open-ended free-writing task.
- **FR-WRITE-003.** The free-writing response must be evaluated using an LLM (implementation likely Ollama-based; exact model/pipeline is an *architecture-phase decision*).
- **FR-WRITE-004.** The LLM must be given a predefined, explicit rubric and evaluation instructions before assessing a response; the rubric is not to be improvised by the model.
- **FR-WRITE-005.** The LLM must return criterion-level evaluations with supporting evidence/rationale where practical, not an arbitrary single overall number.
- **FR-WRITE-006.** The application (not the model) must calculate the final overall score using a fixed, deterministic formula applied to the criterion-level results. Writing evaluation must not be described or implemented as deterministic question correction — it is rubric-based LLM evaluation with a deterministic scoring formula layered on top.
- **FR-WRITE-007.** The free-writing evaluation output must include: criterion-level scores, a system-calculated overall score, concise educational feedback, key strengths, important weaknesses, a limited number of high-value corrections with short explanations, and practical improvement suggestions.
- **FR-WRITE-008.** Writing feedback must be lightweight — not an exhaustive per-sentence or per-error analysis.
- **FR-WRITE-009.** The **approved** writing rubric uses five criteria: (1) Grammar accuracy, (2) Vocabulary, (3) Sentence structure, (4) Coherence and organization, (5) Task completion. The overall writing score is on a **100-point scale**, calculated by the application using a fixed weighting formula applied to these five criteria. Exact per-criterion weights are **TBD** — do not invent specific numeric weights until confirmed by the team.
- **FR-WRITE-010.** Naturalness and clarity may be addressed in qualitative feedback (e.g., strengths/weaknesses/suggestions) but are **not** separate scoring criteria in the MVP.
- **FR-WRITE-011.** If writing evaluation fails or times out, the system must preserve the original free-writing response unchanged and record an appropriate processing status (e.g., "processing failed" or "needs review") rather than losing the response or silently blocking the rest of the report.

### 9.5 Student Problems section
- **FR-PROB-001.** The system must present a set of statements describing common English-learning difficulties (proposed count: ~15–20), organized into sensible areas (e.g., speaking/confidence, listening, vocabulary, grammar, reading, writing, learning habits/exposure). The exact final statement set is a later content decision.
- **FR-PROB-002.** Each statement must be answered on a five-point agreement scale: Strongly disagree, Disagree, Neutral, Agree, Strongly agree.
- **FR-PROB-003.** The system must include one open-ended question allowing the student to describe additional difficulties in their own words.
- **FR-PROB-004.** The open-ended response must accept input in English or Arabic.
- **FR-PROB-005.** The system must preserve structured scale responses distinctly from the open-ended free-text response for analysis purposes.
- **FR-PROB-006.** The Student Problems section's purpose is curriculum-pattern discovery, not clinical or psychological diagnosis, and the product must not present itself or its outputs as diagnostic in that sense.
- **FR-PROB-007.** The MVP does not require showing the student a separate "Learning Difficulties Report"; this data is primarily for internal analysis.
- **FR-PROB-008.** Student Problems data (both the five-point Likert responses and the open-ended response) is **not part of, and must not affect, the student's overall English proficiency score**. It is used for internal aggregate analysis; staff may also inspect individual responses when needed for pilot review.
- **FR-PROB-009.** The student's original open-text response must be stored exactly as submitted. This original response is the primary source of record and must **not** be replaced or silently deleted after any downstream processing.
- **FR-PROB-010.** If the open-text response is in Arabic, the system may use AI to produce an English-normalized or translated representation for analysis purposes. This representation must be stored **separately** from the original response, never in place of it.
- **FR-PROB-011.** The system may use AI to extract structured difficulty categories from the open-text response for aggregation and internal analysis. AI-generated interpretations and categories must be clearly labeled as **derived data** — not presented as the student's original words or as guaranteed fact.
- **FR-PROB-012.** AI-derived interpretations and categories must not affect the student's English score (see FR-PROB-008).
- **FR-PROB-013.** If AI processing of the open-text response fails, the system must preserve the original response unchanged and record an appropriate processing status (e.g., "processing failed" or "needs review").
- **FR-PROB-014.** The system must present a student-facing notice, before or at the open-ended question, asking students not to include unnecessary personal information about others — e.g., other people's names, phone numbers, passwords, or similar private details.
- **FR-PROB-015.** Individual Student Problems responses (original text, normalized/translated representation, and AI-derived categories) must be accessible only to authorized staff.
- **FR-PROB-016.** Student Problems data (original responses, derived representations, and categories) is retained during the pilot and review period. The final retention duration and deletion policy beyond that period is a policy/operations decision and is marked **TBD** (see Section 23).

### 9.6 Feedback & report state
- **FR-FEEDBACK-001.** Deterministic section scores and explanations must be available and displayed immediately after submission, without waiting on any LLM call.
- **FR-FEEDBACK-002.** Free-writing evaluation must run in the background and must not block the rest of the report from being shown.
- **FR-FEEDBACK-003.** If free-writing evaluation completes quickly, its results must be able to appear within the same visit/session.
- **FR-FEEDBACK-004.** If free-writing evaluation has not completed, the system must show a clear status message indicating that Writing feedback is still being prepared.
- **FR-FEEDBACK-005.** Submission and processing state must be persisted so that a returning student sees the current saved report/status rather than a blank or restarted flow.
- **FR-FEEDBACK-006.** The student must never be required or able to retake the assessment to see feedback.
- **FR-FEEDBACK-007.** If writing evaluation fails, the system must preserve the original writing response and show an appropriate processing status (e.g., "processing failed" or "needs review") on the report rather than losing data or leaving the student on an indefinite "in progress" state.
- **FR-FEEDBACK-008.** The report must not imply that it is always fully complete immediately after submission — deterministic results are immediate, but the complete report (including writing feedback) may only be available after background processing finishes.

### 9.7 Staff / internal dashboard
- **FR-STAFF-001.** The system must provide staff-only login using email and password.
- **FR-STAFF-002.** Staff accounts must be created manually by the team; there must be no public/self-service staff registration.
- **FR-STAFF-003.** All staff members share the same permission level in the MVP; no additional role hierarchy is required.
- **FR-STAFF-004.** The dashboard must show submission counts and completion status.
- **FR-STAFF-005.** The dashboard must show overall and section-level score distributions.
- **FR-STAFF-006.** The dashboard must support comparison across Grammar, Vocabulary, Reading, and Writing.
- **FR-STAFF-007.** The dashboard should support comparison across Basic, Intermediate, and Upper-intermediate difficulty levels **where the underlying question metadata, section structure, and distribution of questions make the comparison meaningful**. This is a conditional capability, not an unconditional requirement — the system must not present a misleading comparison when the available metadata or question distribution is insufficient. Final feasibility and presentation are determined during assessment content design and architecture (see Section 23).
- **FR-STAFF-008.** The dashboard must surface the most common Student Problems responses.
- **FR-STAFF-009.** The dashboard must support filtering by cohort.
- **FR-STAFF-010.** Staff must be able to view individual submissions when authorized.
- **FR-STAFF-011.** The system must support exporting data (preferably CSV, or a similarly practical format) for external analysis.
- **FR-STAFF-012.** The dashboard must remain simple and focused; it is explicitly not a full business-intelligence platform.

### 9.8 Content management
- **FR-CONTENT-001.** For the MVP, assessment content is managed through organized project files or another developer-controlled content structure — not a question-management UI.
- **FR-CONTENT-002.** Each question must support the metadata fields listed in FR-DET-002.
- **FR-CONTENT-003.** The product's data structures should be organized so that a question-management interface could plausibly be added later, without this being an MVP requirement.

---

## 10. Assessment Structure

- The assessment is **uniform**, not adaptive: every student receives the same overall structure.
- Difficulty levels — **Basic, Intermediate, Upper-intermediate** — are represented within the relevant sections rather than driving branching logic.
- Sections, in order:
  1. Grammar
  2. Vocabulary
  3. Reading
  4. Writing (one open-ended free-writing task)
  5. Student Problems
- Grammar, Vocabulary, and Reading questions are deterministically evaluable (correct/incorrect, scored, explained) and do not require an LLM; together they are the main structured basis for estimating general English level. Writing is evaluated separately via LLM rubric scoring, not deterministic correction (see Section 12).
- Speaking is out of the application entirely (assessed externally by the project organizer). Listening is deferred to a future phase.

---

## 11. Student Problems Requirements

(See FR-PROB-001 through FR-PROB-016 in Section 9.5 for the normative requirements.)

Additional notes:
- This is not a generic yes/no checklist; it is a five-point agreement-spectrum instrument.
- Example statement: *"I feel confident when I speak around people."*
- Candidate difficulty themes include: nervousness speaking English, fear of making mistakes, difficulty finding the right words, translating from Arabic before forming English sentences, difficulty understanding spoken English, difficulty remembering vocabulary, difficulty using grammar, difficulty writing in English, difficulty understanding academic English, and lack of practice/exposure. These are **proposed**, not final.
- The open-ended response may contain personal information; its handling, retention, and anonymization must be designed carefully (see Section 17).

**Role of this data.** The structured Likert responses and any categorized open-text responses are primarily intended for aggregate internal analysis to inform curriculum design. Staff may inspect individual responses when needed for pilot review. This data is **not** part of the overall English proficiency score, and it is **not** displayed to the student as a separate diagnostic report in the MVP (see FR-PROB-007/008).

**Open-text handling (approved approach — "Option C").** The pilot retains both the student's original open-text response and any AI-derived analysis during the pilot and review period, with basic privacy controls:
- The original response is stored verbatim and is the primary source of record; it is never replaced.
- Arabic responses may receive an AI-generated English-normalized/translated representation, stored separately from the original.
- AI may extract structured difficulty categories for aggregation; these are labeled as derived data, not the student's original words or guaranteed fact, and never affect the student's English score.
- If AI processing fails, the original response is preserved and a "processing failed" / "needs review" status is recorded.
- Students see a notice asking them not to include unnecessary personal information about others.
- Only authorized staff can access individual responses and derived interpretations.
- Final retention duration and deletion policy beyond the pilot/review period is a policy/operations decision — **TBD**.

---

## 12. Writing Evaluation Requirements

(See FR-WRITE-001 through FR-WRITE-011 in Section 9.4 for the normative requirements.)

The Writing section is open-ended free writing only — there is no controlled writing / sentence-level correction component in the MVP. Design principle: the LLM is a **structured evaluator against a fixed, approved rubric**, not a free-form grader and not a deterministic question-correction engine. It supplies criterion-level judgments with supporting evidence where practical; the application computes the final 100-point score deterministically from those criteria using a fixed weighting formula. The rubric's five criteria (grammar accuracy, vocabulary, sentence structure, coherence and organization, task completion) are approved; the exact per-criterion weights, the specific model, and the hosting/pipeline approach (likely Ollama-based) are explicitly deferred — see Section 23.

---

## 13. Feedback and Result States

The report must be able to represent, per submission, at least the following states:

| State | Description |
|---|---|
| Draft (in progress) | Student has started but not submitted; editable, autosaved/resumable, not a "result" state. |
| Submitted — deterministic results ready, writing pending | Grammar/Vocabulary/Reading results and explanations visible immediately; free-writing evaluation still processing in the background. Submission is now immutable. |
| Submitted — fully evaluated | All sections, including free-writing, have results. |
| Submitted — writing processing failed / needs review | Deterministic results visible; original free-writing response preserved; writing evaluation shows a "processing failed" / "needs review" status instead of results. |
| Returning visit — saved report | Student re-enters cohort code + roll number after already submitting; system shows the saved report and its current status, never a new attempt or an editable draft. |

(See FR-FEEDBACK-001 through FR-FEEDBACK-008 in Section 9.6 for normative requirements.)

---

## 14. Staff Dashboard and Analysis Requirements

(See FR-STAFF-001 through FR-STAFF-012 in Section 9.7 for the normative requirements.)

The dashboard is explicitly scoped as a **limited internal analysis view**, not a full BI product. It must let staff understand the pilot cohort well enough to inform curriculum design and must support external, deeper analysis via export rather than trying to replace tools like Excel or Python within the product.

---

## 15. Authentication and Access Control

- **NFR-SEC-001.** Students do not authenticate via account/password; identity is established via cohort access code + university roll number + name.
- **NFR-SEC-002.** The cohort access code must **not** be treated as a security mechanism for staff access — it is a student-cohort identifier only.
- **NFR-SEC-003.** Staff must authenticate via email and password.
- **NFR-SEC-004.** Staff accounts must be provisioned manually; there is no self-service or public staff registration path.
- **NFR-SEC-005.** Student-facing and staff-facing access must be clearly separated at both the UI and access-control levels.
- **NFR-SEC-006.** The system must ensure one student cannot view another student's submission or report.
- **NFR-SEC-007.** All staff members currently share one permission level; the system should not introduce unnecessary role complexity for the MVP.
- **NFR-SEC-008.** Student reports must not be publicly accessible. The system must validate the student's identifying information (cohort access code + university roll number, plus name as supporting information) before showing a report.
- **NFR-SEC-009.** A student must not be able to access another student's report through simple guessing or modification of identifiers (e.g., predictable or sequential report links/IDs).
- **NFR-SEC-010.** Staff dashboard access must be protected more strongly than student report access, via staff login (see NFR-SEC-003).
- **NFR-SEC-011.** This is intentionally a basic, MVP-appropriate access-control approach — not a full authentication system or a separate security project for report access. The exact technical mechanism (e.g., token design, session handling) is an *architecture-phase decision* (see Section 23).

---

## 16. Data Model Requirements (Product Level)

At the product-requirements level (not a schema), the system must be able to represent and persist, per student submission:

- Student name
- University roll number
- Cohort identifier
- Assessment answers (Grammar, Vocabulary, Reading)
- Section-level scores
- Free-writing response text (original, as submitted)
- AI-generated Writing evaluation (criterion-level results, rationale, system-calculated overall score on a 100-point scale, feedback)
- Student Problems structured (five-point) responses
- Student Problems open-ended free-text response, stored exactly as submitted (English or Arabic)
- Student Problems AI-normalized/translated representation of the open-text response, when applicable, stored separately from the original
- Student Problems AI-derived structured difficulty categories, labeled as derived data
- Processing status (e.g., draft / submitted — pending / submitted — complete / processing failed — needs review) and relevant timestamps, tracked separately for Writing evaluation and Student Problems open-text processing
- Submission uniqueness key: cohort + university roll number

The exact schema, storage technology, and content-authoring format are explicitly deferred to the architecture phase.

---

## 17. Data Privacy and Security Requirements

- **NFR-PRIV-001.** Student data must be accessible only to authenticated staff.
- **NFR-PRIV-002.** Personally identifiable information (name, roll number) and academic information (scores, responses) must be protected from unauthorized access.
- **NFR-PRIV-003.** Staff authentication must be secure (see Section 15).
- **NFR-PRIV-004.** Appropriate authorization checks must gate access to individual submissions and dashboard data.
- **NFR-PRIV-005.** The open-ended Student Problems response (English or Arabic, potentially containing personal information) must be handled per the approved "Option C" approach in Section 11: original response retained verbatim, any AI-normalized/translated or AI-derived-category data stored separately and labeled as derived, with access restricted to authorized staff.
- **NFR-PRIV-006.** Retention duration and deletion policy beyond the pilot/review period must be confirmed by the team; **this is currently unresolved and marked TBD** (see Section 23). Data is retained during the pilot and review period per the approved approach.
- **NFR-PRIV-009.** The system must present a student-facing notice asking students not to include unnecessary personal information about others (e.g., other people's names, phone numbers, passwords) in open-text responses (see FR-PROB-014).
- **NFR-PRIV-007.** The system must prevent any student from viewing another student's data.
- **NFR-PRIV-008.** The team intends full retention of pilot assessment data with strong attention to security and access control; no final legal or jurisdiction-specific compliance claim is made by this document, and any such claim must be validated separately by the team.

---

## 18. Non-Functional Requirements

- **NFR-GEN-001.** The application must remain usable and responsive for a small pilot cohort (exact scale not specified in source material — Assumption requiring validation: low tens to low hundreds of students).
- **NFR-GEN-002.** The free-writing LLM evaluation must not block the rest of the report from displaying (see FR-FEEDBACK-002).
- **NFR-GEN-003.** The system must preserve submitted work reliably across normal failure modes (see Section 19).
- **NFR-GEN-004.** The system must support bilingual input (English/Arabic) at least for the Student Problems open-ended field.
- **NFR-GEN-005.** The student-facing UI must clearly prioritize the student flow, with staff access visually secondary but clearly discoverable.
- **NFR-GEN-006.** Specific performance targets (page load time, LLM evaluation turnaround target) are not defined in the source material — **TBD**.

---

## 19. Edge Cases and Failure States

The following must be addressed as requirements (protecting student work and system integrity); specific implementation mechanisms are deferred to the architecture phase:

- **EDGE-001.** Browser closed or crashed mid-assessment before submission — the student's in-progress answers should not be irrecoverably lost; exact mechanism is an *Open implementation decision*.
- **EDGE-002.** Network interruption during the assessment — behavior must protect already-entered answers; exact mechanism is an *Open implementation decision*.
- **EDGE-003.** Student attempts to start a second assessment for the same cohort + roll number — system must block this and show the existing saved report/status instead (normative; see FR-STU-006/007).
- **EDGE-004.** Free-writing LLM evaluation fails or times out — the system must preserve the original free-writing response, still show the deterministic parts of the report, and display a "processing failed" / "needs review" status rather than losing the submission (see FR-WRITE-011, FR-FEEDBACK-007). Exact retry/error-recovery implementation is an *architecture-phase decision* — **TBD**.
- **EDGE-008.** Student Problems open-text AI processing (normalization/translation or category extraction) fails — the original response must be preserved and a "processing failed" / "needs review" status recorded (see FR-PROB-013); this must not block the rest of the report or delete any data.
- **EDGE-005.** Student returns after a long delay while Writing evaluation is still "in progress" (e.g., due to a backlog or failure) — system must show current true status, not a false "in progress" indefinitely. Staleness handling is **TBD**.
- **EDGE-006.** Two students attempt to use the same roll number within a cohort (e.g., typo or duplicate) — exact conflict-resolution behavior is **TBD / Open implementation decision**.
- **EDGE-007.** Student leaves the open-ended Student Problems field blank — this is permitted; system must not block final submission on this field (per FR-ASSESS-007).

---

## 20. Success Criteria

Success criteria were not explicitly enumerated in the source conversation. The following are proposed and require team confirmation:

- **Proposed SC-1.** All pilot students who receive a valid cohort access code are able to complete the assessment in a single, uninterrupted (or resumable) session without data loss.
- **Proposed SC-2.** Deterministic feedback (Grammar/Vocabulary/Reading) is available to the student immediately upon submission.
- **Proposed SC-3.** Free-writing feedback is delivered reliably, either within the same visit or via a clear "in progress" → "complete" status transition on return.
- **Proposed SC-4.** Staff can, without external tooling, view submission counts, score distributions, and Student Problems patterns for the pilot cohort.
- **Proposed SC-5.** Staff can export the full pilot dataset for deeper external analysis.

*(Marked as proposed — Assumption requiring validation.)*

---

## 21. Risks and Trade-offs

- **Risk:** No anti-cheating mechanism means external assistance (e.g., AI tools) during the assessment cannot be prevented. **Accepted trade-off** per source decision — preventing this is explicitly not a pilot objective, though students are told not to use external sources or AI.
- **Risk:** LLM-based free-writing evaluation introduces latency and potential failure modes not present in deterministic sections. Mitigated by background processing and clear status messaging, but exact SLAs are undefined (TBD).
- **Risk:** Open-ended text responses (Student Problems, free writing) may contain personal information in an unstructured form. Mitigated for Student Problems by the approved "Option C" approach (verbatim retention, separately stored derived data, staff-only access, student-facing notice — see Section 11); retention duration beyond the pilot/review period remains **TBD**.
- **Risk:** A single-attempt, no-edit model means any student error during entry (e.g., wrong roll number) could lock them out of a genuine attempt or create ambiguous records. Recovery/support process is **TBD**.
- **Trade-off:** Content is managed via developer-controlled files rather than a CMS, which is simpler to build but slower to iterate on question content — accepted for MVP per source decision.

---

## 22. Future Extensibility

Explicitly out of MVP scope but named as possible future directions (must not expand current MVP):

- Listening assessment.
- Automated pronunciation scoring.
- A question-management dashboard/CMS.
- More sophisticated staff roles/permissions.
- Deeper analytics/BI capability.
- Personalized learning paths or a full AI English coach.
- Adaptive (rather than uniform) testing.

The product's data structures should be organized with enough separation (content vs. submissions vs. staff tooling) that these could plausibly be layered in later, without this being a present requirement.

---

## 23. Open Decisions and TBDs

Open items are split into two categories: **product/content decisions**, which shape what the product says or scores and should stay visible to the team; and **architecture/implementation decisions**, which are deferred to the (not-yet-started) architecture phase and do not need product-level resolution now.

### 23.1 Product / content decisions (require team confirmation)

1. **Exact per-criterion weights** for the approved five-criterion writing rubric (grammar accuracy, vocabulary, sentence structure, coherence/organization, task completion) on the 100-point scale — criteria are approved, weights are **TBD**.
2. **Final free-writing task prompt(s)** — not yet written.
3. **Final assessment questions and difficulty distribution** across Grammar/Vocabulary/Reading — content not finalized.
4. **Final Student Problems statement set** (~15–20 statements) and category grouping — themes proposed, wording not finalized.
5. **Student-facing wording** — e.g., "Writing feedback is still being prepared" message, Student Problems privacy notice, processing-status labels, Staff login link text.
6. **Data retention duration and deletion policy** beyond the pilot/review period — team intends retention during the pilot and review period; the schedule after that is undefined.
7. **Feasibility and presentation of difficulty-level (Basic/Intermediate/Upper-intermediate) dashboard comparisons** — conditional on final question metadata and distribution design (see FR-STAFF-007).
8. **Legal/privacy compliance posture** (jurisdiction, applicable regulations) — not addressed in source material; no compliance claim should be assumed.
9. **Success criteria** — proposed in Section 20 but not confirmed by the team.
10. **Approximate pilot scale** (number of students/cohorts) — not specified in source material.

### 23.2 Architecture / implementation decisions (deferred — not to be started yet)

1. **Draft/autosave persistence mechanism** for in-progress assessments.
2. **Database schema.**
3. **Background job/queue implementation** for LLM evaluation (Writing evaluation and Student Problems open-text processing).
4. **Ollama/LLM integration details** — exact model and technical pipeline.
5. **Aggregation strategy** for dashboard metrics, including how difficulty-level comparisons (if feasible) are computed.
6. **Exact access-control implementation** for student report access (e.g., token design, session handling) and for staff authentication.
7. **Dashboard data-query or precomputation strategy.**
8. **Mechanism for AI English-normalization/translation** of Arabic open-text Student Problems responses.
9. **Conflict-handling implementation** for duplicate/mistaken roll-number entries within a cohort.
10. **Performance targets and infrastructure sizing** (load time, LLM turnaround expectations) — not specified.
11. **Retry/error-recovery implementation** for failed or timed-out LLM evaluations (Writing and Student Problems categorization).
12. **Recovery mechanism** for browser closure/network interruption mid-draft — requirement is stated (FR-ASSESS-006), mechanism is not.

---

## 24. Summary of MVP Requirements

The MVP is a two-sided web application:

- **Students** use a cohort access code plus roll number and name to take a single, uniform, five-section written English assessment — Grammar, Vocabulary, Reading, one open-ended Writing task, and Student Problems (no account, no retake). Work is an editable, autosaved draft until final submission, after which it is immutable. Students receive immediate deterministic feedback (Grammar/Vocabulary/Reading) plus background-processed, LLM-evaluated writing feedback against an approved five-criterion, 100-point rubric with a deterministically calculated score; if writing evaluation fails, the response is preserved with a "needs review" status.
- **Staff** (currently two, equal permissions, manually provisioned, email/password login) use a simple internal dashboard to view submissions, aggregate score and difficulty-pattern data, filter by cohort, and export data for deeper external analysis.

The system must validate student identity before showing a report (without a full account system), prevent students from guessing their way into another student's report, protect the staff dashboard more strongly via login, and preserve all recorded work reliably — while deliberately excluding accounts for students, complex roles, controlled-writing correction, speaking/listening automation, adaptive testing, a content-management UI, and any broader learning-platform functionality from this MVP.

---

## Items Requiring Review

These are the product/content decisions that genuinely remain open and need team confirmation (mirrors Section 23.1; architecture/implementation items in Section 23.2 are deferred and do not need review yet):

- Exact per-criterion weights for the approved five-criterion writing rubric (100-point scale).
- Final free-writing task prompt(s).
- Final assessment questions and difficulty distribution across Grammar/Vocabulary/Reading.
- Final Student Problems statement wording and grouping (~15–20 statements).
- Student-facing wording (status messages, privacy notice, labels).
- Data retention duration and deletion policy beyond the pilot/review period.
- Feasibility and presentation of difficulty-level (Basic/Intermediate/Upper-intermediate) dashboard comparisons.
- Legal/privacy compliance posture (jurisdiction-specific requirements, if any).
- Confirmation of proposed success criteria (Section 20).
- Approximate pilot scale (cohorts, students per cohort).
