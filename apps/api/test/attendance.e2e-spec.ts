import { createHmac, randomUUID } from 'node:crypto';
import {
  AttendanceOverviewSchema,
  CheckInContextSchema,
  CheckInResultSchema,
  distanceMeters,
  type LocalDate,
  OwnAttendanceResponseSchema,
  PROGRAM_TIME_ZONE,
  VisitAttendanceResponseSchema,
  VisitAttendanceRowSchema,
  VisitMutationResultSchema,
  VisitQrCodesSchema,
  WebAuthnOptionsResponseSchema,
  zonedToUtc,
} from '@ftms/core';
import request from 'supertest';
import { AbsencesService } from '../src/attendance/absences.service';
import { AttendanceTokens } from '../src/attendance/attendance-tokens';
import { WebAuthnSettings } from '../src/auth/biometrics/webauthn';
import { BackgroundTasks } from '../src/common/background-tasks.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { SoftAuthenticator } from './helpers/authenticator';
import {
  addToGroup,
  bearer,
  bootTestApp,
  createGroup,
  createProgram,
  createUser,
  createVisit,
  login,
  recordOf,
  resetDatabase,
  type SeededUser,
  type TestApp,
  TestClock,
} from './helpers/test-app';

/** A winter day: Cairo is UTC+2. */
const DAY: LocalDate = '2026-12-15';
const HERE = { latitude: 30.0444, longitude: 31.2357, accuracy: 15 };

/** An instant on the Cairo wall clock, e.g. `at('09:44:59')`. */
const at = (time: string, date: LocalDate = DAY): Date => {
  const [hh, mm, ss = '0'] = time.split(':');
  const minute = zonedToUtc(date, `${hh}:${mm}`, PROGRAM_TIME_ZONE);
  return new Date(minute.getTime() + Number(ss) * 1000);
};

interface Student {
  user: SeededUser;
  token: string;
  recordId: string;
}

