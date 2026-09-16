import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../app.ts';
import { hashPassword } from '../auth/passwordHasher.ts';
import { getContentLoader } from '../content/ContentLoader.ts';
import type { DraftAnswers } from '../shared/types/draft.ts';
import { createCohort, createStaffUser, createSubmission, prisma, useCleanTestDatabase } from '../test/fixtures.ts';

/**
 * Integration tests for `GET /api/student/draft` (T4.1.1), against the real test database and the
 * real assembled application.
 *
 * The route is driven through `createApp()` rather than a throwaway app, and the student session is
 * obtained the only way one can be — by verifying an identity through
 * `POST /api/session/student-verify`. That is what makes these tests about the actual access path
 * rather than about a handler in isolation: no test here can reach the draft without going through
 * the same door a student does, and none of them can name a submission.
 */

const COHORT_CODE = 'PILOT-2026';
const STAFF_EMAIL = 'staff@lexora.test';
const STAFF_PASSWORD = 'correct horse battery staple';

/** A client holding a live student session for the given identity. */
async function verifiedStudent(
  details: { rollNumber: string; studentName: string } = {
    rollNumber: '2021-001',
    studentName: 'Alice Example',
  },
) {
  const agent = request.agent(createApp());

  await agent
    .post('/api/session/student-verify')
    .send({ cohortCode: COHORT_CODE, ...details })
    .expect(200);

  return agent;
}

useCleanTestDatabase();

describe('GET /api/student/draft', () => {
  it('returns the saved answers and the content for the draft', async () => {
    const cohort = await createCohort({ code: COHORT_CODE, name: 'Pilot Cohort 2026' });
    const submission = await createSubmission(cohort.id, {
      rollNumberRaw: '2021-001',
      rollNumberNormalized: '2021-001',
      studentName: 'Alice Example',
      answers: { grammar: { 'gr-01': 'b' }, writing: { essayText: 'My first paragraph.' } },
    });

    const response = await (await verifiedStudent()).get('/api/student/draft').expect(200);

    expect(response.body.status).toBe('draft');
    expect(response.body.contentVersion).toBe(submission.contentVersion);
    expect(response.body.answers).toEqual({
      grammar: { 'gr-01': 'b' },
      writing: { essayText: 'My first paragraph.' },
    });
  });

  it('serves content for the version the draft was frozen under, matching the questions asked', async () => {
    const cohort = await createCohort({ code: COHORT_CODE });
    await createSubmission(cohort.id, {
      rollNumberRaw: '2021-001',
      rollNumberNormalized: '2021-001',
      studentName: 'Alice Example',
      contentVersion: 'v1',
    });

    const response = await (await verifiedStudent()).get('/api/student/draft').expect(200);

    // The served questions are the content bundle's own, resolved through the frozen version — so
    // the id a student answers here is an id the scorer will be able to look up later (E5).
    const bundle = getContentLoader().getContent('v1');
    expect(response.body.content.grammar).toEqual(bundle.grammar);
    expect(response.body.content.vocabulary).toEqual(bundle.vocabulary);
    expect(response.body.content.reading).toEqual(bundle.reading);
    expect(response.body.content.writing).toEqual(bundle.writingPrompt);
    expect(response.body.content.studentProblems).toEqual(bundle.studentProblems);

    // Every section is present, so the UI never has to guess whether a section exists.
    expect(Object.keys(response.body.content).sort()).toEqual([
      'grammar',
      'reading',
      'studentProblems',
      'vocabulary',
      'writing',
    ]);
  });

  it('does not serve the AI rubric instructions or weights to the browser', async () => {
    // The rubric is the prompt the model is graded against and the weights its judgements are
    // combined with; neither is an input to rendering the assessment, so neither is served.
    const cohort = await createCohort({ code: COHORT_CODE });
    await createSubmission(cohort.id, {
      rollNumberRaw: '2021-001',
      rollNumberNormalized: '2021-001',
      studentName: 'Alice Example',
    });

    const response = await (await verifiedStudent()).get('/api/student/draft').expect(200);

    expect(response.body.content).not.toHaveProperty('writingRubric');
    expect(response.body).not.toHaveProperty('writingRubricInstructions');
    expect(response.body).not.toHaveProperty('writingRubricWeights');
  });

  it('refuses to fall back to current content when the frozen version no longer resolves', async () => {
    // The invariant behind Section 12's "frozen at draft creation": a submission is interpreted
    // against the version it was taken under, or not at all — never against whatever is current.
    // Serving today's content here would silently re-ask questions this student never saw.
    const cohort = await createCohort({ code: COHORT_CODE });
    await createSubmission(cohort.id, {
      rollNumberRaw: '2021-001',
      rollNumberNormalized: '2021-001',
      studentName: 'Alice Example',
      contentVersion: 'v-does-not-exist',
    });

    await (await verifiedStudent()).get('/api/student/draft').expect(500);
  });

  it('reports a submitted assessment as submitted, with its answers intact', async () => {
    // Section 9: `/assessment` is for drafts. A returning student whose work is in is told so, and
    // the SPA sends them to their report — the server reports the state, it does not choose the
    // route. Their answers still come back, because they are the student's own.
    const cohort = await createCohort({ code: COHORT_CODE });
    await createSubmission(cohort.id, {
      rollNumberRaw: '2021-001',
      rollNumberNormalized: '2021-001',
      studentName: 'Alice Example',
      status: 'submitted',
      answers: { grammar: { 'gr-01': 'b' } },
    });

    const response = await (await verifiedStudent()).get('/api/student/draft').expect(200);

    expect(response.body.status).toBe('submitted');
    expect(response.body.answers).toEqual({ grammar: { 'gr-01': 'b' } });
  });

  it('returns an empty answers object for a draft nothing has been saved into yet', async () => {
    await createCohort({ code: COHORT_CODE });

    // Verification creates the draft, so this is a genuine first visit: a session exists and the
    // student has not typed anything.
    const response = await (await verifiedStudent()).get('/api/student/draft').expect(200);

    expect(response.body.answers).toEqual({});
  });

  it('reads only the session submission, so two students never see each other’s work', async () => {
    const cohort = await createCohort({ code: COHORT_CODE });
    await createSubmission(cohort.id, {
      rollNumberRaw: '2021-001',
      rollNumberNormalized: '2021-001',
      studentName: 'Alice Example',
      answers: { grammar: { 'gr-01': 'b' } },
    });
    await createSubmission(cohort.id, {
      rollNumberRaw: '2021-002',
      rollNumberNormalized: '2021-002',
      studentName: 'Bob Example',
      answers: { grammar: { 'gr-01': 'c' } },
    });

    const alice = await (await verifiedStudent()).get('/api/student/draft').expect(200);
    const bob = await (
      await verifiedStudent({ rollNumber: '2021-002', studentName: 'Bob Example' })
    )
      .get('/api/student/draft')
      .expect(200);

    expect(alice.body.answers).toEqual({ grammar: { 'gr-01': 'b' } });
    expect(bob.body.answers).toEqual({ grammar: { 'gr-01': 'c' } });
  });

  it('ignores any submission id supplied in the query string', async () => {
    // NFR-SEC-009: there is no ID-bearing student route, and asking for one changes nothing — the
    // session is the only thing consulted.
    const cohort = await createCohort({ code: COHORT_CODE });
    const mine = await createSubmission(cohort.id, {
      rollNumberRaw: '2021-001',
      rollNumberNormalized: '2021-001',
      studentName: 'Alice Example',
      answers: { grammar: { 'gr-01': 'b' } },
    });
    const theirs = await createSubmission(cohort.id, {
      rollNumberRaw: '2021-002',
      rollNumberNormalized: '2021-002',
      studentName: 'Bob Example',
      answers: { grammar: { 'gr-01': 'c' } },
    });

    const response = await (await verifiedStudent())
      .get(`/api/student/draft?submissionId=${theirs.id}`)
      .expect(200);

    expect(response.body.answers).toEqual({ grammar: { 'gr-01': 'b' } });
    expect(response.body.answers).not.toEqual(theirs.answers);
    await expect(prisma().submission.count({ where: { id: mine.id } })).resolves.toBe(1);
  });
});

