import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../app.ts';
import { hashPassword } from '../auth/passwordHasher.ts';
import { getContentLoader } from '../content/ContentLoader.ts';
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
