import { OwnProfileChangeSchema, ProfileChangeReviewSchema } from '@ftms/core';
import request from 'supertest';
import { BackgroundTasks } from '../src/common/background-tasks.service';
import { PrismaService } from '../src/prisma/prisma.service';
import {
  bearer,
  bootTestApp,
  createStudentRecord,
  createUser,
  login,
  type Mailbox,
  recordOf,
  resetDatabase,
  type SeededUser,
  type TestApp,
} from './helpers/test-app';

describe('Profile management and protected changes (§4.4)', () => {
  let app: TestApp;
  let mailbox: Mailbox;
  let prisma: PrismaService;
  let student: SeededUser;
  let studentToken: string;
  let recordId: string;
  let reviewer: { id: string; token: string };
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    ({ app, mailbox } = await bootTestApp());
    prisma = app.get(PrismaService);
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(async () => {
    await resetDatabase(app);
    mailbox.clear();
    student = await createUser(app, 'STUDENT', { seatNumber: 'P-100' });
    studentToken = (await login(app, student.email, student.password!)).accessToken;
    recordId = await recordOf(app, student.id);
    await prisma.studentProfile.update({
      where: { id: recordId },
      data: {
        firstName: 'محمد',
        fatherName: 'أحمد',
        grandfatherName: 'علي',
        familyName: 'حسن',
        fullName: 'محمد أحمد علي حسن',
      },
    });
    const f = await createUser(app, 'FACULTY');
    reviewer = { id: f.id, token: (await login(app, f.email, f.password!)).accessToken };
  });

  const submit = (body: object, token = studentToken) =>
    http().post('/me/profile-changes').set(bearer(token)).send(body);

  it('permitted fields change directly; identity fields cannot be changed that way', async () => {
    const res = await http()
      .patch('/me/student')
      .set(bearer(studentToken))
      .send({ phone: '٠١١ ٢٢٣٣ ٤٤٥٥', seatNumber: 'HACK-1', fullName: 'Someone Else' })
      .expect(200);
    expect(res.body).toMatchObject({
      phone: '01122334455',
      seatNumber: 'P-100',
      fullName: 'محمد أحمد علي حسن',
    });
    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { action: 'student.profile_updated_by_student' },
    });
    expect(audit).toMatchObject({
      actorId: student.id,
      before: { phone: null },
      after: { phone: '01122334455' },
    });
  });

  it('approval applies the change atomically and syncs the account name; history is kept', async () => {
    const created = OwnProfileChangeSchema.parse(
      (await submit({ familyName: 'حسين', note: 'Family name misspelled on import' }).expect(201))
        .body,
    );
    expect(created).toMatchObject({
      status: 'PENDING',
      changes: [{ field: 'familyName', from: 'حسن', to: 'حسين' }],
    });
    // Nothing changed yet.
    expect(
      (await prisma.studentProfile.findUniqueOrThrow({ where: { id: recordId } })).familyName,
    ).toBe('حسن');

    const second = await submit({ firstName: 'محمود', note: 'another change' }).expect(409);
    expect(second.body.code).toBe('PROFILE_CHANGE_PENDING');

    const queue = (
      await http().get('/profile-changes?status=PENDING').set(bearer(reviewer.token)).expect(200)
    ).body;
    expect(queue.items).toHaveLength(1);
    const approved = ProfileChangeReviewSchema.parse(
      (
        await http()
          .post(`/profile-changes/${created.id}/approve`)
          .set(bearer(reviewer.token))
          .send({ comment: 'Matches the registrar list' })
          .expect(200)
      ).body,
    );
    expect(approved).toMatchObject({ status: 'APPROVED', decidedBy: { name: expect.any(String) } });

    const record = await prisma.studentProfile.findUniqueOrThrow({
      where: { id: recordId },
      include: { user: true },
    });
    expect(record).toMatchObject({ familyName: 'حسين', fullName: 'محمد أحمد علي حسين' });
    expect(record.user?.displayName).toBe('محمد أحمد علي حسين');

    const mine = (await http().get('/me/profile-changes').set(bearer(studentToken)).expect(200))
      .body;
    expect(mine[0]).toMatchObject({
      status: 'APPROVED',
      changes: [{ field: 'familyName', from: 'حسن', to: 'حسين' }],
      decisionReason: 'Matches the registrar list',
    });
    // Students never learn who decided.
    expect(mine[0]).not.toHaveProperty('decidedBy');
    expect(JSON.stringify(mine)).not.toContain(reviewer.id);

    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { action: 'profile_change.approved' },
    });
    expect(audit).toMatchObject({
      actorId: reviewer.id,
      before: { familyName: 'حسن' },
      after: { familyName: 'حسين' },
    });
    await app.get(BackgroundTasks).drain();
    expect(mailbox.messages.find((m) => m.to === student.email)?.subject).toContain('approved');
  });

  it('rejection needs a reason, leaves the record unchanged, and allows a new request', async () => {
    const created = (
      await submit({ seatNumber: 'P-999', note: 'my seat number is wrong' }).expect(201)
    ).body;
    await http()
      .post(`/profile-changes/${created.id}/reject`)
      .set(bearer(reviewer.token))
      .send({})
      .expect(400);
    await http()
      .post(`/profile-changes/${created.id}/reject`)
      .set(bearer(reviewer.token))
      .send({ reason: 'Seat P-100 is correct on the official list' })
      .expect(200);
    expect(
      (await prisma.studentProfile.findUniqueOrThrow({ where: { id: recordId } })).seatNumber,
    ).toBe('P-100');
    const mine = (await http().get('/me/profile-changes').set(bearer(studentToken))).body;
    expect(mine[0]).toMatchObject({
      status: 'REJECTED',
      decisionReason: 'Seat P-100 is correct on the official list',
    });
    await submit({ grandfatherName: 'عليّ', note: 'diacritics' }).expect(201);
  });

  it('re-checks seat uniqueness at approval and keeps the request pending if taken', async () => {
    const created = (await submit({ seatNumber: 'P-200', note: 'correct seat' }).expect(201)).body;
    await createStudentRecord(app, { seatNumber: 'P-200' });
    const res = await http()
      .post(`/profile-changes/${created.id}/approve`)
      .set(bearer(reviewer.token))
      .send({})
      .expect(409);
    expect(res.body.code).toBe('SEAT_NUMBER_ALREADY_EXISTS');
    expect(
      (await prisma.profileChangeRequest.findUniqueOrThrow({ where: { id: created.id } })).status,
    ).toBe('PENDING');
  });

  it('students cancel only their own requests; nothing-to-change is refused', async () => {
    const nothing = await submit({ familyName: 'حسن', note: 'same as now' }).expect(409);
    expect(nothing.body.code).toBe('NO_CHANGES');
    const created = (await submit({ familyName: 'حسين', note: 'typo' }).expect(201)).body;
    const other = await createUser(app, 'STUDENT');
    const otherToken = (await login(app, other.email, other.password!)).accessToken;
    await http()
      .post(`/me/profile-changes/${created.id}/cancel`)
      .set(bearer(otherToken))
      .expect(404);
    const cancelled = await http()
      .post(`/me/profile-changes/${created.id}/cancel`)
      .set(bearer(studentToken))
      .expect(200);
    expect(cancelled.body.status).toBe('CANCELLED');
    await http()
      .post(`/profile-changes/${created.id}/approve`)
      .set(bearer(reviewer.token))
      .send({})
      .expect(409);
  });

  it('a record imported with only a full name needs all four parts in a name change', async () => {
    await prisma.studentProfile.update({
      where: { id: recordId },
      data: {
        firstName: null,
        fatherName: null,
        grandfatherName: null,
        familyName: null,
        fullName: 'محمد حسن',
      },
    });
    const res = await submit({ familyName: 'حسين', note: 'typo' }).expect(400);
    expect(res.body.details).toMatchObject({ firstName: ['NAME_REQUIRED'] });
    await submit({
      firstName: 'محمد',
      fatherName: 'أحمد',
      grandfatherName: 'علي',
      familyName: 'حسين',
      note: 'full name',
    }).expect(201);
  });

  it('reviewing needs profile_changes.decide; students cannot reach the queue', async () => {
    await http().get('/profile-changes').set(bearer(studentToken)).expect(403);
    const f = await createUser(app, 'FACULTY');
    const sa = await createUser(app, 'SUPER_ADMIN');
    const saToken = (await login(app, sa.email, sa.password!)).accessToken;
    await http()
      .put(`/admin/users/${f.id}/permissions`)
      .set(bearer(saToken))
      .send({
        grants: [{ permission: 'profile_changes.decide', effect: 'DENY' }],
        reason: 'not a reviewer',
      })
      .expect(200);
    const token = (await login(app, f.email, f.password!)).accessToken;
    const created = (await submit({ familyName: 'حسين', note: 'typo' }).expect(201)).body;
    await http()
      .post(`/profile-changes/${created.id}/approve`)
      .set(bearer(token))
      .send({})
      .expect(403);
  });
});