describe('PATCH /api/student/draft', () => {
  it('saves one section without disturbing any other', async () => {
    // The requirement the whole endpoint exists for (Section 12): a save of the section the
    // student is typing in must never cost them the sections they already finished.
    const cohort = await createCohort({ code: COHORT_CODE });
    const submission = await createSubmission(cohort.id, {
      rollNumberRaw: '2021-001',
      rollNumberNormalized: '2021-001',
      studentName: 'Alice Example',
      answers: { grammar: { 'gr-01': 'a' }, reading: { 'rd-01': 'b' } },
    });
    const agent = await verifiedStudent();

    const response = await agent
      .patch('/api/student/draft')
      .send({ section: 'vocabulary', sectionAnswers: { 'vo-01': 'c' } })
      .expect(200);

    expect(response.body).toEqual({ status: 'saved', section: 'vocabulary' });

    const stored = await prisma().submission.findUniqueOrThrow({ where: { id: submission.id } });
    expect(stored.answers).toEqual({
      grammar: { 'gr-01': 'a' },
      reading: { 'rd-01': 'b' },
      vocabulary: { 'vo-01': 'c' },
    });

    // And the same through the read path the page actually uses.
    const draft = await agent.get('/api/student/draft').expect(200);
    expect(draft.body.answers).toEqual(stored.answers);
  });

  it('persists two concurrent saves of different sections, losing neither', async () => {
    // Both requests are in flight before either is awaited, so their UPDATEs overlap. Each is a
    // single atomic statement touching only its own key, so this is not a race with a winner —
    // it is two independent writes, and both must survive (Section 12).
    const cohort = await createCohort({ code: COHORT_CODE });
    const submission = await createSubmission(cohort.id, {
      rollNumberRaw: '2021-001',
      rollNumberNormalized: '2021-001',
      studentName: 'Alice Example',
    });
    const agent = await verifiedStudent();

    const [first, second] = await Promise.all([
      agent
        .patch('/api/student/draft')
        .send({ section: 'grammar', sectionAnswers: { 'gr-01': 'a' } })
        .expect(200),
      agent
        .patch('/api/student/draft')
        .send({ section: 'writing', sectionAnswers: { essayText: 'A paragraph.' } })
        .expect(200),
    ]);

    expect(first.body.status).toBe('saved');
    expect(second.body.status).toBe('saved');

    const stored = await prisma().submission.findUniqueOrThrow({ where: { id: submission.id } });
    expect(stored.answers).toEqual({
      grammar: { 'gr-01': 'a' },
      writing: { essayText: 'A paragraph.' },
    });
  });

  it('rejects a save against a submitted record and changes nothing', async () => {
    // Server-enforced immutability (Section 12, FR-ASSESS-008). A tab left open across the
    // student's own submission is the realistic case, and it must not be able to write.
    const cohort = await createCohort({ code: COHORT_CODE });
    const answers = { grammar: { 'gr-01': 'a' } };
    const submission = await createSubmission(cohort.id, {
      rollNumberRaw: '2021-001',
      rollNumberNormalized: '2021-001',
      studentName: 'Alice Example',
      status: 'submitted',
      answers,
    });

    // The session was issued while the row was still a draft, which is exactly the situation
    // Section 9 warns about: the guard cannot know, so the write itself must re-check.
    const response = await (await verifiedStudent()).patch('/api/student/draft').send({
      section: 'grammar',
      sectionAnswers: { 'gr-01': 'z' },
    });

    expect(response.status).toBe(409);
    expect(response.body).toEqual({
      error: 'This assessment has already been submitted, so it can no longer be changed',
    });
    expect((await prisma().submission.findUniqueOrThrow({ where: { id: submission.id } })).answers)
      .toEqual(answers);
  });

  it('saves into a section that has never been written before', async () => {
    await createCohort({ code: COHORT_CODE });
    const agent = await verifiedStudent();

    await agent
      .patch('/api/student/draft')
      .send({
        section: 'studentProblems',
        sectionAnswers: { likertAnswers: { 'sp-01': 4 }, openText: 'النطق صعب' },
      })
      .expect(200);

    const draft = await agent.get('/api/student/draft').expect(200);
    expect(draft.body.answers).toEqual({
      studentProblems: { likertAnswers: { 'sp-01': 4 }, openText: 'النطق صعب' },
    });
  });

  it('stores Arabic open text exactly as sent', async () => {
    // FR-PROB-004 / NFR-GEN-004 — the field accepts English or Arabic, and the original is the
    // record (FR-PROB-009), so what is stored must be what was typed, unaltered.
    const cohort = await createCohort({ code: COHORT_CODE });
    const submission = await createSubmission(cohort.id, {
      rollNumberRaw: '2021-001',
      rollNumberNormalized: '2021-001',
      studentName: 'Alice Example',
    });
    const openText = 'أجد صعوبة في التحدث بالإنجليزية أمام زملائي.';

    await (await verifiedStudent())
      .patch('/api/student/draft')
      .send({ section: 'studentProblems', sectionAnswers: { openText } })
      .expect(200);

    const stored = await prisma().submission.findUniqueOrThrow({ where: { id: submission.id } });
    expect(stored.answers).toEqual({ studentProblems: { openText } });
  });

  it('rejects a request carrying no student session', async () => {
    await request(createApp())
      .patch('/api/student/draft')
      .send({ section: 'grammar', sectionAnswers: { 'gr-01': 'a' } })
      .expect(401, { error: 'Authentication required' });
  });

  it('writes only to the session submission, and has no field to point at another', async () => {
    // NFR-SEC-009's shape: the body carries a section and its answers, and that is all it can carry
    // (the schema is strict). A submission id is not a field this endpoint has — so the only id in
    // play is the session's, and there is nothing to tamper with rather than a check to defeat.
    const cohort = await createCohort({ code: COHORT_CODE });
    const mine = await createSubmission(cohort.id, {
      rollNumberRaw: '2021-001',
      rollNumberNormalized: '2021-001',
      studentName: 'Alice Example',
    });
    const theirs = await createSubmission(cohort.id, {
      rollNumberRaw: '2021-002',
      rollNumberNormalized: '2021-002',
      studentName: 'Bob Example',
      answers: { grammar: { 'gr-01': 'untouched' } },
    });
    const agent = await verifiedStudent();

    const refused = await agent
      .patch('/api/student/draft')
      .send({ submissionId: theirs.id, section: 'grammar', sectionAnswers: { 'gr-01': 'a' } })
      .expect(400);

    expect(refused.body.details).toEqual([
      { field: '(root)', message: "Unrecognized key(s) in object: 'submissionId'" },
    ]);

    // And a well-formed save lands on the session's own row, leaving the other student's alone.
    await agent
      .patch('/api/student/draft')
      .send({ section: 'grammar', sectionAnswers: { 'gr-01': 'a' } })
      .expect(200);

    expect((await prisma().submission.findUniqueOrThrow({ where: { id: mine.id } })).answers)
      .toEqual({ grammar: { 'gr-01': 'a' } });
    expect((await prisma().submission.findUniqueOrThrow({ where: { id: theirs.id } })).answers)
      .toEqual({ grammar: { 'gr-01': 'untouched' } });
  });

  it('refuses a session naming a submission that no longer exists', async () => {
    await createCohort({ code: COHORT_CODE });
    const agent = await verifiedStudent();

    await prisma().submission.deleteMany();

    await agent
      .patch('/api/student/draft')
      .send({ section: 'grammar', sectionAnswers: { 'gr-01': 'a' } })
      .expect(401, { error: 'Authentication required' });
  });
});

