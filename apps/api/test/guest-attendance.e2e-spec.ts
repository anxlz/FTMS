import { createHmac, randomUUID } from 'node:crypto';
import {
  GuestCheckInContextSchema,
  GuestCheckInResultSchema,
  type LocalDate,
  OwnAttendanceResponseSchema,
  PROGRAM_TIME_ZONE,
  VisitAttendanceResponseSchema,
  zonedToUtc,
} from '@ftms/core';
import request from 'supertest';
import { AttendanceTokens } from '../src/attendance/attendance-tokens';
import { PrismaService } from '../src/prisma/prisma.service';
import {
  addToGroup,
  bearer,
  bootTestApp,
  createGroup,
  createProgram,
  createStudentRecord,
  createUser,
  createVisit,
  fromClientIp,
  login,
  recordOf,
  resetDatabase,
  type SeededUser,
  type TestApp,
  TestClock,
} from './helpers/test-app';

/** A winter day: Cairo is UTC+2. */
const DAY: LocalDate = '2026-12-15';
const SITE = { latitude: 30.0444, longitude: 31.2357 };
/** ~110 m from the site, precise. */
const HERE = { latitude: 30.0454, longitude: 31.2357, accuracy: 15 };
/** ~2.2 km from the site. */
const FAR = { latitude: 30.0644, longitude: 31.2357, accuracy: 15 };

const at = (time: string, date: LocalDate = DAY): Date => {
  const [hh, mm, ss = '0'] = time.split(':');
  const minute = zonedToUtc(date, `${hh}:${mm}`, PROGRAM_TIME_ZONE);
  return new Date(minute.getTime() + Number(ss) * 1000);
};

/**
 * Guest attendance (Phase 8, §12.3 of the Phase 8 prompt): a printed visit QR
 * code, a typed full name and seat number, and the device location — without an
 * account, a session, a password, a code, biometrics or any identity check. The
 * typed identity is accepted unverified; the token, the window, the form, the
 * location policy and abuse limits are enforced.
 */
