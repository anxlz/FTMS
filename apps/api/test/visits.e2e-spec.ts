import {
  CalendarResponseSchema,
  ListNotificationsResponseSchema,
  PROGRAM_TIME_ZONE,
  ProgramSchema,
  ProgramStateSchema,
  SettingsChangeSchema,
  utcToZoned,
  VisitDetailSchema,
  VisitHistoryEntrySchema,
  VisitMutationResultSchema,
} from '@ftms/core';
import request from 'supertest';
import { z } from 'zod';
import { BackgroundTasks } from '../src/common/background-tasks.service';
import { PrismaService } from '../src/prisma/prisma.service';
import {
  addToGroup,
  bearer,
  bootTestApp,
  cairoDate,
  createGroup,
  createProgram,
  createStudentRecord,
  createUser,
  createVisit,
  login,
  recordOf,
  resetDatabase,
  type SeededUser,
  type TestApp,
} from './helpers/test-app';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);
const PDF = Buffer.from('%PDF-1.4\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n');

describe('Visits, calendars and notifications (§6, §8.1, §11, §12)', () => {
  let app: TestApp;
  let prisma: PrismaService;
  const http = () => request(app.getHttpServer());

  let director: SeededUser;
  let faculty: SeededUser;
  let directorToken: string;
  let facultyToken: string;

  beforeAll(async () => {
    ({ app } = await bootTestApp());
    prisma = app.get(PrismaService);
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(async () => {
    await resetDatabase(app);
    director = await createUser(app, 'TRAINING_DIRECTOR');
    faculty = await createUser(app, 'FACULTY');
    directorToken = (await login(app, director.email, director.password!)).accessToken;
    facultyToken = (await login(app, faculty.email, faculty.password!)).accessToken;
  });

  /** A signed-in student whose record is in `groupId`. */
  async function studentIn(groupId: string): Promise<{ user: SeededUser; token: string }> {
    const user = await createUser(app, 'STUDENT');
    await addToGroup(app, await recordOf(app, user.id), groupId);
    return { user, token: (await login(app, user.email, user.password!)).accessToken };
  }

  const range = `from=${cairoDate(-7)}&to=${cairoDate(60)}`;

  async function calendarOf(token: string, query = range) {
    const res = await http().get(`/calendar?${query}`).set(bearer(token)).expect(200);
    return CalendarResponseSchema.parse(res.body);
  }

  async function notificationsOf(token: string) {
    const res = await http().get('/notifications').set(bearer(token)).expect(200);
    return ListNotificationsResponseSchema.parse(res.body);
  }

  async function newVisit(groupIds: string[], extra: Record<string, unknown> = {}) {
    const res = await http()
      .post('/visits')
      .set(bearer(facultyToken))
      .send({
        title: 'زيارة مزرعة الخضر',
        date: cairoDate(7),
        startTime: '10:00',
        endTime: '12:00',
        groupIds,
        ...extra,
      })
      .expect(201);
    return VisitMutationResultSchema.parse(res.body);
  }

  /* ─────────────────────────── Definition of Done ─────────────────────────── */

  it('DoD: a visit for groups A and B reaches their students only — never group C', async () => {
    await createProgram(app);
    const a = await createGroup(app, 'A');
    const b = await createGroup(app, 'B');
    const c = await createGroup(app, 'C');
    const inA = await studentIn(a.id);
    const inB = await studentIn(b.id);
    const inC = await studentIn(c.id);
    // A record without an account in A: nobody to notify, nothing breaks.
    await addToGroup(app, (await createStudentRecord(app)).id, a.id);

    const created = await newVisit([a.id, b.id], {
      description: 'Bring boots and a notebook.',
      location: {
        name: 'Shalaqan farm',
        latitude: 30.11,
        longitude: 31.24,
        mapUrl: 'https://maps.google.com/?q=30.11,31.24',
      },
    });
    const visitId = created.visit.id;
    expect(created.notified).toBe(2);
    expect(created.visit.groups.map((g) => g.name)).toEqual(['A', 'B']);
    expect(created.visit.status).toBe('SCHEDULED');
    expect(created.visit.phase).toBe('UPCOMING');

    // Calendars: A and B see the visit; C does not.
    for (const s of [inA, inB]) {
      const calendar = await calendarOf(s.token);
      expect(calendar.visits.map((v) => v.id)).toEqual([visitId]);
    }
    const calendarC = await calendarOf(inC.token);
    expect(calendarC.group?.name).toBe('C');
    expect(calendarC.visits).toEqual([]);

    // Notification centers: one "new visit" for A and B, linking to the visit; none for C.
    for (const s of [inA, inB]) {
      const list = await notificationsOf(s.token);
      expect(list.unread).toBe(1);
      expect(list.items).toHaveLength(1);
      expect(list.items[0]).toMatchObject({
        type: 'visit.created',
        link: `/visits/${visitId}`,
        readAt: null,
        data: { visitId, title: 'زيارة مزرعة الخضر', date: cairoDate(7), startTime: '10:00' },
      });
    }
    const listC = await notificationsOf(inC.token);
    expect(listC).toMatchObject({ unread: 0, total: 0, items: [] });
    expect(await prisma.notification.count()).toBe(2);

    // Visit details: open to A and B; group C gets "not found", not "forbidden".
    const detail = VisitDetailSchema.parse(
      (await http().get(`/visits/${visitId}`).set(bearer(inA.token)).expect(200)).body,
    );
    expect(detail).toMatchObject({ locationName: 'Shalaqan farm', latitude: 30.11 });
    const denied = await http().get(`/visits/${visitId}`).set(bearer(inC.token)).expect(404);
    expect(denied.body.code).toBe('NOT_FOUND');

    // Staff calendar: everything, or one group.
    expect((await calendarOf(facultyToken)).visits).toHaveLength(1);
    expect((await calendarOf(facultyToken, `${range}&group=${c.id}`)).visits).toEqual([]);
    expect((await calendarOf(facultyToken, `${range}&group=${b.id}`)).visits).toHaveLength(1);

    // Audited with the full state.
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: 'visit.created' } });
    expect(audit).toMatchObject({ actorId: faculty.id, resourceId: visitId });
    expect(audit.after).toMatchObject({ groups: ['A', 'B'], status: 'SCHEDULED' });
  });

  it('stores the instant in UTC from the Cairo wall-clock time (§16.2)', async () => {
    await createProgram(app);
    const g = await createGroup(app);
    const { visit } = await newVisit([g.id], { startTime: '09:30', endTime: '11:00' });
    expect(utcToZoned(new Date(visit.startsAt), PROGRAM_TIME_ZONE)).toEqual({
      date: cairoDate(7),
      time: '09:30',
    });
    expect(utcToZoned(new Date(visit.endsAt!), PROGRAM_TIME_ZONE).time).toBe('11:00');
    // The check-in window follows from the visit's own timing.
    expect(Date.parse(visit.checkInOpensAt)).toBe(Date.parse(visit.startsAt) - 15 * 60_000);
    expect(Date.parse(visit.checkInClosesAt)).toBe(Date.parse(visit.startsAt) + 60 * 60_000);
  });

  /* ─────────────────────────── validation ─────────────────────────── */

  it('validates visits on the backend', async () => {
    const g = await createGroup(app);
    const noProgram = await http()
      .post('/visits')
      .set(bearer(facultyToken))
      .send({ title: 'Visit', date: cairoDate(7), startTime: '10:00', groupIds: [g.id] })
      .expect(409);
    expect(noProgram.body.code).toBe('PROGRAM_NOT_CONFIGURED');

    await createProgram(app);
    const archived = await createGroup(app);
    await prisma.trainingGroup.update({
      where: { id: archived.id },
      data: { archivedAt: new Date() },
    });
    const send = (body: Record<string, unknown>) =>
      http()
        .post('/visits')
        .set(bearer(facultyToken))
        .send({
          title: 'Visit',
          date: cairoDate(7),
          startTime: '10:00',
          groupIds: [g.id],
          ...body,
        });

    expect((await send({ date: cairoDate(-1) }).expect(400)).body.code).toBe('VISIT_IN_PAST');
    expect((await send({ date: cairoDate(400) }).expect(400)).body.code).toBe(
      'DATE_OUTSIDE_PROGRAM',
    );
    expect((await send({ groupIds: [] }).expect(400)).body.details).toEqual({
      groupIds: ['GROUPS_REQUIRED'],
    });
    expect((await send({ groupIds: [g.id, g.id] }).expect(400)).body.details).toEqual({
      groupIds: ['DUPLICATE_GROUP'],
    });
    expect((await send({ groupIds: [archived.id] }).expect(409)).body.code).toBe('GROUP_ARCHIVED');
    expect(
      (await send({ groupIds: ['0190a6f0-0000-7000-8000-00000000dead'] }).expect(400)).body.details,
    ).toEqual({ groupIds: ['GROUP_NOT_FOUND'] });
    expect((await send({ endTime: '09:00' }).expect(400)).body.details).toEqual({
      endTime: ['END_BEFORE_START'],
    });
    expect((await send({ date: '2026-02-30' }).expect(400)).body.details).toEqual({
      date: ['DATE_INVALID'],
    });
    expect((await send({ location: { latitude: 30 } }).expect(400)).body.code).toBe(
      'VALIDATION_FAILED',
    );
    expect(
      (await send({ location: { mapUrl: 'http://maps.example.com/x' } }).expect(400)).body.details,
    ).toEqual({ 'location.mapUrl': ['URL_INVALID'] });
    expect(await prisma.trainingVisit.count()).toBe(0);
  });

  /* ─────────────────────────── timing (§8.1) ─────────────────────────── */

  it('copies the defaults into each visit; changing defaults never rewrites existing visits', async () => {
    await createProgram(app);
    const g = await createGroup(app);
    const first = (await newVisit([g.id])).visit;
    expect(first.timing).toEqual({
      checkInOpensMinutes: 15,
      graceMinutes: 15,
      checkInClosesMinutes: 60,
    });
    expect(first.timingOverridden).toBe(false);

    await http()
      .patch('/program')
      .set(bearer(directorToken))
      .send({
        timing: { checkInOpensMinutes: 20, graceMinutes: 10, checkInClosesMinutes: 45 },
        reason: 'new faculty policy',
      })
      .expect(200);

    const again = VisitDetailSchema.parse(
      (await http().get(`/visits/${first.id}`).set(bearer(facultyToken)).expect(200)).body,
    );
    expect(again.timing.graceMinutes).toBe(15);
    const second = (await newVisit([g.id])).visit;
    expect(second.timing).toEqual({
      checkInOpensMinutes: 20,
      graceMinutes: 10,
      checkInClosesMinutes: 45,
    });

    // Explicitly adopting the new defaults is a visit change like any other.
    const adopted = VisitMutationResultSchema.parse(
      (
        await http()
          .patch(`/visits/${first.id}`)
          .set(bearer(facultyToken))
          .send({ timing: 'useDefaults' })
          .expect(200)
      ).body,
    );
    expect(adopted.visit.timing.graceMinutes).toBe(10);
    expect(adopted.visit.timingOverridden).toBe(false);
  });

  it('lets only holders of attendance.settings.visit override timing per visit', async () => {
    await createProgram(app);
    const g = await createGroup(app);
    const custom = { checkInOpensMinutes: 30, graceMinutes: 5, checkInClosesMinutes: 90 };
    const overridden = (await newVisit([g.id], { timing: custom })).visit;
    expect(overridden).toMatchObject({ timing: custom, timingOverridden: true });

    await prisma.userPermissionGrant.create({
      data: {
        userId: faculty.id,
        permissionKey: 'attendance.settings.visit',
        effect: 'DENY',
        reason: 'test',
      },
    });
    const denied = await http()
      .post('/visits')
      .set(bearer(facultyToken))
      .send({
        title: 'Visit',
        date: cairoDate(7),
        startTime: '10:00',
        groupIds: [g.id],
        timing: custom,
      })
      .expect(403);
    expect(denied.body.code).toBe('FORBIDDEN');
    // Without a timing override the same faculty member can still create visits.
    await http()
      .post('/visits')
      .set(bearer(facultyToken))
      .send({ title: 'Visit', date: cairoDate(7), startTime: '10:00', groupIds: [g.id] })
      .expect(201);
    const grace = await http()
      .post('/visits')
      .set(bearer(directorToken))
      .send({
        title: 'Visit',
        date: cairoDate(7),
        startTime: '10:00',
        groupIds: [g.id],
        timing: { checkInOpensMinutes: 15, graceMinutes: 90, checkInClosesMinutes: 60 },
      })
      .expect(400);
    expect(grace.body.details).toEqual({ 'timing.graceMinutes': ['GRACE_AFTER_CLOSE'] });
  });

  /* ─────────────────────────── changes (§6.5) ─────────────────────────── */

  it('notifies exactly the affected students of significant changes, and records history', async () => {
    await createProgram(app);
    const a = await createGroup(app, 'A');
    const b = await createGroup(app, 'B');
    const c = await createGroup(app, 'C');
    const inA = await studentIn(a.id);
    const inB = await studentIn(b.id);
    const inC = await studentIn(c.id);
    const { visit } = await newVisit([a.id, b.id]);
    await prisma.notification.deleteMany();

    // A title alone is not significant: nobody is notified.
    const renamed = VisitMutationResultSchema.parse(
      (
        await http()
          .patch(`/visits/${visit.id}`)
          .set(bearer(facultyToken))
          .send({ title: 'Greenhouse visit' })
          .expect(200)
      ).body,
    );
    expect(renamed.notified).toBe(0);

    // Reschedule + regroup: B stays (updated), A leaves (removed), C joins (new visit).
    const moved = VisitMutationResultSchema.parse(
      (
        await http()
          .patch(`/visits/${visit.id}`)
          .set(bearer(facultyToken))
          .send({ date: cairoDate(9), startTime: '11:00', groupIds: [b.id, c.id], reason: 'bus' })
          .expect(200)
      ).body,
    );
    expect(moved.notified).toBe(3);
    expect(moved.visit.groups.map((g) => g.name)).toEqual(['B', 'C']);

    const na = await notificationsOf(inA.token);
    const nb = await notificationsOf(inB.token);
    const nc = await notificationsOf(inC.token);
    expect(na.items.map((n) => n.type)).toEqual(['visit.removed']);
    expect(na.items[0]?.link).toBeNull();
    expect(nb.items.map((n) => n.type)).toEqual(['visit.updated']);
    expect(nb.items[0]?.data).toMatchObject({
      date: cairoDate(9),
      startTime: '11:00',
      changes: ['date', 'time'],
      previous: { date: cairoDate(7), startTime: '10:00' },
    });
    expect(nc.items.map((n) => n.type)).toEqual(['visit.created']);

    // Calendars follow the groups.
    expect((await calendarOf(inA.token)).visits).toEqual([]);
    expect((await calendarOf(inC.token)).visits.map((v) => v.date)).toEqual([cairoDate(9)]);

    // History: who, when, before/after.
    const history = z
      .array(VisitHistoryEntrySchema)
      .parse(
        (await http().get(`/visits/${visit.id}/history`).set(bearer(directorToken)).expect(200))
          .body,
      );
    expect(history.map((h) => h.action)).toEqual([
      'visit.created',
      'visit.updated',
      'visit.updated',
    ]);
    expect(history[2]).toMatchObject({
      reason: 'bus',
      before: { date: cairoDate(7), startTime: '10:00', groups: ['A', 'B'] },
      after: { date: cairoDate(9), startTime: '11:00', groups: ['B', 'C'] },
    });
    await http().get(`/visits/${visit.id}/history`).set(bearer(inB.token)).expect(403);
  });

  it('cancels with a reason — the visit stays visible — and restores', async () => {
    await createProgram(app);
    const a = await createGroup(app);
    const inA = await studentIn(a.id);
    const { visit } = await newVisit([a.id]);

    const missingReason = await http()
      .post(`/visits/${visit.id}/cancel`)
      .set(bearer(facultyToken))
      .send({})
      .expect(400);
    expect(missingReason.body.code).toBe('VALIDATION_FAILED');

    const cancelled = VisitMutationResultSchema.parse(
      (
        await http()
          .post(`/visits/${visit.id}/cancel`)
          .set(bearer(facultyToken))
          .send({ reason: 'Sandstorm warning' })
          .expect(200)
      ).body,
    );
    expect(cancelled).toMatchObject({
      notified: 1,
      visit: { status: 'CANCELLED', cancelReason: 'Sandstorm warning' },
    });
    const calendar = await calendarOf(inA.token);
    expect(calendar.visits).toHaveLength(1);
    expect(calendar.visits[0]).toMatchObject({
      status: 'CANCELLED',
      cancelReason: 'Sandstorm warning',
    });

    const twice = await http()
      .post(`/visits/${visit.id}/cancel`)
      .set(bearer(facultyToken))
      .send({ reason: 'again' })
      .expect(409);
    expect(twice.body.code).toBe('VISIT_CANCELLED');
    const edit = await http()
      .patch(`/visits/${visit.id}`)
      .set(bearer(facultyToken))
      .send({ title: 'x y' })
      .expect(409);
    expect(edit.body.code).toBe('VISIT_CANCELLED');

    const restored = VisitMutationResultSchema.parse(
      (
        await http()
          .post(`/visits/${visit.id}/restore`)
          .set(bearer(facultyToken))
          .send({})
          .expect(200)
      ).body,
    );
    expect(restored).toMatchObject({
      notified: 1,
      visit: { status: 'SCHEDULED', cancelReason: null },
    });
    const notRestorable = await http()
      .post(`/visits/${visit.id}/restore`)
      .set(bearer(facultyToken))
      .send({})
      .expect(409);
    expect(notRestorable.body.code).toBe('VISIT_NOT_CANCELLED');

    expect((await notificationsOf(inA.token)).items.map((n) => n.type)).toEqual([
      'visit.restored',
      'visit.cancelled',
      'visit.created',
    ]);
  });

  it('locks date, time, groups and timing once check-in opens; a finished visit is history', async () => {
    const program = await createProgram(app);
    const a = await createGroup(app);
    const b = await createGroup(app);
    const soon = utcToZoned(new Date(Date.now() + 10 * 60_000), PROGRAM_TIME_ZONE);
    const open = await createVisit(app, program.id, [a.id], {
      date: soon.date,
      startTime: soon.time,
    });
    const detail = VisitDetailSchema.parse(
      (await http().get(`/visits/${open.id}`).set(bearer(facultyToken)).expect(200)).body,
    );
    expect(detail.phase).toBe('CHECK_IN_OPEN');

    for (const change of [
      { date: cairoDate(8) },
      { startTime: '23:59' },
      { groupIds: [a.id, b.id] },
      { timing: { checkInOpensMinutes: 5, graceMinutes: 5, checkInClosesMinutes: 30 } },
    ]) {
      const res = await http()
        .patch(`/visits/${open.id}`)
        .set(bearer(directorToken))
        .send(change)
        .expect(409);
      expect(res.body.code).toBe('VISIT_ALREADY_HELD');
    }
    // Details that do not affect attendance can still be corrected; it can still be cancelled.
    await http()
      .patch(`/visits/${open.id}`)
      .set(bearer(facultyToken))
      .send({ title: 'Corrected title', location: { name: 'Gate 2' } })
      .expect(200);
    await http()
      .post(`/visits/${open.id}/cancel`)
      .set(bearer(facultyToken))
      .send({ reason: 'Bus broke down' })
      .expect(200);

    const finished = await createVisit(app, program.id, [a.id], { date: cairoDate(-3) });
    const late = await http()
      .post(`/visits/${finished.id}/cancel`)
      .set(bearer(facultyToken))
      .send({ reason: 'too late' })
      .expect(409);
    expect(late.body.code).toBe('VISIT_ALREADY_HELD');
  });

  /* ─────────────────────────── program settings (§11) ─────────────────────────── */

  it('configures the program once, with permissions split by field, and keeps its history', async () => {
    const empty = ProgramStateSchema.parse(
      (await http().get('/program').set(bearer(facultyToken)).expect(200)).body,
    );
    expect(empty.program).toBeNull();

    const body = {
      name: 'Summer field training',
      startDate: cairoDate(0),
      durationWeeks: 10,
      allowedAbsences: 3,
      timing: { checkInOpensMinutes: 10, graceMinutes: 20, checkInClosesMinutes: 50 },
    };
    await http().post('/program').set(bearer(facultyToken)).send(body).expect(403);
    const program = ProgramSchema.parse(
      (await http().post('/program').set(bearer(directorToken)).send(body).expect(201)).body,
    );
    // Nothing assumes 12 weeks or 2 absences: the stored values are used.
    expect(program).toMatchObject({
      durationWeeks: 10,
      allowedAbsences: 3,
      timeZone: 'Africa/Cairo',
    });
    expect(program.endDate).toBe(cairoDate(69));
    const again = await http().post('/program').set(bearer(directorToken)).send(body).expect(409);
    expect(again.body.code).toBe('PROGRAM_EXISTS');

    // A faculty member granted only the attendance defaults may change those — nothing else.
    await prisma.userPermissionGrant.create({
      data: {
        userId: faculty.id,
        permissionKey: 'attendance.settings.defaults',
        effect: 'ALLOW',
        reason: 'test',
      },
    });
    await http()
      .patch('/program')
      .set(bearer(facultyToken))
      .send({ durationWeeks: 12 })
      .expect(403);
    await http()
      .patch('/program')
      .set(bearer(facultyToken))
      .send({ allowedAbsences: 4, reason: 'committee decision' })
      .expect(200);
    await http()
      .patch('/program')
      .set(bearer(directorToken))
      .send({ durationWeeks: 12 })
      .expect(200);

    const history = z
      .array(SettingsChangeSchema)
      .parse((await http().get('/program/history').set(bearer(directorToken)).expect(200)).body);
    expect(history).toHaveLength(3);
    expect(history[1]).toMatchObject({
      action: 'program.updated',
      reason: 'committee decision',
      before: { allowedAbsences: 3 },
      after: { allowedAbsences: 4 },
    });
    expect(history[0]).toMatchObject({
      before: { durationWeeks: 10 },
      after: { durationWeeks: 12 },
    });
  });

  /* ─────────────────────────── files (§6.3, §16.3) ─────────────────────────── */

  it('keeps a cover photo and documents in private storage, behind signed links', async () => {
    await createProgram(app);
    const a = await createGroup(app);
    const c = await createGroup(app);
    const inA = await studentIn(a.id);
    const inC = await studentIn(c.id);
    const { visit } = await newVisit([a.id]);
    const upload = (kind: string, file: Buffer, name: string) =>
      http()
        .post(`/visits/${visit.id}/files`)
        .set(bearer(facultyToken))
        .field('kind', kind)
        .attach('file', file, name);

    const withCover = VisitDetailSchema.parse(
      (await upload('COVER', PNG, 'farm.png').expect(201)).body,
    );
    expect(withCover.cover).toMatchObject({ contentType: 'image/png', fileName: 'farm.png' });
    const withDoc = VisitDetailSchema.parse(
      (await upload('DOCUMENT', PDF, 'تعليمات الزيارة.pdf').expect(201)).body,
    );
    expect(withDoc.documents).toHaveLength(1);
    expect(withDoc.documents[0]).toMatchObject({
      fileName: 'تعليمات الزيارة.pdf',
      contentType: 'application/pdf',
    });

    // Content decides, not the name: a PDF is not a cover; text is not a document.
    expect((await upload('COVER', PDF, 'photo.png').expect(400)).body.code).toBe(
      'FILE_TYPE_NOT_ALLOWED',
    );
    expect(
      (await upload('DOCUMENT', Buffer.from('hello'), 'notes.pdf').expect(400)).body.code,
    ).toBe('FILE_TYPE_NOT_ALLOWED');
    const big = Buffer.concat([PDF, Buffer.alloc(4 * 1024 * 1024)]);
    expect((await upload('DOCUMENT', big, 'big.pdf').expect(413)).body.code).toBe('FILE_TOO_LARGE');

    // A new cover replaces the old one.
    const replaced = VisitDetailSchema.parse(
      (await upload('COVER', PNG, 'new.png').expect(201)).body,
    );
    expect(replaced.cover?.fileName).toBe('new.png');
    expect(await prisma.visitFile.count({ where: { kind: 'COVER' } })).toBe(1);

    // Students of the visit's group get working links; other groups see nothing.
    const seen = VisitDetailSchema.parse(
      (await http().get(`/visits/${visit.id}`).set(bearer(inA.token)).expect(200)).body,
    );
    const token = seen.documents[0]!.url.replace('/files/', '');
    const file = await http().get(`/local-files/${token}`).responseType('blob').expect(200);
    expect(file.headers['content-type']).toBe('application/pdf');
    expect(file.headers['content-disposition']).toContain('attachment');
    expect(
      Buffer.from(file.body as Buffer)
        .subarray(0, 5)
        .toString(),
    ).toBe('%PDF-');
    await http()
      .get(`/local-files/${token.slice(0, -2)}xx`)
      .expect(404);
    await http().get(`/visits/${visit.id}`).set(bearer(inC.token)).expect(404);
    await http()
      .post(`/visits/${visit.id}/files`)
      .set(bearer(inA.token))
      .field('kind', 'DOCUMENT')
      .attach('file', PDF, 'x.pdf')
      .expect(403);

    const removed = VisitDetailSchema.parse(
      (
        await http()
          .delete(`/visits/${visit.id}/files/${seen.documents[0]!.id}`)
          .set(bearer(facultyToken))
          .expect(200)
      ).body,
    );
    expect(removed.documents).toEqual([]);
    await app.get(BackgroundTasks).drain();
    await http().get(`/local-files/${token}`).expect(404);

    const actions = (await prisma.auditLog.findMany({ where: { resourceId: visit.id } })).map(
      (a) => a.action,
    );
    expect(actions.filter((a) => a === 'visit.file_added')).toHaveLength(3);
    expect(actions).toContain('visit.file_removed');
  });

  /* ─────────────────────────── notification center (§12) ─────────────────────────── */

  it('marks notifications read — only the recipient can', async () => {
    await createProgram(app);
    const a = await createGroup(app);
    const s1 = await studentIn(a.id);
    const s2 = await studentIn(a.id);
    await newVisit([a.id]);
    await newVisit([a.id], { date: cairoDate(8) });

    const before = await notificationsOf(s1.token);
    expect(before.unread).toBe(2);
    const first = before.items[0]!;
    await http().post(`/notifications/${first.id}/read`).set(bearer(s2.token)).expect(404);
    const read = await http()
      .post(`/notifications/${first.id}/read`)
      .set(bearer(s1.token))
      .expect(200);
    expect(read.body.readAt).not.toBeNull();
    expect(
      (await http().get('/notifications/unread-count').set(bearer(s1.token)).expect(200)).body,
    ).toEqual({ unread: 1 });
    expect((await notificationsOf(s2.token)).unread).toBe(2);

    await http().post('/notifications/read-all').set(bearer(s1.token)).expect(200);
    const unreadOnly = await http()
      .get('/notifications?unread=true')
      .set(bearer(s1.token))
      .expect(200);
    expect(unreadOnly.body.items).toEqual([]);

    // The database keeps notifications immutable except for their read time.
    await expect(
      prisma.notification.update({ where: { id: first.id }, data: { type: 'visit.updated' } }),
    ).rejects.toThrow(/immutable/);
  });

  it('reuses the notification center for profile-change decisions (§12)', async () => {
    const student = await createUser(app, 'STUDENT');
    const token = (await login(app, student.email, student.password!)).accessToken;
    const submitted = await http()
      .post('/me/profile-changes')
      .set(bearer(token))
      .send({ seatNumber: 'NEW-77', note: 'typo in my seat number' })
      .expect(201);
    await http()
      .post(`/profile-changes/${submitted.body.id}/reject`)
      .set(bearer(facultyToken))
      .send({ reason: 'Please bring your ID card' })
      .expect(200);
    const list = await notificationsOf(token);
    expect(list.items).toHaveLength(1);
    expect(list.items[0]).toMatchObject({
      type: 'profile_change.rejected',
      link: '/profile',
      data: { reason: 'Please bring your ID card' },
    });
  });
});