describe('PATCH /api/student/draft — malformed payloads', () => {
  /** A draft and a session to point the malformed requests at. */
  async function draftWithSession() {
    const cohort = await createCohort({ code: COHORT_CODE });
    const submission = await createSubmission(cohort.id, {
      rollNumberRaw: '2021-001',
      rollNumberNormalized: '2021-001',
      studentName: 'Alice Example',
      answers: { grammar: { 'gr-01': 'a' } },
    });

    return { submission, agent: await verifiedStudent() };
  }

  it('rejects a section key that is not one of the five', async () => {
    // The load-bearing case. The section key is written as a *key* into the JSONB column, so an
    // unchecked one is not a bad value in a field — it is a new field, in a document the rest of
    // the system reads by section. Rejecting it is what keeps the key set closed.
    const { submission, agent } = await draftWithSession();

    const response = await agent
      .patch('/api/student/draft')
      .send({ section: 'answers', sectionAnswers: { admin: true } })
      .expect(400);

    expect(response.body.error).toBe('Invalid request body');
    expect(response.body.details[0].field).toBe('section');

    const stored = await prisma().submission.findUniqueOrThrow({ where: { id: submission.id } });
    expect(stored.answers).toEqual({ grammar: { 'gr-01': 'a' } });
  });

  it('rejects answers that do not match the section they are sent under', async () => {
    // The reason the schema is a discriminated union: `section` and the answers' shape are checked
    // together, so grammar answers cannot be stored under the writing key.
    const { submission, agent } = await draftWithSession();

    const response = await agent
      .patch('/api/student/draft')
      .send({ section: 'writing', sectionAnswers: { 'gr-01': 'a' } })
      .expect(400);

    // Under a flat `{section: enum, sectionAnswers: unknown}` this body would have been accepted
    // and stored: a grammar answer filed under the writing key, surfacing months later as a blank
    // essay. The refusal is the discriminated union doing its job.
    expect(response.body.details).toEqual([
      { field: 'sectionAnswers', message: "Unrecognized key(s) in object: 'gr-01'" },
    ]);

    const stored = await prisma().submission.findUniqueOrThrow({ where: { id: submission.id } });
    expect(stored.answers).toEqual({ grammar: { 'gr-01': 'a' } });
  });

  it('rejects a Likert response outside the five-point scale', async () => {
    // FR-PROB-002's scale is a product rule, and an out-of-range value would corrupt the aggregate
    // analysis this data exists for.
    const { submission, agent } = await draftWithSession();

    const response = await agent
      .patch('/api/student/draft')
      .send({ section: 'studentProblems', sectionAnswers: { likertAnswers: { 'sp-01': 9 } } })
      .expect(400);

    expect(response.body.details[0].field).toBe('sectionAnswers.likertAnswers.sp-01');
    expect(response.body.details[0].message).toContain('less than or equal to 5');

    const stored = await prisma().submission.findUniqueOrThrow({ where: { id: submission.id } });
    expect(stored.answers).toEqual({ grammar: { 'gr-01': 'a' } });
  });

  it('rejects a non-integer Likert response', async () => {
    const { agent } = await draftWithSession();

    await agent
      .patch('/api/student/draft')
      .send({ section: 'studentProblems', sectionAnswers: { likertAnswers: { 'sp-01': 3.5 } } })
      .expect(400);
  });

  it('rejects a choice answer that is not a string', async () => {
    const { agent } = await draftWithSession();

    const response = await agent
      .patch('/api/student/draft')
      .send({ section: 'grammar', sectionAnswers: { 'gr-01': 2 } })
      .expect(400);

    expect(response.body.details[0].field).toBe('sectionAnswers.gr-01');
  });

  it('rejects an unknown key inside a section rather than silently dropping it', async () => {
    // Dropping it would store a save that did not save what the client sent — the failure would be
    // invisible until a student's work turned out not to be there.
    const { agent } = await draftWithSession();

    const response = await agent
      .patch('/api/student/draft')
      .send({ section: 'writing', sectionAnswers: { essayText: 'ok', wordCount: 2 } })
      .expect(400);

    expect(response.body.details).toEqual([
      { field: 'sectionAnswers', message: "Unrecognized key(s) in object: 'wordCount'" },
    ]);
  });

  it('rejects a missing section or a missing answers object', async () => {
    const { agent } = await draftWithSession();

    const noSection = await agent
      .patch('/api/student/draft')
      .send({ sectionAnswers: { 'gr-01': 'a' } })
      .expect(400);
    expect(noSection.body.details[0].field).toBe('section');

    const noAnswers = await agent
      .patch('/api/student/draft')
      .send({ section: 'grammar' })
      .expect(400);
    expect(noAnswers.body.details[0].field).toBe('sectionAnswers');
  });

  it('accepts an empty section, because an empty section is a real state', async () => {
    // A student who has opened Writing and typed nothing, or Student Problems before answering
    // anything, still has that section — and clearing an answer must be saveable, not an error.
    const { submission, agent } = await draftWithSession();

    await agent
      .patch('/api/student/draft')
      .send({ section: 'writing', sectionAnswers: {} })
      .expect(200);

    await agent
      .patch('/api/student/draft')
      .send({ section: 'studentProblems', sectionAnswers: {} })
      .expect(200);

    const stored = await prisma().submission.findUniqueOrThrow({ where: { id: submission.id } });
    expect(stored.answers).toEqual({
      grammar: { 'gr-01': 'a' },
      writing: {},
      studentProblems: {},
    });
  });

  it('accepts an empty open-text answer, which never blocks submission', async () => {
    const { submission, agent } = await draftWithSession();

    await agent
      .patch('/api/student/draft')
      .send({ section: 'studentProblems', sectionAnswers: { likertAnswers: { 'sp-01': 5 }, openText: '' } })
      .expect(200);

    const stored = await prisma().submission.findUniqueOrThrow({ where: { id: submission.id } });
    expect(stored.answers).toMatchObject({
      studentProblems: { likertAnswers: { 'sp-01': 5 }, openText: '' },
    });
  });
});