describe('Guest attendance without signing in (Phase 8)', () => {
  const clock = new TestClock();
  let app: TestApp;
  let prisma: PrismaService;
  let qr: AttendanceTokens;
  const http = () => request(app.getHttpServer());

  let faculty: SeededUser;
  let facultyToken: string;
  let programId: string;
  let group: { id: string; name: string };
  let other: { id: string; name: string };

  beforeAll(async () => {
    ({ app } = await bootTestApp({ clock }));
    prisma = app.get(PrismaService);
    qr = app.get(AttendanceTokens);
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(async () => {
    clock.reset();
    await resetDatabase(app);
    faculty = await createUser(app, 'FACULTY');
    facultyToken = (await login(app, faculty.email, faculty.password!)).accessToken;
    programId = (await createProgram(app)).id;
    group = await createGroup(app, 'المجموعة أ');
    other = await createGroup(app, 'المجموعة ب');
  });

  /* ─────────────────────────── helpers ─────────────────────────── */

  const tenOClock = (options: Parameters<typeof createVisit>[3] = {}) =>
    createVisit(app, programId, [group.id], {
      date: DAY,
      startTime: '10:00',
      coordinates: SITE,
      title: 'زيارة مزرعة الخضر',
      ...options,
    });

  /** A student record in a group; with an account when `account` is set. */
  async function student(
    groupId: string | null,
    account = false,
    fullName = 'منى أحمد علي حسن',
  ): Promise<{ id: string; seat: string; user: SeededUser | null }> {
    if (account) {
      const user = await createUser(app, 'STUDENT');
      const id = await recordOf(app, user.id);
      await prisma.studentProfile.update({ where: { id }, data: { fullName } });
      if (groupId) await addToGroup(app, id, groupId);
      return { id, seat: user.seatNumber!, user };
    }
    const record = await createStudentRecord(app, { fullName });
    if (groupId) await addToGroup(app, record.id, groupId);
    return { id: record.id, seat: record.seatNumber, user: null };
  }

  const submit = (body: Record<string, unknown>, headers: Record<string, string> = {}) =>
    http().post('/attendance/guest/check-in').set(headers).send(body);

  const form = (token: string, fullName: string, seatNumber: string, extra: object = {}) => ({
    token,
    submissionKey: randomUUID(),
    fullName,
    seatNumber,
    location: HERE,
    ...extra,
  });

  const expectError = (res: request.Response, status: number, code: string) =>
    expect({ status: res.status, code: res.body?.code }).toEqual({ status, code });

  const guestRows = (visitId: string) =>
    prisma.guestCheckIn.findMany({ where: { visitId }, orderBy: { createdAt: 'asc' } });

  /* ─────────────────────────── the flow ─────────────────────────── */

  it('shows a guest only the visit, the window and the location rule', async () => {
    const visit = await tenOClock();
    clock.set(at('09:50'));
    const token = qr.sign(visit.id);
    const res = await http().post('/attendance/guest/context').send({ token }).expect(200);
    const context = GuestCheckInContextSchema.parse(res.body);
    const body = res.body as { visit: object };
    expect(Object.keys(body).sort()).toEqual(['location', 'serverTime', 'visit', 'window']);
    expect(Object.keys(body.visit).sort()).toEqual([
      'date',
      'endTime',
      'locationName',
      'startTime',
      'status',
      'title',
    ]);
    expect(context).toMatchObject({
      visit: { title: 'زيارة مزرعة الخضر', date: DAY, startTime: '10:00', status: 'SCHEDULED' },
      window: { state: 'OPEN', opensAt: at('09:45').toISOString() },
      location: { radiusMeters: null, maxAccuracyMeters: null, areaEnforced: false },
    });
    // No groups, students, records or internal ids.
    const text = JSON.stringify(res.body);
    expect(text).not.toContain(visit.id);
    expect(text).not.toContain(group.name);
    expectError(
      await http()
        .post('/attendance/guest/context')
        .send({ token: qr.sign(randomUUID()) }),
      404,
      'QR_INVALID',
    );
  });

  it('records attendance with no account, session, password, code, biometrics or identity check', async () => {
    const visit = await tenOClock();
    // One student has no account at all; one has an account with a registered device.
    const noAccount = await student(group.id, false, 'سارة إبراهيم محمود علي');
    const withAccount = await student(group.id, true, 'منى أحمد علي حسن');
    await prisma.webAuthnCredential.create({
      data: {
        userId: withAccount.user!.id,
        credentialId: 'existing-passkey-0123456789',
        publicKey: Buffer.from('cose'),
        transports: ['internal'],
        multiDevice: false,
        backedUp: false,
        name: 'Phone',
      },
    });
    clock.set(at('10:05'));
    const token = qr.sign(visit.id);

    for (const s of [noAccount, withAccount]) {
      const name = s === noAccount ? 'سارة إبراهيم محمود علي' : 'منى أحمد علي حسن';
      // No Authorization header, no cookie: only the QR token, the form and the location.
      const res = await submit(form(token, name, s.seat)).expect(201);
      const { receipt } = GuestCheckInResultSchema.parse(res.body);
      expect(receipt).toMatchObject({
        status: 'PRESENT',
        minutesLate: 0,
        submittedAt: at('10:05').toISOString(),
        visitTitle: 'زيارة مزرعة الخضر',
      });
    }
    const records = await prisma.attendanceRecord.findMany({ where: { visitId: visit.id } });
    expect(
      records.map((r) => [r.studentId, r.source, r.status, r.biometricVerified]).sort(),
    ).toEqual(
      [
        [noAccount.id, 'GUEST', 'PRESENT', false],
        [withAccount.id, 'GUEST', 'PRESENT', false],
      ].sort(),
    );
    expect(records.every((r) => r.latitude === HERE.latitude && r.accuracyMeters === 15)).toBe(
      true,
    );
    const rows = await guestRows(visit.id);
    expect(rows.map((r) => [r.outcome, r.nameMatches])).toEqual([
      ['RECORDED', true],
      ['RECORDED', true],
    ]);
    // No session was created and no challenge was issued.
    expect(await prisma.authSession.count({ where: { userId: withAccount.user!.id } })).toBe(0);
    expect(await prisma.webAuthnChallenge.count()).toBe(0);
    // The student with an account learns that a guest submission recorded them.
    const note = await prisma.notification.findFirstOrThrow({
      where: { recipientId: withAccount.user!.id, type: 'attendance.guest_recorded' },
    });
    expect(note.data).toMatchObject({ title: 'زيارة مزرعة الخضر', status: 'PRESENT' });
  });

  it('classifies by the server clock: 09:44 refused, 09:45–10:15 Present, 10:16–11:00 Late, then refused', async () => {
    const visit = await tenOClock();
    const token = qr.sign(visit.id);
    const cases: { time: string; status?: string; minutesLate?: number; error?: string }[] = [
      { time: '09:44:59', error: 'CHECK_IN_NOT_OPEN' },
      { time: '09:45:00', status: 'PRESENT', minutesLate: 0 },
      { time: '10:00:00', status: 'PRESENT', minutesLate: 0 },
      { time: '10:15:59', status: 'PRESENT', minutesLate: 0 },
      { time: '10:16:00', status: 'LATE', minutesLate: 1 },
      { time: '11:00:59', status: 'LATE', minutesLate: 45 },
      { time: '11:01:00', error: 'CHECK_IN_CLOSED' },
    ];
    for (const c of cases) {
      const s = await student(group.id);
      clock.set(at(c.time));
      const res = await submit(
        form(token, 'منى أحمد علي حسن', s.seat, { status: 'PRESENT', minutesLate: 0 }),
      );
      if (c.error) {
        expectError(res, 409, c.error);
        continue;
      }
      expect(res.status).toBe(201);
      expect(res.body.receipt).toMatchObject({ status: c.status, minutesLate: c.minutesLate });
    }
    expect(await guestRows(visit.id)).toHaveLength(5);
  });

  it('answers the same whatever the seat number matches, and reveals no student or record', async () => {
    const visit = await tenOClock();
    const fresh = await student(group.id);
    const recorded = await student(group.id, false, 'Omar Khaled Hassan');
    const elsewhere = await student(other.id);
    clock.set(at('10:00'));
    await prisma.attendanceRecord.create({
      data: {
        visitId: visit.id,
        studentId: recorded.id,
        groupId: group.id,
        status: 'PRESENT',
        checkedInAt: at('09:50'),
        source: 'QR',
      },
    });
    clock.set(at('10:20'));
    const token = qr.sign(visit.id);
    const answers = [];
    for (const seat of [fresh.seat, recorded.seat, 'X-404', elsewhere.seat]) {
      const res = await submit(form(token, 'Typed Name Here', seat)).expect(201);
      answers.push(res.body);
    }
    // Same shape, same values except the receipt id: nothing tells the cases apart.
    expect(new Set(answers.map((a) => JSON.stringify({ ...a.receipt, id: 0 })))).toEqual(
      new Set([
        JSON.stringify({
          id: 0,
          status: 'LATE',
          minutesLate: 5,
          submittedAt: at('10:20').toISOString(),
          visitTitle: 'زيارة مزرعة الخضر',
        }),
      ]),
    );
    const text = JSON.stringify(answers);
    for (const secret of ['Omar Khaled Hassan', recorded.id, fresh.id, group.id, 'PRESENT']) {
      expect(text).not.toContain(secret);
    }
    expect((await guestRows(visit.id)).map((r) => r.outcome)).toEqual([
      'RECORDED',
      'DUPLICATE',
      'UNMATCHED',
      'UNMATCHED',
    ]);
    // The earlier signed-in record is untouched.
    expect(
      await prisma.attendanceRecord.findFirst({
        where: { visitId: visit.id, studentId: recorded.id },
      }),
    ).toMatchObject({ source: 'QR', status: 'PRESENT' });
  });

  it('accepts any well-formed typed name and seat number — not verified — and refuses malformed ones', async () => {
    const visit = await tenOClock();
    const s = await student(group.id, false, 'منى أحمد علي حسن');
    clock.set(at('10:00'));
    const token = qr.sign(visit.id);
    // A name that is not the record's: accepted (not verified), flagged for staff.
    await submit(form(token, 'Someone Else Entirely', ` ${s.seat.toLowerCase()} `)).expect(201);
    expect((await guestRows(visit.id))[0]).toMatchObject({
      fullName: 'Someone Else Entirely',
      seatNumber: s.seat,
      outcome: 'RECORDED',
      nameMatches: false,
    });
    for (const bad of [
      { fullName: 'ab' },
      { fullName: '<b>x</b>' },
      { seatNumber: '' },
      { seatNumber: 'seat #1' },
      { submissionKey: 'not-a-uuid' },
    ]) {
      const res = await submit({ ...form(token, 'منى أحمد علي حسن', 'G-1'), ...bad });
      expectError(res, 400, 'VALIDATION_FAILED');
    }
    // Nothing else is asked for: extra identity fields are ignored, not required.
    const res = await submit(
      form(token, 'Third Person Name', 'G-2', {
        password: 'x',
        code: '123456',
        universityEmail: 'a@agr.asu.edu.eg',
        biometric: { ok: true },
        identityDocument: 'x',
      }),
    );
    expect(res.status).toBe(201);
    expect(await guestRows(visit.id)).toHaveLength(2);
  });

  it('refuses invalid QR codes, cancelled visits and closed windows, storing nothing', async () => {
    const visit = await tenOClock();
    const cancelled = await tenOClock({ status: 'CANCELLED' });
    const s = await student(group.id);
    clock.set(at('10:00'));
    const good = qr.sign(visit.id);
    const id = Buffer.from(visit.id.replace(/-/g, ''), 'hex');
    const forged = Buffer.concat([
      id,
      createHmac('sha256', 'not-our-key')
        .update('ftms:attendance-qr:v1:')
        .update(id)
        .digest()
        .subarray(0, 16),
    ]).toString('base64url');
    for (const token of [forged, `${good.slice(0, -2)}AA`, qr.sign(randomUUID())]) {
      expectError(await submit(form(token, 'منى أحمد علي حسن', s.seat)), 404, 'QR_INVALID');
    }
    expectError(
      await submit(form('not a token!', 'منى أحمد علي حسن', s.seat)),
      400,
      'VALIDATION_FAILED',
    );
    expectError(
      await submit(form(qr.sign(cancelled.id), 'منى أحمد علي حسن', s.seat)),
      409,
      'VISIT_CANCELLED',
    );
    clock.set(at('12:00'));
    expectError(await submit(form(good, 'منى أحمد علي حسن', s.seat)), 409, 'CHECK_IN_CLOSED');
    expect(await prisma.guestCheckIn.count()).toBe(0);
    expect(await prisma.attendanceRecord.count()).toBe(0);
  });

  it('requires a location reading and applies the location policy', async () => {
    await prisma.trainingProgram.update({
      where: { id: programId },
      data: { locationRadiusMeters: 300, locationMaxAccuracyMeters: 50 },
    });
    const visit = await tenOClock();
    const s = await student(group.id);
    clock.set(at('10:00'));
    const token = qr.sign(visit.id);
    const context = await http().post('/attendance/guest/context').send({ token }).expect(200);
    expect(context.body.location).toEqual({
      radiusMeters: 300,
      maxAccuracyMeters: 50,
      areaEnforced: true,
    });
    const base = form(token, 'منى أحمد علي حسن', s.seat);
    const missing = await submit({ ...base, location: undefined });
    expectError(missing, 400, 'GEOLOCATION_REQUIRED');
    expectError(await submit({ ...base, location: FAR }), 422, 'LOCATION_OUTSIDE_AREA');
    expectError(
      await submit({ ...base, location: { ...HERE, accuracy: 120 } }),
      422,
      'LOCATION_INACCURATE',
    );
    expectError(
      await submit({ ...base, location: FAR, locationValid: true, withinArea: true }),
      422,
      'LOCATION_OUTSIDE_AREA',
    );
    expect(await prisma.guestCheckIn.count()).toBe(0);
    await submit(base).expect(201);
    expect((await guestRows(visit.id))[0]!.distanceMeters).toBeLessThan(300);
  });

  it('answers a retried submission with the first result, and keeps one record per student', async () => {
    const visit = await tenOClock();
    const s = await student(group.id);
    clock.set(at('10:10'));
    const token = qr.sign(visit.id);
    const body = form(token, 'منى أحمد علي حسن', s.seat);
    const first = await submit(body).expect(201);
    clock.set(at('10:40'));
    const retry = await submit(body).expect(201);
    expect(retry.body).toEqual(first.body);
    // Even once the window has closed, a retry of the same submission gets its answer.
    clock.set(at('12:00'));
    expect((await submit(body).expect(201)).body).toEqual(first.body);
    expect(await guestRows(visit.id)).toHaveLength(1);

    // Concurrent retries of one submission, and concurrent submissions for one seat.
    clock.set(at('10:20'));
    const t = await student(group.id);
    const same = form(token, 'منى أحمد علي حسن', t.seat);
    const results = await Promise.all([
      submit(same),
      submit(same),
      submit(form(token, 'منى أحمد علي حسن', t.seat)),
      submit(form(token, 'منى أحمد علي حسن', t.seat)),
    ]);
    expect(results.map((r) => r.status)).toEqual([201, 201, 201, 201]);
    expect(results[0].body).toEqual(results[1].body);
    const rows = await prisma.guestCheckIn.findMany({ where: { seatNumber: t.seat } });
    expect(rows).toHaveLength(3);
    expect(rows.filter((r) => r.outcome === 'RECORDED')).toHaveLength(1);
    expect(
      await prisma.attendanceRecord.count({ where: { visitId: visit.id, studentId: t.id } }),
    ).toBe(1);
  });

  it('counts a guest record like any record, and keeps staff corrections authoritative', async () => {
    const visit = await tenOClock();
    const guest = await student(group.id, true, 'منى أحمد علي حسن');
    const absent = await student(group.id);
    clock.set(at('10:30'));
    const token = qr.sign(visit.id);
    await submit(form(token, 'منى أحمد علي حسن', guest.seat)).expect(201);
    await submit(form(token, 'Unknown Person', 'NOPE-1')).expect(201);

    // The signed-in path sees the guest record as already recorded.
    const studentToken = (await login(app, guest.user!.email, guest.user!.password!)).accessToken;
    const signedIn = await http()
      .post('/attendance/check-in')
      .set(bearer(studentToken))
      .send({ token, location: HERE });
    expectError(signedIn, 409, 'ATTENDANCE_ALREADY_RECORDED');

    // After the window: the absence job marks only the student with no record absent.
    clock.set(at('12:00'));
    await http()
      .post('/internal/attendance/process-absences')
      .set('x-ftms-cron-key', process.env.CRON_SECRET!)
      .expect(200);
    const table = VisitAttendanceResponseSchema.parse(
      (await http().get(`/visits/${visit.id}/attendance`).set(bearer(facultyToken)).expect(200))
        .body,
    );
    const byId = new Map(table.rows.map((r) => [r.student.id, r.record]));
    expect(byId.get(guest.id)).toMatchObject({ source: 'GUEST', status: 'LATE', minutesLate: 15 });
    expect(byId.get(absent.id)).toMatchObject({ source: 'AUTOMATIC', status: 'ABSENT' });
    expect(
      table.guestSubmissions.map((g) => [g.seatNumber, g.outcome, g.student?.id ?? null]),
    ).toEqual([
      ['NOPE-1', 'UNMATCHED', null],
      [guest.seat, 'RECORDED', guest.id],
    ]);
    // The student sees it in their own history, as a guest submission.
    const own = OwnAttendanceResponseSchema.parse(
      (await http().get('/me/attendance').set(bearer(studentToken)).expect(200)).body,
    );
    expect(own.records[0]).toMatchObject({ source: 'GUEST', status: 'LATE' });

    // A correction by staff wins; a later guest submission changes nothing.
    await http()
      .put(`/visits/${visit.id}/attendance/${guest.id}`)
      .set(bearer(facultyToken))
      .send({ status: 'PRESENT', reason: 'Bus delay confirmed' })
      .expect(200);
    clock.set(at('10:50'));
    await submit(form(token, 'منى أحمد علي حسن', guest.seat)).expect(201);
    expect(
      await prisma.attendanceRecord.findFirst({
        where: { visitId: visit.id, studentId: guest.id },
      }),
    ).toMatchObject({ source: 'MANUAL', status: 'PRESENT' });
  });

  it('records the submission in the audit log without the typed name or seat number', async () => {
    const visit = await tenOClock();
    const s = await student(group.id);
    clock.set(at('10:00'));
    await submit(form(qr.sign(visit.id), 'منى أحمد علي حسن', s.seat)).expect(201);
    const row = (await guestRows(visit.id))[0]!;
    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { action: 'attendance.guest_submitted' },
    });
    expect(audit).toMatchObject({
      actorId: null,
      resourceType: 'guest_check_in',
      resourceId: row.id,
      outcome: 'SUCCESS',
    });
    const logged = JSON.stringify([audit.before, audit.after, audit.metadata, audit.reason]);
    expect(logged).not.toContain('منى');
    expect(logged).not.toContain(s.seat);
    expect(logged).not.toContain(String(HERE.latitude));
  });

  it('limits guest submissions per client IP, and other clients are unaffected', async () => {
    const visit = await tenOClock();
    clock.set(at('10:00'));
    const unknown = qr.sign(randomUUID());
    const ip = fromClientIp('198.51.100.7');
    for (let i = 0; i < 120; i += 1) {
      expect((await submit(form(unknown, 'منى أحمد علي حسن', 'G-1'), ip)).status).toBe(404);
    }
    const refused = await submit(form(qr.sign(visit.id), 'منى أحمد علي حسن', 'G-1'), ip);
    expectError(refused, 429, 'AUTH_RATE_LIMITED');
    expect(Number(refused.headers['retry-after'])).toBeGreaterThan(0);
    await submit(
      form(qr.sign(visit.id), 'منى أحمد علي حسن', 'G-1'),
      fromClientIp('198.51.100.8'),
    ).expect(201);
  });

  it('keeps guest submissions append-only and consistent in the database', async () => {
    const visit = await tenOClock();
    const s = await student(group.id);
    clock.set(at('10:00'));
    await submit(form(qr.sign(visit.id), 'منى أحمد علي حسن', s.seat)).expect(201);
    const row = (await guestRows(visit.id))[0]!;
    await expect(
      prisma.guestCheckIn.update({ where: { id: row.id }, data: { fullName: 'Changed Name' } }),
    ).rejects.toThrow();
    await expect(prisma.guestCheckIn.delete({ where: { id: row.id } })).rejects.toThrow();
    const insert = (data: Record<string, unknown>) =>
      prisma.guestCheckIn.create({
        data: {
          visitId: visit.id,
          submissionKey: randomUUID(),
          fullName: 'Valid Name',
          seatNumber: 'G-9',
          status: 'PRESENT',
          submittedAt: new Date(),
          latitude: 30,
          longitude: 31,
          outcome: 'UNMATCHED',
          ...data,
        } as never,
      });
    await expect(insert({ status: 'ABSENT' })).rejects.toThrow();
    await expect(insert({ seatNumber: 'lower-case' })).rejects.toThrow();
    await expect(insert({ outcome: 'RECORDED' })).rejects.toThrow();
    await expect(insert({ studentId: s.id })).rejects.toThrow();
    const cancelled = await tenOClock({ status: 'CANCELLED' });
    await expect(insert({ visitId: cancelled.id })).rejects.toThrow();
    await insert({});
  });
});