describe('Attendance: QR check-in, absences, corrections and dashboards (§7–§10, §20.2)', () => {
  const clock = new TestClock();
  let app: TestApp;
  let prisma: PrismaService;
  let qr: AttendanceTokens;
  let origin: string;
  const http = () => request(app.getHttpServer());

  let director: SeededUser;
  let faculty: SeededUser;
  let directorToken: string;
  let facultyToken: string;
  let programId: string;
  let group: { id: string; name: string };

  beforeAll(async () => {
    ({ app } = await bootTestApp({ clock }));
    prisma = app.get(PrismaService);
    qr = app.get(AttendanceTokens);
    origin = app.get(WebAuthnSettings).origin;
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(async () => {
    clock.reset();
    await resetDatabase(app);
    director = await createUser(app, 'TRAINING_DIRECTOR');
    faculty = await createUser(app, 'FACULTY');
    directorToken = (await login(app, director.email, director.password!)).accessToken;
    facultyToken = (await login(app, faculty.email, faculty.password!)).accessToken;
    programId = (await createProgram(app)).id;
    group = await createGroup(app, 'المجموعة أ');
  });

  /* ─────────────────────────── helpers ─────────────────────────── */

  async function studentIn(groupId: string | null): Promise<Student> {
    const user = await createUser(app, 'STUDENT');
    const recordId = await recordOf(app, user.id);
    if (groupId) await addToGroup(app, recordId, groupId);
    return { user, recordId, token: (await login(app, user.email, user.password!)).accessToken };
  }

  const tenOClock = (options: Parameters<typeof createVisit>[3] = {}, groups = [group.id]) =>
    createVisit(app, programId, groups, { date: DAY, startTime: '10:00', ...options });

  const checkIn = (s: Student, body: object) =>
    http().post('/attendance/check-in').set(bearer(s.token)).send(body);

  async function contextOf(s: Student, token: string) {
    const res = await http().get(`/attendance/check-in/${token}`).set(bearer(s.token)).expect(200);
    return CheckInContextSchema.parse(res.body);
  }

  const recordsOf = (visitId: string) =>
    prisma.attendanceRecord.findMany({ where: { visitId }, orderBy: { createdAt: 'asc' } });

  const runJob = async () =>
    (
      await http()
        .post('/internal/attendance/process-absences')
        .set('x-ftms-cron-key', process.env.CRON_SECRET!)
        .expect(200)
    ).body as { visits: number; absences: number; notified: number };

  async function tableOf(visitId: string, query = '', token = facultyToken) {
    const res = await http()
      .get(`/visits/${visitId}/attendance${query}`)
      .set(bearer(token))
      .expect(200);
    return VisitAttendanceResponseSchema.parse(res.body);
  }

  const correct = (visitId: string, studentId: string, body: object, token = facultyToken) =>
    http().put(`/visits/${visitId}/attendance/${studentId}`).set(bearer(token)).send(body);

  /** Enrolls a software passkey for the student (after a password sign-in). */
  async function enrollDevice(s: Student): Promise<SoftAuthenticator> {
    const device = new SoftAuthenticator(origin);
    const { accessToken } = await login(app, s.user.email, s.user.password!);
    const res = await http()
      .post('/auth/biometric/credentials/options')
      .set(bearer(accessToken))
      .expect(200);
    const { challengeId, options } = WebAuthnOptionsResponseSchema.parse(res.body);
    await http()
      .post('/auth/biometric/credentials')
      .set(bearer(accessToken))
      .send({ challengeId, name: 'Phone', response: device.register(options) })
      .expect(201);
    return device;
  }

  async function checkInOptions(s: Student, token: string) {
    const res = await http()
      .post('/attendance/check-in/options')
      .set(bearer(s.token))
      .send({ token })
      .expect(200);
    return WebAuthnOptionsResponseSchema.parse(res.body);
  }

  /** The full §7.2 flow: a fresh biometric assertion for this visit, plus the location. */
  async function confirmedCheckIn(
    s: Student,
    device: SoftAuthenticator,
    token: string,
    extra: Record<string, unknown> = { location: HERE },
  ) {
    const { challengeId, options } = await checkInOptions(s, token);
    return checkIn(s, {
      token,
      biometric: { challengeId, response: device.assert(options) },
      ...extra,
    });
  }

  const expectError = (res: request.Response, status: number, code: string) =>
    expect({ status: res.status, code: res.body?.code }).toEqual({ status, code });

  /* ─────────────────────────── §20.2 timing boundaries ─────────────────────────── */

  describe('a 10:00 visit with the default 15/15/60 timing (§8.1, §8.2)', () => {
    interface Case {
      time: string;
      error?: 'CHECK_IN_NOT_OPEN' | 'CHECK_IN_CLOSED';
      status?: 'PRESENT' | 'LATE';
      minutesLate?: number;
    }
    const cases: Case[] = [
      { time: '09:44:00', error: 'CHECK_IN_NOT_OPEN' },
      { time: '09:44:59', error: 'CHECK_IN_NOT_OPEN' },
      { time: '09:45:00', status: 'PRESENT', minutesLate: 0 },
      { time: '10:00:00', status: 'PRESENT', minutesLate: 0 },
      { time: '10:15:00', status: 'PRESENT', minutesLate: 0 },
      { time: '10:15:59', status: 'PRESENT', minutesLate: 0 },
      { time: '10:16:00', status: 'LATE', minutesLate: 1 },
      { time: '10:42:30', status: 'LATE', minutesLate: 27 },
      { time: '11:00:00', status: 'LATE', minutesLate: 45 },
      { time: '11:00:59', status: 'LATE', minutesLate: 45 },
      { time: '11:01:00', error: 'CHECK_IN_CLOSED' },
      { time: '14:00:00', error: 'CHECK_IN_CLOSED' },
    ];

    it.each(cases)('check-in at $time → $status$error $minutesLate', async (c) => {
      const visit = await tenOClock();
      const s = await studentIn(group.id);
      clock.set(at(c.time));
      const res = await checkIn(s, { token: qr.sign(visit.id), location: HERE });
      if (c.error) {
        expectError(res, 409, c.error);
        expect(await recordsOf(visit.id)).toHaveLength(0);
        return;
      }
      expect(res.status).toBe(201);
      const { record } = CheckInResultSchema.parse(res.body);
      expect(record).toMatchObject({
        visitId: visit.id,
        status: c.status,
        minutesLate: c.minutesLate,
        source: 'QR',
        biometricVerified: false,
        checkedInAt: at(c.time).toISOString(),
        correction: null,
      });
      const rows = await recordsOf(visit.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ studentId: s.recordId, groupId: group.id });
    });

    it('shows the window and its state in server time at the moment of the scan', async () => {
      const visit = await tenOClock();
      const s = await studentIn(group.id);
      const token = qr.sign(visit.id);

      clock.set(at('09:30'));
      const before = await contextOf(s, token);
      expect(before).toMatchObject({
        visit: { id: visit.id, date: DAY, startTime: '10:00', status: 'SCHEDULED' },
        window: {
          state: 'NOT_OPEN',
          opensAt: at('09:45').toISOString(),
          onTimeUntil: at('10:16').toISOString(),
          closesAt: at('11:01').toISOString(),
        },
        existing: null,
        requirements: { biometric: 'NOT_ENROLLED_ALLOWED', geolocation: 'REQUIRED' },
        serverTime: at('09:30').toISOString(),
      });
      clock.set(at('10:59'));
      expect((await contextOf(s, token)).window.state).toBe('OPEN');
      clock.set(at('11:01'));
      expect((await contextOf(s, token)).window.state).toBe('CLOSED');
    });

    it('marks students without a valid check-in absent once the window closes (§8.3)', async () => {
      const visit = await tenOClock();
      const [present, late, absent, corrected] = [
        await studentIn(group.id),
        await studentIn(group.id),
        await studentIn(group.id),
        await studentIn(group.id),
      ];
      const token = qr.sign(visit.id);
      clock.set(at('10:05'));
      await checkIn(present, { token, location: HERE }).expect(201);
      clock.set(at('10:40'));
      await checkIn(late, { token, location: HERE }).expect(201);
      // A correction made during the window is an authorized record the job must keep.
      await correct(visit.id, corrected.recordId, {
        status: 'LATE',
        minutesLate: 5,
        reason: 'Came with the late bus',
      }).expect(200);

      // 11:00 is still inside the window: nothing is recorded yet.
      clock.set(at('11:00:59'));
      expect(await runJob()).toEqual({ visits: 0, absences: 0, notified: 0 });
      expect(await recordsOf(visit.id)).toHaveLength(3);

      clock.set(at('11:01'));
      expect(await runJob()).toEqual({ visits: 1, absences: 1, notified: 1 });
      const byStudent = new Map((await recordsOf(visit.id)).map((r) => [r.studentId, r]));
      expect(byStudent.get(present.recordId)).toMatchObject({ status: 'PRESENT', source: 'QR' });
      expect(byStudent.get(late.recordId)).toMatchObject({ status: 'LATE', minutesLate: 25 });
      expect(byStudent.get(absent.recordId)).toMatchObject({
        status: 'ABSENT',
        source: 'AUTOMATIC',
        minutesLate: 0,
        checkedInAt: null,
      });
      expect(byStudent.get(corrected.recordId)).toMatchObject({
        status: 'LATE',
        minutesLate: 5,
        source: 'MANUAL',
      });

      const audit = await prisma.auditLog.findFirstOrThrow({
        where: { action: 'attendance.absences_recorded', resourceId: visit.id },
      });
      expect(audit).toMatchObject({ actorId: null, metadata: { absences: 1, students: 4 } });
      await app.get(BackgroundTasks).drain();
      const notices = await prisma.notification.findMany({
        where: { type: 'attendance.absent' },
      });
      expect(notices.map((n) => n.recipientId)).toEqual([absent.user.id]);
      expect(notices[0]).toMatchObject({ link: '/attendance', data: { visitId: visit.id } });
    });

    it('is idempotent: repeated and overlapping runs add nothing and overwrite nothing', async () => {
      const visit = await tenOClock();
      const [a, b, c] = [
        await studentIn(group.id),
        await studentIn(group.id),
        await studentIn(group.id),
      ];
      clock.set(at('10:10'));
      await checkIn(a, { token: qr.sign(visit.id), location: HERE }).expect(201);

      clock.set(at('11:30'));
      // Two scheduler calls at the same moment.
      const [first, second] = await Promise.all([runJob(), runJob()]);
      expect(first.absences + second.absences).toBe(2);
      expect(first.visits + second.visits).toBe(1);
      expect(await runJob()).toEqual({ visits: 0, absences: 0, notified: 0 });

      // A faculty correction after the job…
      await correct(visit.id, b.recordId, { status: 'PRESENT', reason: 'Signed the sheet' }).expect(
        200,
      );
      // …survives even a forced reprocessing of the visit, run twice in parallel.
      await prisma.trainingVisit.update({
        where: { id: visit.id },
        data: { absencesProcessedAt: null },
      });
      const absences = app.get(AbsencesService);
      const reruns = await Promise.all([
        absences.processVisit(visit.id),
        absences.processVisit(visit.id),
      ]);
      expect(reruns.filter(Boolean)).toEqual([{ absences: 0, notified: 0 }]);

      const rows = await recordsOf(visit.id);
      expect(rows).toHaveLength(3);
      const byStudent = new Map(rows.map((r) => [r.studentId, r]));
      expect(byStudent.get(a.recordId)).toMatchObject({ status: 'PRESENT', source: 'QR' });
      expect(byStudent.get(b.recordId)).toMatchObject({ status: 'PRESENT', source: 'MANUAL' });
      expect(byStudent.get(c.recordId)).toMatchObject({ status: 'ABSENT', source: 'AUTOMATIC' });
      await app.get(BackgroundTasks).drain();
      expect(await prisma.notification.count({ where: { type: 'attendance.absent' } })).toBe(2);
    });

    it('judges a rescheduled visit by its new time', async () => {
      const visit = await tenOClock({ title: 'Moved visit' });
      const s = await studentIn(group.id);
      clock.set(at('08:00'));
      VisitMutationResultSchema.parse(
        (
          await http()
            .patch(`/visits/${visit.id}`)
            .set(bearer(facultyToken))
            .send({ startTime: '14:00', reason: 'Bus delayed' })
            .expect(200)
        ).body,
      );
      clock.set(at('10:05'));
      expectError(
        await checkIn(s, { token: qr.sign(visit.id), location: HERE }),
        409,
        'CHECK_IN_NOT_OPEN',
      );
      clock.set(at('11:30'));
      expect(await runJob()).toMatchObject({ visits: 0 });
      clock.set(at('14:20'));
      const { record } = CheckInResultSchema.parse(
        (await checkIn(s, { token: qr.sign(visit.id), location: HERE }).expect(201)).body,
      );
      expect(record).toMatchObject({ status: 'LATE', minutesLate: 5 });
    });
  });

  /* ─────────────────────────── §8.5 rejections ─────────────────────────── */

  describe('duplicate and invalid check-ins (§7.3, §8.5)', () => {
    it('keeps one record per student per visit and shows the existing status on a second scan', async () => {
      const visit = await tenOClock();
      const s = await studentIn(group.id);
      const token = qr.sign(visit.id);
      clock.set(at('10:02'));
      await checkIn(s, { token, location: HERE }).expect(201);
      clock.set(at('10:30'));
      const again = await checkIn(s, { token, location: HERE });
      expectError(again, 409, 'ATTENDANCE_ALREADY_RECORDED');
      expect(again.body.details).toEqual({ status: ['PRESENT'] });
      expect((await contextOf(s, token)).existing).toMatchObject({
        status: 'PRESENT',
        checkedInAt: at('10:02').toISOString(),
      });

      // Simultaneous submissions from one student: exactly one succeeds.
      const t = await studentIn(group.id);
      const results = await Promise.all([1, 2, 3].map(() => checkIn(t, { token, location: HERE })));
      expect(results.map((r) => r.status).sort()).toEqual([201, 409, 409]);
      for (const r of results.filter((x) => x.status === 409)) {
        expect(r.body.code).toBe('ATTENDANCE_ALREADY_RECORDED');
      }
      expect(await recordsOf(visit.id)).toHaveLength(2);
    });

    it('rejects students outside the visit’s groups, staff and anonymous callers', async () => {
      const visit = await tenOClock();
      const token = qr.sign(visit.id);
      const other = await studentIn((await createGroup(app)).id);
      const ungrouped = await studentIn(null);
      const former = await studentIn(group.id);
      await prisma.groupMembership.updateMany({
        where: { studentId: former.recordId },
        data: { endedAt: new Date() },
      });
      clock.set(at('10:00'));

      for (const s of [other, ungrouped, former]) {
        expectError(await checkIn(s, { token, location: HERE }), 403, 'NOT_IN_VISIT_GROUP');
        const ctx = await http().get(`/attendance/check-in/${token}`).set(bearer(s.token));
        expectError(ctx, 403, 'NOT_IN_VISIT_GROUP');
      }
      const staff = await http()
        .post('/attendance/check-in')
        .set(bearer(facultyToken))
        .send({ token, location: HERE });
      expectError(staff, 403, 'FORBIDDEN');
      const anonymous = await http().post('/attendance/check-in').send({ token, location: HERE });
      expectError(anonymous, 401, 'AUTH_REQUIRED');

      const pending = await createUser(app, 'STUDENT', { status: 'PENDING_VERIFICATION' });
      const pendingToken = (await login(app, pending.email, pending.password!)).accessToken;
      const res = await http()
        .post('/attendance/check-in')
        .set(bearer(pendingToken))
        .send({ token, location: HERE });
      expect(res.status).toBe(403);

      expect(await recordsOf(visit.id)).toHaveLength(0);
    });

    it('rejects forged, altered and unknown QR tokens', async () => {
      const visit = await tenOClock();
      const s = await studentIn(group.id);
      clock.set(at('10:00'));
      const good = qr.sign(visit.id);
      const altered = `${good.slice(0, -2)}${good.endsWith('AA') ? 'BB' : 'AA'}`;
      const id = Buffer.from(visit.id.replace(/-/g, ''), 'hex');
      const otherKey = Buffer.concat([
        id,
        createHmac('sha256', 'not-our-key')
          .update('ftms:attendance-qr:v1:')
          .update(id)
          .digest()
          .subarray(0, 16),
      ]).toString('base64url');
      const unknownVisit = qr.sign(randomUUID());
      for (const token of [altered, otherKey, unknownVisit, 'AAAAAAAAAAAAAAAA']) {
        expectError(await checkIn(s, { token, location: HERE }), 404, 'QR_INVALID');
        expectError(
          await http().get(`/attendance/check-in/${token}`).set(bearer(s.token)),
          404,
          'QR_INVALID',
        );
      }
      const malformed = await checkIn(s, { token: 'not a token!', location: HERE });
      expectError(malformed, 400, 'VALIDATION_FAILED');
      expect(await recordsOf(visit.id)).toHaveLength(0);
    });

    it('rejects check-ins and corrections for a cancelled visit, and records no absences', async () => {
      const visit = await tenOClock();
      const s = await studentIn(group.id);
      clock.set(at('09:00'));
      await http()
        .post(`/visits/${visit.id}/cancel`)
        .set(bearer(facultyToken))
        .send({ reason: 'Heavy rain' })
        .expect(200);
      clock.set(at('10:00'));
      const token = qr.sign(visit.id);
      expectError(await checkIn(s, { token, location: HERE }), 409, 'VISIT_CANCELLED');
      expect((await contextOf(s, token)).visit.status).toBe('CANCELLED');
      expectError(
        await correct(visit.id, s.recordId, { status: 'PRESENT' }),
        409,
        'VISIT_CANCELLED',
      );
      clock.set(at('12:00'));
      expect(await runJob()).toMatchObject({ visits: 0 });
      expect((await tableOf(visit.id)).absencesProcessed).toBe(false);
      expect(await recordsOf(visit.id)).toHaveLength(0);
    });

    it('ignores attendance values submitted by the browser', async () => {
      const visit = await tenOClock();
      const s = await studentIn(group.id);
      const other = await studentIn(group.id);
      clock.set(at('10:30'));
      const res = await checkIn(s, {
        token: qr.sign(visit.id),
        location: HERE,
        status: 'PRESENT',
        minutesLate: 0,
        biometricVerified: true,
        checkedInAt: at('10:00').toISOString(),
        studentId: other.recordId,
        groupId: randomUUID(),
      }).expect(201);
      expect(CheckInResultSchema.parse(res.body).record).toMatchObject({
        status: 'LATE',
        minutesLate: 15,
        biometricVerified: false,
        checkedInAt: at('10:30').toISOString(),
      });
      const rows = await recordsOf(visit.id);
      expect(rows.map((r) => [r.studentId, r.groupId])).toEqual([[s.recordId, group.id]]);
    });
  });

  /* ─────────────────────────── configuration ─────────────────────────── */

  describe('timing configuration (§8.1)', () => {
    it('applies a visit’s own timing override', async () => {
      const visit = await tenOClock();
      await http()
        .patch(`/visits/${visit.id}`)
        .set(bearer(facultyToken))
        .send({ timing: { checkInOpensMinutes: 30, graceMinutes: 5, checkInClosesMinutes: 20 } })
        .expect(200);
      const token = qr.sign(visit.id);
      const cases: [string, string, number?][] = [
        ['09:29:59', 'CHECK_IN_NOT_OPEN'],
        ['09:30:00', 'PRESENT', 0],
        ['10:05:59', 'PRESENT', 0],
        ['10:06:00', 'LATE', 1],
        ['10:20:59', 'LATE', 15],
        ['10:21:00', 'CHECK_IN_CLOSED'],
      ];
      for (const [time, expected, minutesLate] of cases) {
        const s = await studentIn(group.id);
        clock.set(at(time));
        const res = await checkIn(s, { token, location: HERE });
        if (minutesLate === undefined) {
          expectError(res, 409, expected);
        } else {
          expect(res.status).toBe(201);
          expect(res.body.record).toMatchObject({ status: expected, minutesLate });
        }
      }
      // Absences follow the visit's own closing time too.
      const late = await studentIn(group.id);
      clock.set(at('10:21'));
      expect(await runJob()).toMatchObject({ visits: 1, absences: 3 });
      expect(
        (await recordsOf(visit.id)).filter((r) => r.studentId === late.recordId)[0]?.status,
      ).toBe('ABSENT');
    });

    it('keeps each existing visit’s timing when the defaults change', async () => {
      const create = async () =>
        VisitMutationResultSchema.parse(
          (
            await http()
              .post('/visits')
              .set(bearer(facultyToken))
              .send({ title: 'Farm', date: DAY, startTime: '10:00', groupIds: [group.id] })
              .expect(201)
          ).body,
        ).visit;
      const before = await create();
      await http()
        .patch('/program')
        .set(bearer(directorToken))
        .send({
          timing: { checkInOpensMinutes: 5, graceMinutes: 2, checkInClosesMinutes: 10 },
          reason: 'Stricter policy',
        })
        .expect(200);
      const after = await create();
      expect(before.timing).toEqual({
        checkInOpensMinutes: 15,
        graceMinutes: 15,
        checkInClosesMinutes: 60,
      });

      clock.set(at('09:46'));
      await checkIn(await studentIn(group.id), {
        token: qr.sign(before.id),
        location: HERE,
      }).expect(201);
      expectError(
        await checkIn(await studentIn(group.id), { token: qr.sign(after.id), location: HERE }),
        409,
        'CHECK_IN_NOT_OPEN',
      );
      clock.set(at('10:16'));
      const late = await checkIn(await studentIn(group.id), {
        token: qr.sign(before.id),
        location: HERE,
      }).expect(201);
      expect(late.body.record).toMatchObject({ status: 'LATE', minutesLate: 1 });
      expectError(
        await checkIn(await studentIn(group.id), { token: qr.sign(after.id), location: HERE }),
        409,
        'CHECK_IN_CLOSED',
      );
    });

    it('judges the window in Africa/Cairo across DST and midnight', async () => {
      const summer = await tenOClock({ date: '2026-07-15' }); // EEST, UTC+3
      const winter = await tenOClock(); // EET, UTC+2
      const midnight = await tenOClock({ date: '2026-12-16', startTime: '00:10' });
      const cases: [string, string, string, number?][] = [
        [summer.id, '2026-07-15T06:44:59Z', 'CHECK_IN_NOT_OPEN'],
        [summer.id, '2026-07-15T06:45:00Z', 'PRESENT', 0],
        [summer.id, '2026-07-15T07:16:00Z', 'LATE', 1],
        [winter.id, '2026-12-15T07:44:59Z', 'CHECK_IN_NOT_OPEN'],
        [winter.id, '2026-12-15T07:45:00Z', 'PRESENT', 0],
        [winter.id, '2026-12-15T09:00:00Z', 'LATE', 45],
        [midnight.id, '2026-12-15T21:54:59Z', 'CHECK_IN_NOT_OPEN'],
        [midnight.id, '2026-12-15T21:55:00Z', 'PRESENT', 0], // 23:55 the evening before
        [midnight.id, '2026-12-15T22:26:00Z', 'LATE', 1],
        [midnight.id, '2026-12-15T23:11:00Z', 'CHECK_IN_CLOSED'],
      ];
      for (const [visitId, instant, expected, minutesLate] of cases) {
        const s = await studentIn(group.id);
        clock.set(instant);
        const res = await checkIn(s, { token: qr.sign(visitId), location: HERE });
        if (minutesLate === undefined) expectError(res, 409, expected);
        else expect(res.body.record).toMatchObject({ status: expected, minutesLate });
      }
      const ctx = await contextOf(await studentIn(group.id), qr.sign(midnight.id));
      expect(ctx.visit).toMatchObject({ date: '2026-12-16', startTime: '00:10' });
      expect(ctx.window.opensAt).toBe('2026-12-15T21:55:00.000Z');
    });
  });

  /* ─────────────────────────── §7.2 biometrics + geolocation ─────────────────────────── */

  describe('biometric confirmation at check-in (§7.2)', () => {
    it('requires a fresh assertion and the location from a student with a registered device', async () => {
      // Even where the fallback policy makes the location optional.
      await prisma.trainingProgram.update({
        where: { id: programId },
        data: { geolocationPolicy: 'OPTIONAL' },
      });
      const visit = await tenOClock();
      const s = await studentIn(group.id);
      const device = await enrollDevice(s);
      const token = qr.sign(visit.id);
      clock.set(at('10:05'));

      expect((await contextOf(s, token)).requirements).toEqual({
        biometric: 'REQUIRED',
        geolocation: 'REQUIRED',
      });
      expectError(await checkIn(s, { token, location: HERE }), 400, 'BIOMETRIC_REQUIRED');
      expectError(await confirmedCheckIn(s, device, token, {}), 400, 'GEOLOCATION_REQUIRED');

      const options = await checkInOptions(s, token);
      expect(options.options).toMatchObject({
        userVerification: 'required',
        allowCredentials: [expect.objectContaining({ id: device.id })],
      });
      const res = await checkIn(s, {
        token,
        biometric: { challengeId: options.challengeId, response: device.assert(options.options) },
        location: HERE,
      });
      expect(res.status).toBe(201);
      expect(CheckInResultSchema.parse(res.body).record).toMatchObject({
        status: 'PRESENT',
        biometricVerified: true,
        location: { latitude: HERE.latitude, longitude: HERE.longitude, accuracyMeters: 15 },
      });
      const [row] = await recordsOf(visit.id);
      const credential = await prisma.webAuthnCredential.findFirstOrThrow({
        where: { credentialId: device.id },
      });
      expect(row).toMatchObject({ credentialId: credential.id, biometricVerified: true });
      expect(credential.lastUsedAt?.toISOString()).toBe(at('10:05').toISOString());
    });

    it('refuses assertions that are stale, replayed, for another visit, or from another device', async () => {
      const [visitA, visitB] = [await tenOClock(), await tenOClock({ title: 'Second' })];
      const s = await studentIn(group.id);
      const t = await studentIn(group.id);
      const device = await enrollDevice(s);
      const otherDevice = await enrollDevice(t);
      const tokenA = qr.sign(visitA.id);
      const tokenB = qr.sign(visitB.id);
      clock.set(at('10:05'));

      const failed = (res: request.Response) => expectError(res, 401, 'BIOMETRIC_FAILED');

      // A challenge issued for visit A, spent on visit B.
      let o = await checkInOptions(s, tokenA);
      failed(
        await checkIn(s, {
          token: tokenB,
          biometric: { challengeId: o.challengeId, response: device.assert(o.options) },
          location: HERE,
        }),
      );
      // A sign-in challenge is not a check-in challenge.
      const loginOptions = WebAuthnOptionsResponseSchema.parse(
        (await http().post('/auth/biometric/login/options').expect(200)).body,
      );
      failed(
        await checkIn(s, {
          token: tokenA,
          biometric: {
            challengeId: loginOptions.challengeId,
            response: device.assert(loginOptions.options),
          },
          location: HERE,
        }),
      );
      // Another student's challenge.
      o = await checkInOptions(t, tokenA);
      failed(
        await checkIn(s, {
          token: tokenA,
          biometric: { challengeId: o.challengeId, response: device.assert(o.options) },
          location: HERE,
        }),
      );
      // Another student's registered device.
      o = await checkInOptions(s, tokenA);
      failed(
        await checkIn(s, {
          token: tokenA,
          biometric: { challengeId: o.challengeId, response: otherDevice.assert(o.options) },
          location: HERE,
        }),
      );
      // A forged signature — and the challenge is spent by the failed attempt.
      o = await checkInOptions(s, tokenA);
      failed(
        await checkIn(s, {
          token: tokenA,
          biometric: {
            challengeId: o.challengeId,
            response: device.assert(o.options, { forgeSignature: true }),
          },
          location: HERE,
        }),
      );
      failed(
        await checkIn(s, {
          token: tokenA,
          biometric: { challengeId: o.challengeId, response: device.assert(o.options) },
          location: HERE,
        }),
      );
      // Without user verification on the device.
      o = await checkInOptions(s, tokenA);
      failed(
        await checkIn(s, {
          token: tokenA,
          biometric: {
            challengeId: o.challengeId,
            response: device.assert(o.options, { userVerified: false }),
          },
          location: HERE,
        }),
      );
      // Stale: answered after the challenge expired.
      o = await checkInOptions(s, tokenA);
      clock.set(at('10:11'));
      failed(
        await checkIn(s, {
          token: tokenA,
          biometric: { challengeId: o.challengeId, response: device.assert(o.options) },
          location: HERE,
        }),
      );
      // A biometric sign-in session is not a confirmation of this check-in.
      const signIn = WebAuthnOptionsResponseSchema.parse(
        (await http().post('/auth/biometric/login/options').expect(200)).body,
      );
      const session = await http()
        .post('/auth/biometric/login')
        .send({ challengeId: signIn.challengeId, response: device.assert(signIn.options) })
        .expect(200);
      expectError(
        await http()
          .post('/attendance/check-in')
          .set(bearer(session.body.accessToken as string))
          .send({ token: tokenA, location: HERE }),
        400,
        'BIOMETRIC_REQUIRED',
      );
      expect(await prisma.attendanceRecord.count()).toBe(0);

      // A proper confirmation still works.
      expect((await confirmedCheckIn(s, device, tokenA)).status).toBe(201);
    });

    it('returns a student whose device was revoked to the fallback flow', async () => {
      const visit = await tenOClock();
      const s = await studentIn(group.id);
      await enrollDevice(s);
      const credential = await prisma.webAuthnCredential.findFirstOrThrow({
        where: { userId: s.user.id },
      });
      await http()
        .delete(`/auth/biometric/credentials/${credential.id}`)
        .set(bearer(s.token))
        .send({})
        .expect(204);
      clock.set(at('10:00'));
      const token = qr.sign(visit.id);
      expect((await contextOf(s, token)).requirements.biometric).toBe('NOT_ENROLLED_ALLOWED');
      const res = await checkIn(s, { token, location: HERE }).expect(201);
      expect(res.body.record).toMatchObject({ biometricVerified: false });
    });

    it('fallback "allow": a student without a device checks in, marked not biometrically confirmed', async () => {
      const visit = await tenOClock();
      const s = await studentIn(group.id);
      clock.set(at('10:00'));
      const token = qr.sign(visit.id);
      expectError(
        await http().post('/attendance/check-in/options').set(bearer(s.token)).send({ token }),
        409,
        'BIOMETRIC_NOT_ENROLLED',
      );
      const res = await checkIn(s, { token, location: HERE }).expect(201);
      expect(res.body.record).toMatchObject({ status: 'PRESENT', biometricVerified: false });
      const row = (await tableOf(visit.id)).rows.find((r) => r.student.id === s.recordId)!;
      expect(row.record).toMatchObject({ biometricVerified: false });
    });

    it('fallback "require": a student without a device is refused until biometrics are enabled', async () => {
      await http()
        .patch('/program')
        .set(bearer(directorToken))
        .send({
          checkInPolicy: { biometricFallback: 'REQUIRE_BIOMETRIC', geolocation: 'REQUIRED' },
        })
        .expect(200);
      const visit = await tenOClock();
      const s = await studentIn(group.id);
      const token = qr.sign(visit.id);
      clock.set(at('10:00'));
      expect((await contextOf(s, token)).requirements.biometric).toBe('NOT_ENROLLED_BLOCKED');
      expectError(await checkIn(s, { token, location: HERE }), 409, 'BIOMETRIC_NOT_ENROLLED');
      expect(await recordsOf(visit.id)).toHaveLength(0);

      const device = await enrollDevice(s);
      expect((await confirmedCheckIn(s, device, token)).status).toBe(201);
    });

    it('only the Training Director sets the check-in policy', async () => {
      const res = await http()
        .patch('/program')
        .set(bearer(facultyToken))
        .send({
          checkInPolicy: { biometricFallback: 'ALLOW_UNVERIFIED', geolocation: 'OPTIONAL' },
        });
      expectError(res, 403, 'FORBIDDEN');
    });
  });

  describe('geolocation at check-in (§7.2)', () => {
    it('"required": refuses a check-in without a location reading', async () => {
      const visit = await tenOClock();
      const s = await studentIn(group.id);
      clock.set(at('10:00'));
      const token = qr.sign(visit.id);
      const missing = await checkIn(s, { token });
      expectError(missing, 400, 'GEOLOCATION_REQUIRED');
      expect(missing.body.details).toEqual({ location: ['GEOLOCATION_REQUIRED'] });
      expectError(
        await checkIn(s, { token, location: { latitude: 120, longitude: 31 } }),
        400,
        'VALIDATION_FAILED',
      );
      expect(await recordsOf(visit.id)).toHaveLength(0);
      await checkIn(s, { token, location: { latitude: 30.1, longitude: 31.3 } }).expect(201);
    });

    it('"optional": a student without a device may check in without a location', async () => {
      await prisma.trainingProgram.update({
        where: { id: programId },
        data: { geolocationPolicy: 'OPTIONAL' },
      });
      const visit = await tenOClock();
      const s = await studentIn(group.id);
      clock.set(at('10:00'));
      const token = qr.sign(visit.id);
      expect((await contextOf(s, token)).requirements.geolocation).toBe('OPTIONAL');
      const res = await checkIn(s, { token }).expect(201);
      expect(res.body.record).toMatchObject({ location: null });
    });

    it('stores the reading with the record and shows it to faculty (§10.3)', async () => {
      const site = { latitude: 30.0444, longitude: 31.2357 };
      const visit = await tenOClock({ coordinates: site });
      const s = await studentIn(group.id);
      const device = await enrollDevice(s);
      clock.set(at('10:00'));
      const reading = { latitude: 30.045, longitude: 31.2365, accuracy: 12 };
      const res = await confirmedCheckIn(s, device, qr.sign(visit.id), { location: reading });
      expect(res.status).toBe(201);

      const table = await tableOf(visit.id);
      expect(table.visit).toMatchObject(site);
      const row = table.rows.find((r) => r.student.id === s.recordId)!;
      const expected = distanceMeters(reading, site);
      expect(expected).toBeGreaterThan(50);
      expect(row.record).toMatchObject({
        biometricVerified: true,
        location: { latitude: 30.045, longitude: 31.2365, accuracyMeters: 12 },
      });
      expect(row.record!.location!.distanceMeters).toBeCloseTo(expected, 3);
      const stored = (await recordsOf(visit.id))[0]!;
      expect(stored).toMatchObject({ latitude: 30.045, longitude: 31.2365, accuracyMeters: 12 });

      // The audit trail notes that a reading was submitted, not where the student was.
      const audit = await prisma.auditLog.findFirstOrThrow({
        where: { action: 'attendance.checked_in', resourceId: stored.id },
      });
      expect(audit.metadata).toMatchObject({ geolocation: true });
      const logged = JSON.stringify([audit.before, audit.after, audit.metadata, audit.reason]);
      expect(logged).not.toContain('30.045');
      expect(logged).not.toContain('31.2365');
    });
  });

  /* ─────────────────────────── faculty: tables and corrections ─────────────────────────── */

  describe('faculty attendance tables and corrections (§8.4, §10.3)', () => {
    it('lists every expected student with their record, with filters and counts', async () => {
      const g2 = await createGroup(app, 'المجموعة ب');
      const g3 = await createGroup(app, 'المجموعة ج');
      const visit = await tenOClock({}, [group.id, g2.id]);
      const a = await studentIn(group.id);
      const b = await studentIn(g2.id);
      const c = await studentIn(g2.id);
      const moved = await studentIn(group.id);
      await studentIn(g3.id); // not part of the visit
      await prisma.studentProfile.update({
        where: { id: a.recordId },
        data: { fullName: 'محمد أحمد علي حسن' },
      });
      const token = qr.sign(visit.id);
      clock.set(at('10:05'));
      await checkIn(a, { token, location: HERE }).expect(201);
      await checkIn(moved, { token, location: HERE }).expect(201);
      clock.set(at('10:30'));
      await checkIn(b, { token, location: HERE }).expect(201);
      // A student who checked in and then moved to another group keeps the record.
      await prisma.groupMembership.updateMany({
        where: { studentId: moved.recordId, endedAt: null },
        data: { endedAt: new Date() },
      });
      await addToGroup(app, moved.recordId, g3.id);

      clock.set(at('10:40'));
      const table = await tableOf(visit.id);
      expect(table).toMatchObject({
        window: { state: 'OPEN' },
        absencesProcessed: false,
        counts: { expected: 3, present: 2, late: 1, absent: 0, notRecorded: 1 },
      });
      expect(table.visit.groups.map((g) => g.name)).toEqual(['المجموعة أ', 'المجموعة ب']);
      const rowOf = (s: Student) => table.rows.find((r) => r.student.id === s.recordId);
      expect(table.rows).toHaveLength(4);
      expect(rowOf(moved)).toMatchObject({ expected: false, group: { id: group.id } });
      expect(rowOf(c)).toMatchObject({ expected: true, record: null, group: { id: g2.id } });
      expect(rowOf(b)!.record).toMatchObject({ status: 'LATE', minutesLate: 15, source: 'QR' });

      const ids = (t: typeof table) => t.rows.map((r) => r.student.id).sort();
      expect(ids(await tableOf(visit.id, `?group=${g2.id}`))).toEqual(
        [b.recordId, c.recordId].sort(),
      );
      expect(ids(await tableOf(visit.id, '?status=NOT_RECORDED'))).toEqual([c.recordId]);
      expect(ids(await tableOf(visit.id, '?status=LATE'))).toEqual([b.recordId]);
      expect(ids(await tableOf(visit.id, `?q=${b.user.seatNumber}`))).toEqual([b.recordId]);
      // Arabic search ignores hamza variants.
      expect(ids(await tableOf(visit.id, `?q=${encodeURIComponent('احمد')}`))).toEqual([
        a.recordId,
      ]);

      // Once the window closes, the figures are final even before the scheduler runs.
      clock.set(at('11:01'));
      const closed = await tableOf(visit.id);
      expect(closed).toMatchObject({
        window: { state: 'CLOSED' },
        absencesProcessed: true,
        counts: { expected: 3, present: 2, late: 1, absent: 1, notRecorded: 0 },
      });
      expect(closed.rows.find((r) => r.student.id === c.recordId)!.record).toMatchObject({
        status: 'ABSENT',
        source: 'AUTOMATIC',
      });

      // Students never see the staff table.
      expectError(
        await http().get(`/visits/${visit.id}/attendance`).set(bearer(a.token)),
        403,
        'FORBIDDEN',
      );
    });

    it('validates corrections: status and minutes, timing, and who can be corrected', async () => {
      const visit = await tenOClock();
      const s = await studentIn(group.id);
      const outsider = await studentIn((await createGroup(app)).id);

      clock.set(at('09:00'));
      expectError(
        await correct(visit.id, s.recordId, { status: 'PRESENT' }),
        409,
        'VISIT_NOT_STARTED',
      );

      clock.set(at('10:30'));
      const noMinutes = await correct(visit.id, s.recordId, { status: 'LATE' });
      expectError(noMinutes, 400, 'VALIDATION_FAILED');
      expect(noMinutes.body.details).toEqual({ minutesLate: ['LATE_MINUTES_REQUIRED'] });
      const extraMinutes = await correct(visit.id, s.recordId, {
        status: 'PRESENT',
        minutesLate: 3,
      });
      expect(extraMinutes.body.details).toEqual({ minutesLate: ['MINUTES_ONLY_WHEN_LATE'] });
      expectError(
        await correct(visit.id, s.recordId, { status: 'LATE', minutesLate: 0 }),
        400,
        'VALIDATION_FAILED',
      );
      expectError(
        await correct(visit.id, s.recordId, { status: 'EXCUSED' }),
        400,
        'VALIDATION_FAILED',
      );
      expectError(
        await correct(visit.id, outsider.recordId, { status: 'PRESENT' }),
        409,
        'NOT_IN_VISIT_GROUP',
      );
      expectError(
        await correct(visit.id, '01900000-0000-7000-8000-000000000000', { status: 'PRESENT' }),
        404,
        'NOT_FOUND',
      );
      expectError(
        await correct('01900000-0000-7000-8000-000000000000', s.recordId, { status: 'PRESENT' }),
        404,
        'NOT_FOUND',
      );
      expectError(
        await correct(visit.id, s.recordId, { status: 'PRESENT' }, s.token),
        403,
        'FORBIDDEN',
      );
      expect(await recordsOf(visit.id)).toHaveLength(0);
    });

    it('records who corrected what, when and why; audits it; tells the student (§8.4)', async () => {
      const visit = await tenOClock();
      const scanned = await studentIn(group.id);
      const missed = await studentIn(group.id);
      clock.set(at('10:05'));
      await checkIn(scanned, { token: qr.sign(visit.id), location: HERE }).expect(201);
      clock.set(at('11:30'));
      await tableOf(visit.id); // finalizes absences

      const facultyName = (await prisma.user.findUniqueOrThrow({ where: { id: faculty.id } }))
        .displayName;
      const reason = 'وصل مع الحافلة المتأخرة';
      const first = VisitAttendanceRowSchema.parse(
        (
          await correct(visit.id, missed.recordId, {
            status: 'LATE',
            minutesLate: 12,
            reason,
          }).expect(200)
        ).body,
      );
      expect(first.record).toMatchObject({
        status: 'LATE',
        minutesLate: 12,
        source: 'MANUAL',
        checkedInAt: null,
        correction: { at: at('11:30').toISOString(), by: facultyName, reason },
      });

      // Correcting a scanned record keeps the original scan and location.
      const second = VisitAttendanceRowSchema.parse(
        (
          await correct(visit.id, scanned.recordId, {
            status: 'ABSENT',
            reason: 'Left before the visit started',
          }).expect(200)
        ).body,
      );
      expect(second.record).toMatchObject({
        status: 'ABSENT',
        minutesLate: 0,
        source: 'MANUAL',
        checkedInAt: at('10:05').toISOString(),
        location: { latitude: HERE.latitude },
      });

      clock.set(at('12:00'));
      await correct(visit.id, missed.recordId, {
        status: 'PRESENT',
        reason: 'Confirmed by the site supervisor',
      }).expect(200);

      const recordId = first.record!.id;
      const history = await prisma.auditLog.findMany({
        where: { action: 'attendance.corrected', resourceId: recordId },
        orderBy: { id: 'asc' },
      });
      expect(history).toHaveLength(2);
      expect(history[0]).toMatchObject({
        actorId: faculty.id,
        actorRole: 'FACULTY',
        reason,
        before: { status: 'ABSENT', minutesLate: 0, source: 'AUTOMATIC' },
        after: { status: 'LATE', minutesLate: 12, source: 'MANUAL', studentId: missed.recordId },
      });
      expect(history[1]).toMatchObject({
        before: { status: 'LATE', minutesLate: 12, source: 'MANUAL' },
        after: { status: 'PRESENT', minutesLate: 0 },
      });

      // The absence job never overwrites the correction.
      await prisma.trainingVisit.update({
        where: { id: visit.id },
        data: { absencesProcessedAt: null },
      });
      await runJob();
      expect(
        await prisma.attendanceRecord.findUniqueOrThrow({ where: { id: recordId } }),
      ).toMatchObject({ status: 'PRESENT', source: 'MANUAL' });

      // The student is told, and sees the reason but not who made the correction.
      await app.get(BackgroundTasks).drain();
      const notices = await prisma.notification.findMany({
        where: { recipientId: missed.user.id },
        orderBy: { createdAt: 'asc' },
      });
      expect(notices.map((n) => n.type).sort()).toEqual([
        'attendance.absent',
        'attendance.corrected',
        'attendance.corrected',
      ]);
      const own = OwnAttendanceResponseSchema.parse(
        (await http().get('/me/attendance').set(bearer(missed.token)).expect(200)).body,
      );
      expect(own.records).toEqual([
        expect.objectContaining({
          status: 'PRESENT',
          source: 'MANUAL',
          note: 'Confirmed by the site supervisor',
        }),
      ]);
      const ctx = await contextOf(missed, qr.sign(visit.id));
      expect(ctx.existing!.correction).toMatchObject({ by: null });
      expect(JSON.stringify(own)).not.toContain(facultyName);
      expect(JSON.stringify(ctx)).not.toContain(facultyName);
      expect(JSON.stringify(notices.map((n) => n.data))).not.toContain(facultyName);
    });

    it('refuses corrections from a faculty member denied attendance.correct', async () => {
      const visit = await tenOClock();
      const s = await studentIn(group.id);
      await prisma.userPermissionGrant.create({
        data: {
          userId: faculty.id,
          permissionKey: 'attendance.correct',
          effect: 'DENY',
          grantedById: director.id,
          reason: 'Read-only assistant',
        },
      });
      clock.set(at('10:30'));
      expectError(await correct(visit.id, s.recordId, { status: 'PRESENT' }), 403, 'FORBIDDEN');
      await tableOf(visit.id);
      expect(await recordsOf(visit.id)).toHaveLength(0);
    });
  });

  /* ─────────────────────────── dashboards ─────────────────────────── */

  describe('dashboards (§9.1, §10.1)', () => {
    it('summarizes the student’s attendance with the configured absence allowance', async () => {
      await prisma.trainingProgram.update({
        where: { id: programId },
        data: { allowedAbsences: 3 },
      });
      const g2 = await createGroup(app, 'المجموعة ب');
      const s = await studentIn(group.id);
      const peer = await studentIn(g2.id);
      const v1 = await tenOClock({ date: '2026-12-01', title: 'V1' });
      const v2 = await tenOClock({ date: '2026-12-03', title: 'V2' });
      const v3 = await tenOClock({ date: '2026-12-08', title: 'V3' });
      const v4 = await tenOClock({ date: '2026-12-10', title: 'V4' });
      await tenOClock({ date: '2026-12-20', title: 'V5' });
      await tenOClock({ date: '2026-12-05', title: 'V6' }, [g2.id]);

      clock.set(at('10:00', '2026-12-01'));
      await checkIn(s, { token: qr.sign(v1.id), location: HERE }).expect(201);
      clock.set(at('10:20', '2026-12-03'));
      await checkIn(s, { token: qr.sign(v2.id), location: HERE }).expect(201);
      // V4: checked in, then the visit was cancelled during its window.
      clock.set(at('10:00', '2026-12-10'));
      await checkIn(s, { token: qr.sign(v4.id), location: HERE }).expect(201);
      clock.set(at('10:30', '2026-12-10'));
      await http()
        .post(`/visits/${v4.id}/cancel`)
        .set(bearer(facultyToken))
        .send({ reason: 'Site closed' })
        .expect(200);

      // No scheduler run: the dashboard finalizes V3's absence itself.
      clock.set(at('12:00'));
      const own = OwnAttendanceResponseSchema.parse(
        (await http().get('/me/attendance').set(bearer(s.token)).expect(200)).body,
      );
      expect(own.summary).toEqual({
        scheduledVisits: 4,
        upcomingVisits: 1,
        attended: 2,
        present: 1,
        late: 1,
        absent: 1,
        allowedAbsences: 3,
        remainingAbsences: 2,
      });
      expect(own.records.map((r) => [r.visit.title, r.status, r.minutesLate, r.source])).toEqual([
        ['V3', 'ABSENT', 0, 'AUTOMATIC'],
        ['V2', 'LATE', 5, 'QR'],
        ['V1', 'PRESENT', 0, 'QR'],
      ]);
      expect(JSON.stringify(own)).not.toContain(String(HERE.latitude));
      // The cancelled visit's record is kept, but counts nowhere.
      expect(await recordsOf(v4.id)).toHaveLength(1);
      expect(
        (await prisma.attendanceRecord.findMany({ where: { visitId: v3.id } })).map(
          (r) => r.studentId,
        ),
      ).toEqual([s.recordId]);

      const overview = AttendanceOverviewSchema.parse(
        (await http().get('/attendance/overview').set(bearer(facultyToken)).expect(200)).body,
      );
      expect(overview).toMatchObject({
        visits: { total: 5, completed: 4, remaining: 1, nextSevenDays: 1 },
        records: { present: 1, late: 1, absent: 2 },
      });
      expect(overview.groups).toEqual([
        { group, completedVisits: 3, present: 1, late: 1, absent: 1 },
        { group: g2, completedVisits: 1, present: 0, late: 0, absent: 1 },
      ]);
      expect(
        (await prisma.attendanceRecord.findFirstOrThrow({ where: { studentId: peer.recordId } }))
          .status,
      ).toBe('ABSENT');

      // A student without a group has nothing scheduled.
      const loner = await studentIn(null);
      const empty = OwnAttendanceResponseSchema.parse(
        (await http().get('/me/attendance').set(bearer(loner.token)).expect(200)).body,
      );
      expect(empty).toEqual({
        summary: expect.objectContaining({ scheduledVisits: 0, absent: 0, remainingAbsences: 3 }),
        records: [],
      });

      expectError(await http().get('/me/attendance').set(bearer(facultyToken)), 403, 'FORBIDDEN');
      expectError(await http().get('/attendance/overview').set(bearer(s.token)), 403, 'FORBIDDEN');
    });
  });

  /* ─────────────────────────── QR codes ─────────────────────────── */

  describe('visit QR codes (§7.1, §7.2)', () => {
    it('gives staff a stable signed attendance code and a details code', async () => {
      const visit = await tenOClock();
      const res = await http().get(`/visits/${visit.id}/qr`).set(bearer(facultyToken)).expect(200);
      const codes = VisitQrCodesSchema.parse(res.body);
      const token = qr.sign(visit.id);
      expect(codes.details.url).toBe(`${origin}/visits/${visit.id}`);
      expect(codes.attendance.url).toBe(`${origin}/check-in/${token}`);
      // Stable: the same code every time, for the whole visit.
      const again = VisitQrCodesSchema.parse(
        (await http().get(`/visits/${visit.id}/qr`).set(bearer(directorToken)).expect(200)).body,
      );
      expect(again.attendance.url).toBe(codes.attendance.url);
      // Only the visit id and a MAC — no student data.
      expect(token).toHaveLength(43);
      expect(Buffer.from(token, 'base64url').subarray(0, 16).toString('hex')).toBe(
        visit.id.replace(/-/g, ''),
      );
      for (const code of [codes.details, codes.attendance]) {
        expect(code.svg.startsWith('data:image/svg+xml;base64,')).toBe(true);
        const svg = Buffer.from(code.svg.split(',')[1]!, 'base64').toString('utf8');
        expect(svg).toContain('<svg');
      }

      // The printed code works for check-in.
      const s = await studentIn(group.id);
      clock.set(at('10:00'));
      const scanned = codes.attendance.url.split('/check-in/')[1]!;
      await checkIn(s, { token: scanned, location: HERE }).expect(201);

      expectError(
        await http().get(`/visits/${visit.id}/qr`).set(bearer(s.token)),
        403,
        'FORBIDDEN',
      );
      expectError(
        await http()
          .get('/visits/01900000-0000-7000-8000-000000000000/qr')
          .set(bearer(facultyToken)),
        404,
        'NOT_FOUND',
      );
    });
  });

  /* ─────────────────────────── the scheduler endpoint ─────────────────────────── */

  describe('the automatic absence endpoint (§8.3)', () => {
    it('answers only to the cron key', async () => {
      const path = '/internal/attendance/process-absences';
      expectError(await http().post(path), 401, 'AUTH_REQUIRED');
      expectError(await http().post(path).set('x-ftms-cron-key', 'guess'), 401, 'AUTH_REQUIRED');
      expectError(await http().post(path).set(bearer(directorToken)), 401, 'AUTH_REQUIRED');
      expect(await runJob()).toEqual({ visits: 0, absences: 0, notified: 0 });
    });
  });
});