describe('GET /api/student/draft — access control', () => {
  it('rejects a request carrying no student session', async () => {
    await createCohort({ code: COHORT_CODE });

    const response = await request(createApp()).get('/api/student/draft').expect(401);

    expect(response.body).toEqual({ error: 'Authentication required' });
  });

  it('rejects a staff session, and does not disturb it', async () => {
    // Section 9: neither session type grants access to the other's routes. The staff session stays
    // valid for the staff route — a refusal is a decision about one request, not a revocation.
    await createStaffUser({ email: STAFF_EMAIL, passwordHash: await hashPassword(STAFF_PASSWORD) });

    const agent = request.agent(createApp());
    await agent
      .post('/api/staff/login')
      .send({ email: STAFF_EMAIL, password: STAFF_PASSWORD })
      .expect(200);

    const refused = await agent.get('/api/student/draft').expect(401);
    expect(refused.body).toEqual({ error: 'Authentication required' });
  });

  it('rejects a forged student cookie that was never signed', async () => {
    const cohort = await createCohort({ code: COHORT_CODE });
    await createSubmission(cohort.id, {
      rollNumberRaw: '2021-001',
      rollNumberNormalized: '2021-001',
      studentName: 'Alice Example',
    });

    // The cookie payload is readable, so minting one that names a real submission must be worth
    // exactly as much as sending nothing at all.
    const forged = Buffer.from(
      JSON.stringify({ submissionId: 'anything-at-all' }),
    ).toString('base64');

    await request(createApp())
      .get('/api/student/draft')
      .set('Cookie', `lexora_student_session=${forged}`)
      .expect(401);
  });

  it('refuses a session naming a submission that no longer exists', async () => {
    // Verification issues the session, then the row disappears underneath it. Nothing in this
    // system deletes submissions, so this is an integrity anomaly rather than a client error —
    // but the remedy is the one for holding no session, so it is answered the same way.
    await createCohort({ code: COHORT_CODE });
    const agent = await verifiedStudent();

    await prisma().submission.deleteMany();

    await agent.get('/api/student/draft').expect(401, { error: 'Authentication required' });
  });
});

/**
 * A complete set of answers for the real content: every question answered correctly, a Writing
 * response with something in it, and a scale response for every Student Problems statement.
 *
 * Built from the bundle rather than written out, so this cannot silently become incomplete when the
 * content changes — a hardcoded answer set would start failing these tests for the wrong reason.
 */
