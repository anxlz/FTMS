import {
  CalendarResponseSchema,
  ExceptionChangeResultSchema,
  ListNotificationsResponseSchema,
  PROGRAM_TIME_ZONE,
  ScheduleChangeResultSchema,
  ScheduleSchema,
  utcToZoned,
  weekdayOf,
} from '@ftms/core';
import request from 'supertest';
import { z } from 'zod';
import { PrismaService } from '../src/prisma/prisma.service';
import {
  addToGroup,
  bearer,
  bootTestApp,
  cairoDate,
  createGroup,
  createProgram,
  createUser,
  login,
  recordOf,
  resetDatabase,
  type SeededUser,
  type TestApp,
} from './helpers/test-app';

describe('Recurring schedules and exceptions (§6.1, §11.2, §20.3)', () => {
  let app: TestApp;
  let prisma: PrismaService;
  const http = () => request(app.getHttpServer());

  let directorToken: string;
  let faculty: SeededUser;
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
    const director = await createUser(app, 'TRAINING_DIRECTOR');
    faculty = await createUser(app, 'FACULTY');
    directorToken = (await login(app, director.email, director.password!)).accessToken;
    facultyToken = (await login(app, faculty.email, faculty.password!)).accessToken;
    await createProgram(app);
  });

  async function studentIn(groupId: string): Promise<string> {
    const user = await createUser(app, 'STUDENT');
    await addToGroup(app, await recordOf(app, user.id), groupId);
    return (await login(app, user.email, user.password!)).accessToken;
  }

  async function calendarOf(token: string) {
    const res = await http()
      .get(`/calendar?from=${cairoDate(0)}&to=${cairoDate(40)}`)
      .set(bearer(token))
      .expect(200);
    return CalendarResponseSchema.parse(res.body).visits;
  }

  async function notificationTypes(token: string): Promise<string[]> {
    const res = await http().get('/notifications').set(bearer(token)).expect(200);
    return ListNotificationsResponseSchema.parse(res.body).items.map((n) => n.type);
  }

  /** Sundays and Wednesdays over two weeks: exactly four sessions, whatever today is. */
  async function twoWeekSchedule(groupIds: string[], token = directorToken) {
    const res = await http()
      .post('/schedules')
      .set(bearer(token))
      .send({
        title: 'Weekly farm practice',
        weekdays: [3, 0],
        startTime: '10:00',
        endTime: '13:00',
        startsOn: cairoDate(7),
        endsOn: cairoDate(20),
        locationName: 'Faculty farm',
        groupIds,
      });
    return res;
  }

  it('materializes sessions for the selected groups and notifies their students once', async () => {
    const a = await createGroup(app, 'A');
    const c = await createGroup(app, 'C');
    const inA = await studentIn(a.id);
    const inC = await studentIn(c.id);

    expect((await twoWeekSchedule([a.id], facultyToken)).status).toBe(403);
    const res = await twoWeekSchedule([a.id]);
    expect(res.status).toBe(201);
    const result = ScheduleChangeResultSchema.parse(res.body);
    expect(result.created).toBe(4);
    expect(result.schedule).toMatchObject({
      weekdays: [0, 3],
      startTime: '10:00',
      groups: [{ name: 'A' }],
      visitCount: 4,
      upcomingCount: 4,
    });

    const sessions = await calendarOf(inA);
    expect(sessions).toHaveLength(4);
    for (const s of sessions) {
      expect([0, 3]).toContain(weekdayOf(s.date));
      expect(s).toMatchObject({
        startTime: '10:00',
        endTime: '13:00',
        locationName: 'Faculty farm',
        scheduleId: result.schedule.id,
      });
      expect(utcToZoned(new Date(s.startsAt), PROGRAM_TIME_ZONE)).toEqual({
        date: s.date,
        time: '10:00',
      });
    }
    // One summary notification, not one per session; nothing for group C.
    expect(await notificationTypes(inA)).toEqual(['schedule.created']);
    expect(await calendarOf(inC)).toEqual([]);
    expect(await notificationTypes(inC)).toEqual([]);

    const outside = await http()
      .post('/schedules')
      .set(bearer(directorToken))
      .send({
        title: 'Too long',
        weekdays: [1],
        startTime: '10:00',
        endsOn: cairoDate(400),
        groupIds: [a.id],
      })
      .expect(400);
    expect(outside.body.code).toBe('DATE_OUTSIDE_PROGRAM');
  });

  it('a day off cancels that day’s sessions with its reason; removing it restores them', async () => {
    const a = await createGroup(app);
    const inA = await studentIn(a.id);
    await twoWeekSchedule([a.id]);
    const first = (await calendarOf(inA))[0]!;

    const created = ExceptionChangeResultSchema.parse(
      (
        await http()
          .post('/schedule-exceptions')
          .set(bearer(directorToken))
          .send({ date: first.date, reason: 'National holiday' })
          .expect(201)
      ).body,
    );
    expect(created).toMatchObject({ affected: 1, notified: 1 });
    const cancelled = (await calendarOf(inA)).find((v) => v.id === first.id);
    expect(cancelled).toMatchObject({ status: 'CANCELLED', cancelReason: 'National holiday' });

    const duplicate = await http()
      .post('/schedule-exceptions')
      .set(bearer(directorToken))
      .send({ date: first.date, reason: 'Again' })
      .expect(409);
    expect(duplicate.body.code).toBe('EXCEPTION_EXISTS');
    const past = await http()
      .post('/schedule-exceptions')
      .set(bearer(directorToken))
      .send({ date: cairoDate(-2), reason: 'Too late' })
      .expect(400);
    expect(past.body.code).toBe('VISIT_IN_PAST');

    const removed = ExceptionChangeResultSchema.parse(
      (
        await http()
          .delete(`/schedule-exceptions/${created.exception!.id}`)
          .set(bearer(directorToken))
          .expect(200)
      ).body,
    );
    expect(removed).toMatchObject({ affected: 1, notified: 1 });
    expect((await calendarOf(inA)).find((v) => v.id === first.id)?.status).toBe('SCHEDULED');
    expect(await notificationTypes(inA)).toEqual([
      'visit.restored',
      'visit.cancelled',
      'schedule.created',
    ]);
  });

  it('creates sessions that fall on an existing day off already cancelled', async () => {
    const a = await createGroup(app);
    const inA = await studentIn(a.id);
    // The first Sunday of the schedule's window.
    const sunday = Array.from({ length: 7 }, (_, i) => cairoDate(7 + i)).find(
      (d) => weekdayOf(d) === 0,
    )!;
    const exception = await http()
      .post('/schedule-exceptions')
      .set(bearer(directorToken))
      .send({ date: sunday, reason: 'Exams' })
      .expect(201);
    expect(exception.body.affected).toBe(0);

    await twoWeekSchedule([a.id]);
    const onSunday = (await calendarOf(inA)).find((v) => v.date === sunday);
    expect(onSunday).toMatchObject({ status: 'CANCELLED', cancelReason: 'Exams' });

    await http()
      .delete(`/schedule-exceptions/${exception.body.exception.id}`)
      .set(bearer(directorToken))
      .expect(200);
    expect((await calendarOf(inA)).find((v) => v.date === sunday)?.status).toBe('SCHEDULED');
  });

  it('re-plans only sessions that follow the schedule; an individually changed one is left alone', async () => {
    const a = await createGroup(app, 'A');
    const b = await createGroup(app, 'B');
    const inA = await studentIn(a.id);
    const inB = await studentIn(b.id);
    const { schedule } = ScheduleChangeResultSchema.parse((await twoWeekSchedule([a.id])).body);
    const [first] = await calendarOf(inA);

    // Change one occurrence on its own (§6.1): the definition does not change.
    await http()
      .patch(`/visits/${first!.id}`)
      .set(bearer(facultyToken))
      .send({ title: 'Special session', startTime: '09:00' })
      .expect(200);

    // New time and an extra weekday (Friday): three followers updated, two Fridays added.
    const changed = ScheduleChangeResultSchema.parse(
      (
        await http()
          .patch(`/schedules/${schedule.id}`)
          .set(bearer(directorToken))
          .send({ startTime: '08:00', weekdays: [0, 3, 5], reason: 'summer hours' })
          .expect(200)
      ).body,
    );
    expect(changed).toMatchObject({ created: 2, updated: 3, removed: 0 });
    const sessions = await calendarOf(inA);
    const special = sessions.find((v) => v.id === first!.id)!;
    expect(special).toMatchObject({ title: 'Special session', startTime: '09:00' });
    for (const s of sessions.filter((v) => v.id !== first!.id)) {
      expect(s.startTime).toBe('08:00');
      expect(utcToZoned(new Date(s.startsAt), PROGRAM_TIME_ZONE).time).toBe('08:00');
    }
    expect(await notificationTypes(inA)).toEqual([
      'schedule.updated',
      'visit.updated',
      'schedule.created',
    ]);

    // Fridays only, for group B instead of A.
    const moved = ScheduleChangeResultSchema.parse(
      (
        await http()
          .patch(`/schedules/${schedule.id}`)
          .set(bearer(directorToken))
          .send({ weekdays: [5], groupIds: [b.id] })
          .expect(200)
      ).body,
    );
    expect(moved).toMatchObject({ created: 0, updated: 2, removed: 3 });
    expect(moved.schedule.groups.map((g) => g.name)).toEqual(['B']);
    // A keeps only the session that was changed on its own; B sees the Fridays.
    expect((await calendarOf(inA)).map((v) => v.id)).toEqual([first!.id]);
    const forB = await calendarOf(inB);
    expect(forB).toHaveLength(2);
    expect(forB.every((v) => weekdayOf(v.date) === 5)).toBe(true);
    expect((await notificationTypes(inA))[0]).toBe('schedule.removed');
    expect(await notificationTypes(inB)).toEqual(['schedule.created']);

    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { action: 'schedule.updated', reason: 'summer hours' },
    });
    expect(audit.before).toEqual({ weekdays: [0, 3], startTime: '10:00' });
    expect(audit.after).toEqual({ weekdays: [0, 3, 5], startTime: '08:00' });
  });

  it('ending a schedule cancels its sessions that have not started', async () => {
    const a = await createGroup(app);
    const inA = await studentIn(a.id);
    const { schedule } = ScheduleChangeResultSchema.parse((await twoWeekSchedule([a.id])).body);

    const ended = ScheduleChangeResultSchema.parse(
      (
        await http()
          .post(`/schedules/${schedule.id}/end`)
          .set(bearer(directorToken))
          .send({ reason: 'Training moved online' })
          .expect(200)
      ).body,
    );
    expect(ended.cancelled).toBe(4);
    expect(ended.schedule.endedAt).not.toBeNull();
    const sessions = await calendarOf(inA);
    expect(sessions.every((v) => v.status === 'CANCELLED')).toBe(true);
    expect(sessions[0]?.cancelReason).toBe('Training moved online');
    expect((await notificationTypes(inA))[0]).toBe('schedule.ended');

    for (const send of [
      () => http().patch(`/schedules/${schedule.id}`).send({ title: 'Renamed schedule' }),
      () => http().post(`/schedules/${schedule.id}/end`).send({ reason: 'again please' }),
    ]) {
      const res = await send().set(bearer(directorToken)).expect(409);
      expect(res.body.code).toBe('SCHEDULE_ENDED');
    }
    const active = (await http().get('/schedules').set(bearer(facultyToken)).expect(200)).body;
    expect(active).toEqual([]);
    const all = z
      .array(ScheduleSchema)
      .parse(
        (await http().get('/schedules?includeEnded=true').set(bearer(facultyToken)).expect(200))
          .body,
      );
    expect(all[0]).toMatchObject({ endReason: 'Training moved online', upcomingCount: 0 });
  });

  it('schedule.group.manage covers group schedules, never the training-wide one', async () => {
    const a = await createGroup(app, 'A');
    const b = await createGroup(app, 'B');
    await prisma.userPermissionGrant.create({
      data: {
        userId: faculty.id,
        permissionKey: 'schedule.group.manage',
        effect: 'ALLOW',
        reason: 'group coordinator',
      },
    });
    const own = ScheduleChangeResultSchema.parse(
      (await twoWeekSchedule([a.id], facultyToken)).body,
    );
    expect(own.created).toBe(4);
    const wide = await twoWeekSchedule([a.id, b.id], facultyToken);
    expect(wide.status).toBe(403);
    expect(wide.body.code).toBe('FORBIDDEN');

    const directorWide = ScheduleChangeResultSchema.parse(
      (await twoWeekSchedule([a.id, b.id])).body,
    );
    await http()
      .patch(`/schedules/${directorWide.schedule.id}`)
      .set(bearer(facultyToken))
      .send({ title: 'Taken over' })
      .expect(403);
    // Widening their own schedule to every group is refused too.
    await http()
      .patch(`/schedules/${own.schedule.id}`)
      .set(bearer(facultyToken))
      .send({ groupIds: [a.id, b.id] })
      .expect(403);

    const sessions = await prisma.trainingVisit.findMany({
      where: { scheduleId: own.schedule.id },
      orderBy: { date: 'asc' },
    });
    const day = sessions[0]!.date.toISOString().slice(0, 10);
    // A day off for their own schedule is theirs to set; one for every schedule is not.
    await http()
      .post('/schedule-exceptions')
      .set(bearer(facultyToken))
      .send({ date: day, reason: 'Field closed', scheduleId: own.schedule.id })
      .expect(201);
    await http()
      .post('/schedule-exceptions')
      .set(bearer(facultyToken))
      .send({ date: day, reason: 'Field closed' })
      .expect(403);
    expect(
      await prisma.trainingVisit.count({
        where: { scheduleId: directorWide.schedule.id, status: 'CANCELLED' },
      }),
    ).toBe(0);
  });
});