function completeAnswers(): DraftAnswers {
  const content = getContentLoader().getContent('v1');
  const answerKey = (questions: { id: string; correctAnswer: string }[]) =>
    Object.fromEntries(questions.map((question) => [question.id, question.correctAnswer]));

  return {
    grammar: answerKey(content.grammar.questions),
    vocabulary: answerKey(content.vocabulary.questions),
    reading: answerKey(content.reading.passages.flatMap((passage) => passage.questions)),
    writing: { essayText: 'Learning a language rewards patience more than talent.' },
    studentProblems: {
      likertAnswers: Object.fromEntries(
        content.studentProblems.statements.map((statement) => [statement.id, 5]),
      ),
      openText: 'أجد صعوبة في التحدث أمام زملائي.',
    },
  };
}

/** A cohort, a draft in it, and a verified session for that draft. */
async function draftWithSession(answers: DraftAnswers = completeAnswers()) {
  const cohort = await createCohort({ code: COHORT_CODE });
  const submission = await createSubmission(cohort.id, {
    rollNumberRaw: '2021-001',
    rollNumberNormalized: '2021-001',
    studentName: 'Alice Example',
    contentVersion: 'v1',
    answers,
  });

  return { submission, agent: await verifiedStudent() };
}

describe('POST /api/student/submit', () => {
  it('submits a complete assessment and answers with the report', async () => {
    const { submission, agent } = await draftWithSession();

    const response = await agent.post('/api/student/submit').expect(200);

    expect(response.body.contentVersion).toBe('v1');
    expect(response.body.submittedAt).toEqual(expect.any(String));
    expect((await prisma().submission.findUniqueOrThrow({ where: { id: submission.id } })).status)
      .toBe('submitted');
  });

  it('returns the deterministic results immediately, with writing still pending', async () => {
    // The requirement this endpoint exists for (FR-FEEDBACK-001): the section scores and the
    // per-question explanations are in the submit response itself, computed synchronously, with no
    // AI call made and none waited on. `writingStatus: 'pending'` is the honest state at that
    // moment — the job has been enqueued and nothing has run it yet.
    const content = getContentLoader().getContent('v1');
    const { agent } = await draftWithSession();

    const response = await agent.post('/api/student/submit').expect(200);

    expect(response.body.writingStatus).toBe('pending');
    expect(response.body.problemsTextStatus).toBe('pending');

    // Every question was answered correctly, so each section is at full marks — and the maximum
    // comes from content, so this cannot pass by counting a hardcoded question total.
    const grammar = content.grammar.questions;
    expect(response.body.deterministic.grammar.score).toBe(
      grammar.reduce((total, question) => total + question.points, 0),
    );
    expect(response.body.deterministic.grammar.questions).toHaveLength(grammar.length);
    expect(response.body.deterministic.reading.questions).toHaveLength(
      content.reading.passages.flatMap((passage) => passage.questions).length,
    );
  });

  it('carries the prewritten explanation for each question', async () => {
    // FR-DET-004. The explanation is the content's own text, resolved through the submission's
    // frozen version — not generated, and not read back from anywhere.
    const content = getContentLoader().getContent('v1');
    const { agent } = await draftWithSession();

    const response = await agent.post('/api/student/submit').expect(200);

    const firstQuestion = content.grammar.questions[0];
    const scored = response.body.deterministic.grammar.questions.find(
      (outcome: { questionId: string }) => outcome.questionId === firstQuestion?.id,
    );

    expect(scored).toMatchObject({
      givenAnswer: firstQuestion?.correctAnswer,
      correctAnswer: firstQuestion?.correctAnswer,
      correct: true,
      explanation: firstQuestion?.explanation,
    });
  });

  it('records the submission so a later read sees it as submitted', async () => {
    const { submission, agent } = await draftWithSession();

    await agent.post('/api/student/submit').expect(200);

    const stored = await prisma().submission.findUniqueOrThrow({ where: { id: submission.id } });
    expect(stored.status).toBe('submitted');
    expect(stored.submittedAt).toBeInstanceOf(Date);
    expect(stored.problemsOpenTextOriginal).toBe('أجد صعوبة في التحدث أمام زملائي.');
    expect(
      await prisma().processingJob.count({ where: { submissionId: submission.id } }),
    ).toBe(2);

    const draft = await agent.get('/api/student/draft').expect(200);
    expect(draft.body.status).toBe('submitted');
  });

  it('agrees with the score columns it wrote', async () => {
    // The report recomputes the deterministic sections instead of reading the columns, because it
    // needs the per-question explanations and those are not stored. Scoring is a pure function, so
    // the two must be equal — this is the assertion that keeps "one number, two sources" honest.
    const { submission, agent } = await draftWithSession();

    const response = await agent.post('/api/student/submit').expect(200);
    const stored = await prisma().submission.findUniqueOrThrow({ where: { id: submission.id } });

    expect(response.body.deterministic.grammar.score).toBe(stored.grammarScore);
    expect(response.body.deterministic.vocabulary.score).toBe(stored.vocabularyScore);
    expect(response.body.deterministic.reading.score).toBe(stored.readingScore);
  });

  it('treats a second submit as success and answers with the same report', async () => {
    // Section 11: a double-clicked submit is "treated as success — the existing report is returned,
    // not an error". A student who clicks twice must not be shown a failure for it.
    const { agent } = await draftWithSession();

    const first = await agent.post('/api/student/submit').expect(200);
    const second = await agent.post('/api/student/submit').expect(200);

    expect(second.body).toEqual(first.body);
  });

  it('does not enqueue a second round of jobs on a repeated submit', async () => {
    const { submission, agent } = await draftWithSession();

    await agent.post('/api/student/submit').expect(200);
    await agent.post('/api/student/submit').expect(200);

    expect(
      await prisma().processingJob.count({ where: { submissionId: submission.id } }),
    ).toBe(2);
  });

  it('refuses an unfinished assessment and names the sections that are not done', async () => {
    // The server rule is authoritative (FR-ASSESS-007). The client gates its button on the same
    // rule, so this refusal is for the stale tab or the client bug — but it still has to say which
    // sections, which is the whole point of the server owning the rule.
    const answers = completeAnswers();
    delete answers.reading;
    const { submission, agent } = await draftWithSession(answers);

    const response = await agent.post('/api/student/submit').expect(400);

    expect(response.body.incompleteSections).toEqual(['reading']);
    expect(response.body.error).toEqual(expect.any(String));

    // And the refusal left the draft a draft: still editable, nothing scored, no jobs enqueued.
    const stored = await prisma().submission.findUniqueOrThrow({ where: { id: submission.id } });
    expect(stored.status).toBe('draft');
    expect(stored.submittedAt).toBeNull();
    expect(stored.grammarScore).toBeNull();
    expect(await prisma().processingJob.count({ where: { submissionId: submission.id } })).toBe(0);

    await agent
      .patch('/api/student/draft')
      .send({ section: 'reading', sectionAnswers: { 'reading-001': 'b' } })
      .expect(200);
  });

  it('never requires the open-ended Student Problems answer', async () => {
    const answers = completeAnswers();
    const studentProblems = { ...answers.studentProblems, openText: '' };
    const { agent } = await draftWithSession({ ...answers, studentProblems });

    const response = await agent.post('/api/student/submit').expect(200);

    expect(response.body.problemsTextStatus).toBe('not_applicable');
    expect(response.body.deterministic.grammar.score).toBeGreaterThan(0);
  });

  it('reads the session submission and has no field to point at another', async () => {
    // NFR-SEC-009's shape on a write path. The route reads no body at all, so a name for someone
    // else's submission has nowhere to land — there is nothing to defeat rather than a check to
    // pass.
    const cohort = await createCohort({ code: COHORT_CODE });
    const mine = await createSubmission(cohort.id, {
      rollNumberRaw: '2021-001',
      rollNumberNormalized: '2021-001',
      studentName: 'Alice Example',
      contentVersion: 'v1',
      answers: completeAnswers(),
    });
    const theirs = await createSubmission(cohort.id, {
      rollNumberRaw: '2021-002',
      rollNumberNormalized: '2021-002',
      studentName: 'Bob Example',
      contentVersion: 'v1',
      answers: completeAnswers(),
    });

    await (await verifiedStudent())
      .post('/api/student/submit')
      .send({ submissionId: theirs.id })
      .expect(200);

    expect((await prisma().submission.findUniqueOrThrow({ where: { id: mine.id } })).status).toBe(
      'submitted',
    );
    expect((await prisma().submission.findUniqueOrThrow({ where: { id: theirs.id } })).status).toBe(
      'draft',
    );
  });

  it('rejects a request carrying no student session', async () => {
    await request(createApp())
      .post('/api/student/submit')
      .expect(401, { error: 'Authentication required' });
  });

  it('rejects a staff session', async () => {
    // Section 9: neither session type grants access to the other's routes.
    await createStaffUser({ email: STAFF_EMAIL, passwordHash: await hashPassword(STAFF_PASSWORD) });

    const agent = request.agent(createApp());
    await agent
      .post('/api/staff/login')
      .send({ email: STAFF_EMAIL, password: STAFF_PASSWORD })
      .expect(200);

    await agent.post('/api/student/submit').expect(401, { error: 'Authentication required' });
  });

  it('refuses a session naming a submission that no longer exists', async () => {
    await createCohort({ code: COHORT_CODE });
    const agent = await verifiedStudent();

    await prisma().submission.deleteMany();

    await agent.post('/api/student/submit').expect(401, { error: 'Authentication required' });
  });

  it('leaves the submitted record unwritable afterwards', async () => {
    // FR-ASSESS-008 end to end: once submitted, the assessment cannot be edited, restarted, or
    // retaken. The autosave route is the way back in, and it must refuse.
    const { agent } = await draftWithSession();

    await agent.post('/api/student/submit').expect(200);

    const refused = await agent
      .patch('/api/student/draft')
      .send({ section: 'grammar', sectionAnswers: { 'grammar-001': 'a' } })
      .expect(409);

    expect(refused.body.error).toContain('already been submitted');
  });
});

describe('GET /api/student/report', () => {
  it('has the deterministic results ready immediately after submitting', async () => {
    // FR-FEEDBACK-001: no AI call is made, none is waited on, and none is needed — the scores and
    // explanations are already in the response.
    const content = getContentLoader().getContent('v1');
    const { agent } = await draftWithSession();

    await agent.post('/api/student/submit').expect(200);
    const report = await agent.get('/api/student/report').expect(200);

    const grammar = content.grammar.questions;
    expect(report.body.deterministic.grammar.score).toBe(
      grammar.reduce((total, question) => total + question.points, 0),
    );
    expect(report.body.deterministic.grammar.questions).toHaveLength(grammar.length);
    expect(report.body.deterministic.vocabulary.questions.length).toBeGreaterThan(0);
    expect(report.body.deterministic.reading.questions.length).toBeGreaterThan(0);
  });

  it('reports writing as still being prepared, not as finished', async () => {
    // FR-FEEDBACK-004/008: the report must not imply it is complete. `pending` is what the page
    // turns into that wording, and reaching `succeeded` is E7's job, not this endpoint's.
    const { agent } = await draftWithSession();

    await agent.post('/api/student/submit').expect(200);

    const report = await agent.get('/api/student/report').expect(200);
    expect(report.body.writingStatus).toBe('pending');
    expect(report.body.problemsTextStatus).toBe('pending');
  });

  it('carries each question’s prewritten explanation, including for a wrong answer', async () => {
    // FR-DET-004 — the explanation is shown per question, and a student who answered incorrectly is
    // exactly who needs it. The answer key is never sent before submission; here, after it, the
    // student's own answer and the explanation are both theirs to see.
    const content = getContentLoader().getContent('v1');
    const firstQuestion = content.grammar.questions[0];
    const answers = completeAnswers();
    const wrongAnswer = firstQuestion?.options?.find(
      (option) => option.id !== firstQuestion.correctAnswer,
    )?.id;

    const { agent } = await draftWithSession({
      ...answers,
      grammar: { ...answers.grammar, [firstQuestion?.id ?? '']: wrongAnswer ?? 'a' },
    });

    await agent.post('/api/student/submit').expect(200);
    const report = await agent.get('/api/student/report').expect(200);

    const scored = report.body.deterministic.grammar.questions.find(
      (outcome: { questionId: string }) => outcome.questionId === firstQuestion?.id,
    );

    expect(scored).toMatchObject({
      correct: false,
      givenAnswer: wrongAnswer,
      correctAnswer: firstQuestion?.correctAnswer,
      explanation: firstQuestion?.explanation,
    });
  });

  it('carries the question and the chosen answer’s text, so the report is readable', async () => {
    // An explanation is only useful beside the question it explains, and "you chose b" is not an
    // answer a student can read. The route joins scoring's outcome with the content bundle's text,
    // which is why the report carries both the ids and their text.
    const content = getContentLoader().getContent('v1');
    const firstQuestion = content.grammar.questions[0];
    const chosenOption = firstQuestion?.options?.[1];

    const answers = completeAnswers();
    const { agent } = await draftWithSession({
      ...answers,
      grammar: { ...answers.grammar, [firstQuestion?.id ?? '']: chosenOption?.id ?? 'a' },
    });

    await agent.post('/api/student/submit').expect(200);
    const report = await agent.get('/api/student/report').expect(200);

    expect(report.body.deterministic.grammar.title).toBe(content.grammar.title);

    const scored = report.body.deterministic.grammar.questions[0];
    expect(scored).toEqual({
      questionId: firstQuestion?.id,
      prompt: firstQuestion?.prompt,
      givenAnswer: chosenOption?.id,
      givenAnswerText: chosenOption?.text,
      correctAnswer: firstQuestion?.correctAnswer,
      correctAnswerText: firstQuestion?.options?.find(
        (option) => option.id === firstQuestion.correctAnswer,
      )?.text,
      correct: chosenOption?.id === firstQuestion?.correctAnswer,
      explanation: firstQuestion?.explanation,
    });
  });

  it('shows every question in the section, in the order the assessment presented them', async () => {
    const content = getContentLoader().getContent('v1');
    const { agent } = await draftWithSession();

    await agent.post('/api/student/submit').expect(200);
    const report = await agent.get('/api/student/report').expect(200);

    expect(
      report.body.deterministic.grammar.questions.map((question: { questionId: string }) => question.questionId),
    ).toEqual(content.grammar.questions.map((question) => question.id));

    // Reading's questions are gathered across its passages, and so is the report's list.
    expect(
      report.body.deterministic.reading.questions.map((question: { questionId: string }) => question.questionId),
    ).toEqual(content.reading.passages.flatMap((passage) => passage.questions).map((q) => q.id));
  });

  it('shows a stored answer that names no option rather than showing nothing', async () => {
    // The autosave schema accepts any string as a choice answer, so this is a stored state the
    // report can be asked about. It has no option text — and the report says what is actually
    // stored instead of rendering a blank where the answer goes.
    const content = getContentLoader().getContent('v1');
    const firstQuestion = content.grammar.questions[0];
    const answers = completeAnswers();

    const cohort = await createCohort({ code: COHORT_CODE });
    await createSubmission(cohort.id, {
      rollNumberRaw: '2021-001',
      rollNumberNormalized: '2021-001',
      studentName: 'Alice Example',
      contentVersion: 'v1',
      status: 'submitted',
      answers: { ...answers, grammar: { ...answers.grammar, [firstQuestion?.id ?? '']: 'not-an-option' } },
    });

    const report = await (await verifiedStudent()).get('/api/student/report').expect(200);
    const scored = report.body.deterministic.grammar.questions[0];

    expect(scored).toMatchObject({
      givenAnswer: 'not-an-option',
      givenAnswerText: null,
      correct: false,
    });
  });

  it('describes a question the stored answers do not cover as not answered', async () => {
    // Not reachable by submitting — completeness requires every deterministic question to carry an
    // answer — so this row is written directly. The report still has to describe it, because the
    // report describes what is stored: a question with no stored answer is "not answered", which is
    // a different thing from a blank answer, and the page renders the two differently.
    const content = getContentLoader().getContent('v1');
    const firstQuestion = content.grammar.questions[0];
    const answers = completeAnswers();
    const grammar = { ...answers.grammar };
    delete grammar[firstQuestion?.id ?? ''];

    const cohort = await createCohort({ code: COHORT_CODE });
    await createSubmission(cohort.id, {
      rollNumberRaw: '2021-001',
      rollNumberNormalized: '2021-001',
      studentName: 'Alice Example',
      contentVersion: 'v1',
      status: 'submitted',
      answers: { ...answers, grammar },
    });

    const report = await (await verifiedStudent()).get('/api/student/report').expect(200);
    const scored = report.body.deterministic.grammar.questions.find(
      (outcome: { questionId: string }) => outcome.questionId === firstQuestion?.id,
    );

    expect(scored).toMatchObject({
      givenAnswer: null,
      correct: false,
      explanation: firstQuestion?.explanation,
    });
  });

  it('is the same report a returning student sees', async () => {
    // FR-FEEDBACK-005: the report is a read of stored state, not a response to having just
    // submitted. A student who comes back tomorrow gets the identical thing.
    const { agent } = await draftWithSession();

    const submitted = await agent.post('/api/student/submit').expect(200);

    // A fresh session, obtained the only way one can be — by verifying the identity again.
    const returning = await (await verifiedStudent()).get('/api/student/report').expect(200);

    expect(returning.body).toEqual(submitted.body);
  });

  it('refuses a report for an assessment that has not been submitted', async () => {
    // PRD Section 13: a draft is "not a 'result' state". Serving scores here would let a student
    // read their marks before the transition that makes them final.
    const { submission, agent } = await draftWithSession();

    const refused = await agent.get('/api/student/report').expect(409);

    expect(refused.body.error).toContain('has not been submitted');
    // The refusal must not carry results in its body.
    expect(refused.body).not.toHaveProperty('deterministic');
    expect(refused.body).not.toHaveProperty('incompleteSections');
    expect((await prisma().submission.findUniqueOrThrow({ where: { id: submission.id } })).status)
      .toBe('draft');
  });

  it('reads the session submission and has no field to point at another', async () => {
    const cohort = await createCohort({ code: COHORT_CODE });
    await createSubmission(cohort.id, {
      rollNumberRaw: '2021-001',
      rollNumberNormalized: '2021-001',
      studentName: 'Alice Example',
      contentVersion: 'v1',
      answers: completeAnswers(),
    });
    await createSubmission(cohort.id, {
      rollNumberRaw: '2021-002',
      rollNumberNormalized: '2021-002',
      studentName: 'Bob Example',
      contentVersion: 'v1',
      answers: completeAnswers(),
    });

    const alice = await verifiedStudent();
    const bob = await verifiedStudent({ rollNumber: '2021-002', studentName: 'Bob Example' });

    await alice.post('/api/student/submit').expect(200);

    // Bob has not submitted, so his report does not exist — and Alice's is not reachable through
    // his session whatever he asks for.
    await bob.get('/api/student/report').expect(409);
    await bob.get(`/api/student/report?submissionId=${(await prisma().submission.findFirstOrThrow({ where: { studentName: 'Alice Example' } })).id}`)
      .expect(409);

    const aliceReport = await alice.get('/api/student/report').expect(200);
    expect(aliceReport.body.deterministic.grammar.score).toBeGreaterThan(0);
  });

  it('rejects a request carrying no student session', async () => {
    await request(createApp())
      .get('/api/student/report')
      .expect(401, { error: 'Authentication required' });
  });

  it('rejects a staff session', async () => {
    await createStaffUser({ email: STAFF_EMAIL, passwordHash: await hashPassword(STAFF_PASSWORD) });

    const agent = request.agent(createApp());
    await agent
      .post('/api/staff/login')
      .send({ email: STAFF_EMAIL, password: STAFF_PASSWORD })
      .expect(200);

    await agent.get('/api/student/report').expect(401, { error: 'Authentication required' });
  });

  it('refuses a session naming a submission that no longer exists', async () => {
    await createCohort({ code: COHORT_CODE });
    const agent = await verifiedStudent();

    await prisma().submission.deleteMany();

    await agent.get('/api/student/report').expect(401, { error: 'Authentication required' });
  });

  it('does not leak an answer key into a refusal', async () => {
    // A refused request is where a careless implementation would put the data it was about to send.
    const { agent } = await draftWithSession();

    const refused = await agent.get('/api/student/report').expect(409);

    expect(JSON.stringify(refused.body)).not.toContain('correctAnswer');
    expect(JSON.stringify(refused.body)).not.toContain('explanation');
  });

  it('answers with nothing that identifies the submission', async () => {
    // NFR-SEC-009 again, on the read path: the report names no id, so there is nothing in it to
    // learn about another student even if it were somehow shared.
    const { submission, agent } = await draftWithSession();

    await agent.post('/api/student/submit').expect(200);
    const report = await agent.get('/api/student/report').expect(200);

    expect(JSON.stringify(report.body)).not.toContain(submission.id);
    expect(report.body).not.toHaveProperty('id');
    expect(report.body).not.toHaveProperty('submissionId');
    expect(report.body).not.toHaveProperty('studentName');
    expect(report.body).not.toHaveProperty('rollNumber');
  });
});

describe('A returning student (T5.3.3)', () => {
  /**
   * Everything a student who has already finished can do.
   *
   * PRD Section 8.2 and FR-STU-006: re-entering their details must show the saved report and must
   * not offer a new attempt — the student "cannot edit, restart, or resubmit". Those are three
   * refusals from three different places: the autosave route's `status='draft'` predicate, the
   * status the draft endpoint reports, and `finalize`'s idempotent no-op. Each is asserted against
   * the route that owns it rather than inferred from one of them.
   *
   * ## Why these two tests and not six
   *
   * `student-verify` is rate-limited per IP (T3.3.3), and the limit is real for the whole file — a
   * suite that verifies an identity once per assertion would exhaust the budget and start failing
   * with 429s that have nothing to do with what it is testing. Neither the limit nor its assertions
   * are weakened here; the tests are grouped so each session is obtained once and then exercised,
   * which is also closer to what a returning student actually does.
   */
  it('re-verifying the identity reports the submission as submitted, not a new draft', async () => {
    const { agent: firstVisit } = await draftWithSession();
    await firstVisit.post('/api/student/submit').expect(200);

    // The return visit: the details are entered again, which is the only way back in (Section 9).
    const verify = await request(createApp())
      .post('/api/session/student-verify')
      .send({ cohortCode: COHORT_CODE, rollNumber: '2021-001', studentName: 'Alice Example' })
      .expect(200);

    // This is what `EntryPage` routes on — `draft` sends the student into the assessment,
    // `submitted` sends them to their report (FR-STU-006). Anything but `submitted` here and a
    // finished student is offered a second attempt.
    expect(verify.body).toEqual({ status: 'submitted' });
    expect(await prisma().submission.count()).toBe(1);
  });

  it('sees the saved report, and can neither edit, restart, nor resubmit', async () => {
    const { submission, agent } = await draftWithSession();
    const submitted = await agent.post('/api/student/submit').expect(200);
    const finalized = await prisma().submission.findUniqueOrThrow({ where: { id: submission.id } });

    // Back for another visit, with the session the student already holds.
    const report = await agent.get('/api/student/report').expect(200);
    expect(report.body).toEqual(submitted.body);
    expect(report.body.deterministic.grammar.questions.length).toBeGreaterThan(0);

    // Cannot restart: `/assessment` routes a submitted student onward on this status (Section 9).
    const draft = await agent.get('/api/student/draft').expect(200);
    expect(draft.body.status).toBe('submitted');

    // Cannot edit.
    const refused = await agent
      .patch('/api/student/draft')
      .send({ section: 'grammar', sectionAnswers: { 'grammar-001': 'a' } })
      .expect(409);
    expect(refused.body.error).toContain('already been submitted');

    // Cannot resubmit into a second attempt: the same report comes back, and nothing is re-enqueued.
    const again = await agent.post('/api/student/submit').expect(200);
    expect(again.body).toEqual(submitted.body);

    // The strongest form of "no new attempt": the row is byte-for-byte the one that was finalized,
    // and the two jobs enqueued at submission are still the only two.
    expect(await prisma().submission.count()).toBe(1);
    expect(await prisma().processingJob.count()).toBe(2);
    expect(await prisma().submission.findUniqueOrThrow({ where: { id: submission.id } })).toEqual(
      finalized,
    );
  });
});
