import { ListUsersResponseSchema, type Role, UserDetailSchema } from '@ftms/core';
import request from 'supertest';
import { AttendanceTokens } from '../src/attendance/attendance-tokens';
import { BackgroundTasks } from '../src/common/background-tasks.service';
import { PrismaService } from '../src/prisma/prisma.service';
import {
  addToGroup,
  bearer,
  bootTestApp,
  buildWorkbook,
  cairoDate,
  createGroup,
  createProgram,
  createStudentRecord,
  createUser,
  createVisit,
  login,
  type Mailbox,
  recordOf,
  resetDatabase,
  type SeededRecord,
  type SeededUser,
  TEMPLATE_HEADERS,
  type TestApp,
} from './helpers/test-app';

type Caller = Role | 'ANONYMOUS';
const CALLERS: Caller[] = ['SUPER_ADMIN', 'TRAINING_DIRECTOR', 'FACULTY', 'STUDENT', 'ANONYMOUS'];

describe('Authorization is enforced by the API, not the UI (§3, §20.7)', () => {
  let app: TestApp;
  let mailbox: Mailbox;
  let prisma: PrismaService;
  const http = () => request(app.getHttpServer());

  /** One signed-in account per role, plus fresh targets, recreated for every test. */
  let tokens: Record<Role, string>;
  let users: Record<Role, SeededUser>;

  let spreadsheet: Buffer;

  beforeAll(async () => {
    ({ app, mailbox } = await bootTestApp());
    prisma = app.get(PrismaService);
    spreadsheet = await buildWorkbook(TEMPLATE_HEADERS, [
      ['MX-1', 'محمد', 'أحمد', 'علي', 'حسن', null, null, null],
    ]);
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(async () => {
    await resetDatabase(app);
    mailbox.clear();
    users = {} as Record<Role, SeededUser>;
    tokens = {} as Record<Role, string>;
    for (const role of ['SUPER_ADMIN', 'TRAINING_DIRECTOR', 'FACULTY', 'STUDENT'] as Role[]) {
      users[role] = await createUser(app, role);
      tokens[role] = (await login(app, users[role].email, users[role].password!)).accessToken;
    }
  });

  const as = (caller: Caller) => (caller === 'ANONYMOUS' ? {} : bearer(tokens[caller]));

  /* ───────────────────────── endpoint × role matrix ───────────────────────── */

  interface Target {
    faculty: SeededUser;
    student: SeededUser;
    /** The record linked to `student`. */
    studentRecord: string;
    /** An unlinked student record, member of `busyGroup`. */
    record: SeededRecord;
    group: { id: string; name: string };
    busyGroup: { id: string; name: string };
    /** Phase 3: visits of the calling student's group, a schedule, a day off. */
    visit: string;
    cancelledVisit: string;
    fileId: string;
    schedule: string;
    exception: string;
    /** Phase 4: a finished visit of the calling student's group, and a signed QR token. */
    pastVisit: string;
    checkInToken: string;
    callingStudentRecord: string;
    /** Phase 5: the calling student's ticket; a request waiting for the calling student; one waiting for the faculty. */
    ticket: string;
    swapForStudent: string;
    swapForFaculty: string;
    otherGroup: string;
    otherStudentSeat: string;
    /** Phase 6: an event in the audit log. */
    auditEvent: string;
  }

  interface Case {
    name: string;
    send: (caller: Caller, target: Target) => request.Test;
    expected: Record<Caller, number>;
  }

  /** Staff with the default faculty permissions, but not students (Phase 2 endpoints). */
  const STAFF_ONLY = (ok: number): Record<Caller, number> => ({
    SUPER_ADMIN: ok,
    TRAINING_DIRECTOR: ok,
    FACULTY: ok,
    STUDENT: 403,
    ANONYMOUS: 401,
  });
  /** A student's own data: staff are refused by role. */
  const STUDENT_ONLY = (ok: number): Record<Caller, number> => ({
    SUPER_ADMIN: 403,
    TRAINING_DIRECTOR: 403,
    FACULTY: 403,
    STUDENT: ok,
    ANONYMOUS: 401,
  });
  const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  const PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
    'base64',
  );
  /** Phase 3 settings that only the Training Director (and Super Admin) hold by default. */
  const DIRECTOR_ONLY = (ok: number): Record<Caller, number> => ({
    SUPER_ADMIN: ok,
    TRAINING_DIRECTOR: ok,
    FACULTY: 403,
    STUDENT: 403,
    ANONYMOUS: 401,
  });
  /** Every signed-in account (each sees only its own scope). */
  const SIGNED_IN = (ok: number): Record<Caller, number> => ({
    SUPER_ADMIN: ok,
    TRAINING_DIRECTOR: ok,
    FACULTY: ok,
    STUDENT: ok,
    ANONYMOUS: 401,
  });

  const n = { i: 0 };
  const newStaff = (role: string) => ({
    role,
    email: `new-${role.toLowerCase()}-${++n.i}@agr.asu.edu.eg`,
    fullName: 'New Account Name',
  });

  const cases: Case[] = [
    {
      name: 'GET /auth/me',
      send: (c) => http().get('/auth/me').set(as(c)),
      expected: {
        SUPER_ADMIN: 200,
        TRAINING_DIRECTOR: 200,
        FACULTY: 200,
        STUDENT: 200,
        ANONYMOUS: 401,
      },
    },
    {
      name: 'GET /health (public)',
      send: (c) => http().get('/health').set(as(c)),
      expected: {
        SUPER_ADMIN: 200,
        TRAINING_DIRECTOR: 200,
        FACULTY: 200,
        STUDENT: 200,
        ANONYMOUS: 200,
      },
    },
    {
      name: 'GET /admin/users',
      send: (c) => http().get('/admin/users').set(as(c)),
      expected: {
        SUPER_ADMIN: 200,
        TRAINING_DIRECTOR: 200,
        FACULTY: 403,
        STUDENT: 403,
        ANONYMOUS: 401,
      },
    },
    {
      name: 'GET /admin/users/:id',
      send: (c, t) => http().get(`/admin/users/${t.student.id}`).set(as(c)),
      expected: {
        SUPER_ADMIN: 200,
        TRAINING_DIRECTOR: 200,
        FACULTY: 403,
        STUDENT: 403,
        ANONYMOUS: 401,
      },
    },
    {
      name: 'GET /admin/permissions',
      send: (c) => http().get('/admin/permissions').set(as(c)),
      expected: {
        SUPER_ADMIN: 200,
        TRAINING_DIRECTOR: 200,
        FACULTY: 403,
        STUDENT: 403,
        ANONYMOUS: 401,
      },
    },
    {
      name: 'POST /admin/users (FACULTY)',
      send: (c) => http().post('/admin/users').set(as(c)).send(newStaff('FACULTY')),
      expected: {
        SUPER_ADMIN: 201,
        TRAINING_DIRECTOR: 201,
        FACULTY: 403,
        STUDENT: 403,
        ANONYMOUS: 401,
      },
    },
    {
      name: 'POST /admin/users (TRAINING_DIRECTOR)',
      send: (c) => http().post('/admin/users').set(as(c)).send(newStaff('TRAINING_DIRECTOR')),
      expected: {
        SUPER_ADMIN: 201,
        TRAINING_DIRECTOR: 403,
        FACULTY: 403,
        STUDENT: 403,
        ANONYMOUS: 401,
      },
    },
    {
      name: 'POST /admin/users (SUPER_ADMIN)',
      send: (c) => http().post('/admin/users').set(as(c)).send(newStaff('SUPER_ADMIN')),
      expected: {
        SUPER_ADMIN: 201,
        TRAINING_DIRECTOR: 403,
        FACULTY: 403,
        STUDENT: 403,
        ANONYMOUS: 401,
      },
    },
    {
      name: 'POST /admin/users (STUDENT)',
      send: (c) =>
        http()
          .post('/admin/users')
          .set(as(c))
          .send({
            role: 'STUDENT',
            email: `stu${++n.i}@agr.asu.edu.eg`,
            fullName: 'New Student',
            seatNumber: `NEW-${n.i}`,
          }),
      expected: {
        SUPER_ADMIN: 201,
        TRAINING_DIRECTOR: 403,
        FACULTY: 403,
        STUDENT: 403,
        ANONYMOUS: 401,
      },
    },
    {
      name: 'PATCH /admin/users/:id/status (faculty target)',
      send: (c, t) =>
        http()
          .patch(`/admin/users/${t.faculty.id}/status`)
          .set(as(c))
          .send({ status: 'SUSPENDED', reason: 'matrix test' }),
      expected: {
        SUPER_ADMIN: 200,
        TRAINING_DIRECTOR: 200,
        FACULTY: 403,
        STUDENT: 403,
        ANONYMOUS: 401,
      },
    },
    {
      name: 'PATCH /admin/users/:id/status (student target)',
      send: (c, t) =>
        http()
          .patch(`/admin/users/${t.student.id}/status`)
          .set(as(c))
          .send({ status: 'SUSPENDED', reason: 'matrix test' }),
      expected: {
        SUPER_ADMIN: 200,
        TRAINING_DIRECTOR: 403,
        FACULTY: 403,
        STUDENT: 403,
        ANONYMOUS: 401,
      },
    },
    {
      name: 'PATCH /admin/users/:id/role',
      send: (c, t) =>
        http()
          .patch(`/admin/users/${t.faculty.id}/role`)
          .set(as(c))
          .send({ role: 'TRAINING_DIRECTOR', reason: 'matrix test' }),
      expected: {
        SUPER_ADMIN: 200,
        TRAINING_DIRECTOR: 403,
        FACULTY: 403,
        STUDENT: 403,
        ANONYMOUS: 401,
      },
    },
    {
      name: 'PUT /admin/users/:id/permissions',
      send: (c, t) =>
        http()
          .put(`/admin/users/${t.faculty.id}/permissions`)
          .set(as(c))
          .send({ grants: [{ permission: 'audit.read', effect: 'ALLOW' }], reason: 'matrix test' }),
      expected: {
        SUPER_ADMIN: 200,
        TRAINING_DIRECTOR: 403,
        FACULTY: 403,
        STUDENT: 403,
        ANONYMOUS: 401,
      },
    },

    /* ── Phase 2: student records, groups, imports, reviews ── */
    {
      name: 'GET /students',
      send: (c) => http().get('/students').set(as(c)),
      expected: STAFF_ONLY(200),
    },
    {
      name: 'GET /students/:id',
      send: (c, t) => http().get(`/students/${t.record.id}`).set(as(c)),
      expected: STAFF_ONLY(200),
    },
    {
      name: 'POST /students',
      send: (c) =>
        http()
          .post('/students')
          .set(as(c))
          .send({ seatNumber: `MX-${++n.i}`, name: { firstName: 'سارة', familyName: 'محمود' } }),
      expected: STAFF_ONLY(201),
    },
    {
      name: 'PATCH /students/:id',
      send: (c, t) =>
        http().patch(`/students/${t.record.id}`).set(as(c)).send({ phone: '01012345678' }),
      expected: STAFF_ONLY(200),
    },
    {
      name: 'DELETE /students/:id',
      send: (c, t) =>
        http().delete(`/students/${t.record.id}`).set(as(c)).send({ reason: 'matrix test' }),
      expected: STAFF_ONLY(204),
    },
    {
      name: 'PUT /students/:id/group',
      send: (c, t) =>
        http().put(`/students/${t.record.id}/group`).set(as(c)).send({ groupId: t.group.id }),
      expected: STAFF_ONLY(200),
    },
    {
      name: 'POST /students/:id/unlink-account',
      send: (c, t) =>
        http()
          .post(`/students/${t.studentRecord}/unlink-account`)
          .set(as(c))
          .send({ reason: 'matrix test' }),
      expected: STAFF_ONLY(200),
    },
    {
      name: 'GET /groups',
      send: (c) => http().get('/groups').set(as(c)),
      expected: STAFF_ONLY(200),
    },
    {
      name: 'POST /groups',
      send: (c) =>
        http()
          .post('/groups')
          .set(as(c))
          .send({ name: `Matrix group ${++n.i}` }),
      expected: STAFF_ONLY(201),
    },
    {
      name: 'GET /groups/:id',
      send: (c, t) => http().get(`/groups/${t.busyGroup.id}`).set(as(c)),
      expected: STAFF_ONLY(200),
    },
    {
      name: 'PATCH /groups/:id',
      send: (c, t) =>
        http()
          .patch(`/groups/${t.group.id}`)
          .set(as(c))
          .send({ name: `Renamed ${++n.i}` }),
      expected: STAFF_ONLY(200),
    },
    {
      name: 'PUT /groups/:id/archived',
      send: (c, t) =>
        http().put(`/groups/${t.group.id}/archived`).set(as(c)).send({ archived: true }),
      expected: STAFF_ONLY(200),
    },
    {
      name: 'POST /groups/:id/members',
      send: (c, t) =>
        http()
          .post(`/groups/${t.group.id}/members`)
          .set(as(c))
          .send({ studentIds: [t.record.id], moveFromOtherGroup: true }),
      expected: STAFF_ONLY(200),
    },
    {
      name: 'DELETE /groups/:id/members/:studentId',
      send: (c, t) =>
        http().delete(`/groups/${t.busyGroup.id}/members/${t.record.id}`).set(as(c)).send({}),
      expected: STAFF_ONLY(204),
    },
    {
      name: 'GET /student-imports',
      send: (c) => http().get('/student-imports').set(as(c)),
      expected: STAFF_ONLY(200),
    },
    {
      name: 'GET /student-imports/template',
      send: (c) => http().get('/student-imports/template').set(as(c)),
      expected: STAFF_ONLY(200),
    },
    {
      name: 'POST /student-imports (upload)',
      send: (c) =>
        http()
          .post('/student-imports')
          .set(as(c))
          .attach('file', spreadsheet, { filename: 'students.xlsx', contentType: XLSX }),
      expected: STAFF_ONLY(201),
    },
    {
      name: 'GET /profile-changes',
      send: (c) => http().get('/profile-changes').set(as(c)),
      expected: STAFF_ONLY(200),
    },
    {
      name: 'GET /student-verifications',
      send: (c) => http().get('/student-verifications').set(as(c)),
      expected: STAFF_ONLY(200),
    },
    {
      name: 'GET /me/student',
      send: (c) => http().get('/me/student').set(as(c)),
      expected: STUDENT_ONLY(200),
    },
    {
      name: 'PATCH /me/student',
      send: (c) => http().patch('/me/student').set(as(c)).send({ phone: '01012345678' }),
      expected: STUDENT_ONLY(200),
    },
    {
      name: 'GET /me/profile-changes',
      send: (c) => http().get('/me/profile-changes').set(as(c)),
      expected: STUDENT_ONLY(200),
    },
    {
      name: 'POST /me/profile-changes',
      send: (c) =>
        http()
          .post('/me/profile-changes')
          .set(as(c))
          .send({ seatNumber: `CHG-${++n.i}`, note: 'matrix test' }),
      expected: STUDENT_ONLY(201),
    },
    {
      name: 'GET /me/verification',
      send: (c) => http().get('/me/verification').set(as(c)),
      expected: STUDENT_ONLY(200),
    },
    {
      name: 'POST /me/verification (already verified)',
      send: (c) =>
        http().post('/me/verification').set(as(c)).send({
          seatNumber: 'V-1',
          firstName: 'محمد',
          fatherName: 'أحمد',
          grandfatherName: 'علي',
          familyName: 'حسن',
        }),
      expected: STUDENT_ONLY(409),
    },
    {
      name: 'POST /auth/signup/request (public)',
      send: (c) =>
        http()
          .post('/auth/signup/request')
          .set(as(c))
          .send({
            email: `signup${++n.i}@agr.asu.edu.eg`,
            seatNumber: `SU-${n.i}`,
            firstName: 'محمد',
            fatherName: 'أحمد',
            grandfatherName: 'علي',
            familyName: 'حسن',
          }),
      expected: {
        SUPER_ADMIN: 202,
        TRAINING_DIRECTOR: 202,
        FACULTY: 202,
        STUDENT: 202,
        ANONYMOUS: 202,
      },
    },
    /* ── Phase 3: program, schedules, visits, calendars, notifications ── */
    {
      name: 'GET /program',
      send: (c) => http().get('/program').set(as(c)),
      expected: STAFF_ONLY(200),
    },
    {
      name: 'POST /program (already configured)',
      send: (c) =>
        http()
          .post('/program')
          .set(as(c))
          .send({
            name: 'Second program',
            startDate: cairoDate(0),
            durationWeeks: 12,
            allowedAbsences: 2,
            timing: { checkInOpensMinutes: 15, graceMinutes: 15, checkInClosesMinutes: 60 },
          }),
      expected: DIRECTOR_ONLY(409),
    },
    {
      name: 'PATCH /program',
      send: (c) => http().patch('/program').set(as(c)).send({ name: 'Renamed program' }),
      expected: DIRECTOR_ONLY(200),
    },
    {
      name: 'GET /program/history',
      send: (c) => http().get('/program/history').set(as(c)),
      expected: DIRECTOR_ONLY(200),
    },
    {
      name: 'GET /schedules',
      send: (c) => http().get('/schedules').set(as(c)),
      expected: STAFF_ONLY(200),
    },
    {
      name: 'POST /schedules',
      send: (c, t) =>
        http()
          .post('/schedules')
          .set(as(c))
          .send({
            title: 'Matrix schedule',
            weekdays: [1],
            startTime: '10:00',
            startsOn: cairoDate(7),
            endsOn: cairoDate(13),
            groupIds: [t.group.id],
          }),
      expected: DIRECTOR_ONLY(201),
    },
    {
      name: 'PATCH /schedules/:id',
      send: (c, t) =>
        http().patch(`/schedules/${t.schedule}`).set(as(c)).send({ title: 'Renamed schedule' }),
      expected: DIRECTOR_ONLY(200),
    },
    {
      name: 'POST /schedules/:id/end',
      send: (c, t) =>
        http().post(`/schedules/${t.schedule}/end`).set(as(c)).send({ reason: 'Matrix end' }),
      expected: DIRECTOR_ONLY(200),
    },
    {
      name: 'GET /schedule-exceptions',
      send: (c) => http().get('/schedule-exceptions').set(as(c)),
      expected: STAFF_ONLY(200),
    },
    {
      name: 'POST /schedule-exceptions',
      send: (c) =>
        http()
          .post('/schedule-exceptions')
          .set(as(c))
          .send({ date: cairoDate(31), reason: 'Matrix holiday' }),
      expected: DIRECTOR_ONLY(201),
    },
    {
      name: 'DELETE /schedule-exceptions/:id',
      send: (c, t) => http().delete(`/schedule-exceptions/${t.exception}`).set(as(c)),
      expected: DIRECTOR_ONLY(200),
    },
    {
      name: 'GET /calendar',
      send: (c) =>
        http()
          .get(`/calendar?from=${cairoDate(0)}&to=${cairoDate(30)}`)
          .set(as(c)),
      expected: SIGNED_IN(200),
    },
    {
      name: 'POST /visits',
      send: (c, t) =>
        http()
          .post('/visits')
          .set(as(c))
          .send({
            title: 'Matrix visit',
            date: cairoDate(7),
            startTime: '10:00',
            groupIds: [t.group.id],
          }),
      expected: STAFF_ONLY(201),
    },
    {
      name: 'GET /visits/:id (student: own group)',
      send: (c, t) => http().get(`/visits/${t.visit}`).set(as(c)),
      expected: SIGNED_IN(200),
    },
    {
      name: 'GET /visits/:id/history',
      send: (c, t) => http().get(`/visits/${t.visit}/history`).set(as(c)),
      expected: STAFF_ONLY(200),
    },
    {
      name: 'PATCH /visits/:id',
      send: (c, t) =>
        http().patch(`/visits/${t.visit}`).set(as(c)).send({ title: 'Renamed visit' }),
      expected: STAFF_ONLY(200),
    },
    {
      name: 'POST /visits/:id/cancel',
      send: (c, t) =>
        http().post(`/visits/${t.visit}/cancel`).set(as(c)).send({ reason: 'Matrix cancel' }),
      expected: STAFF_ONLY(200),
    },
    {
      name: 'POST /visits/:id/restore',
      send: (c, t) => http().post(`/visits/${t.cancelledVisit}/restore`).set(as(c)).send({}),
      expected: STAFF_ONLY(200),
    },
    {
      name: 'POST /visits/:id/files',
      send: (c, t) =>
        http()
          .post(`/visits/${t.visit}/files`)
          .set(as(c))
          .field('kind', 'COVER')
          .attach('file', PNG, 'cover.png'),
      expected: STAFF_ONLY(201),
    },
    {
      name: 'DELETE /visits/:id/files/:fileId',
      send: (c, t) => http().delete(`/visits/${t.visit}/files/${t.fileId}`).set(as(c)),
      expected: STAFF_ONLY(200),
    },
    {
      name: 'GET /notifications',
      send: (c) => http().get('/notifications').set(as(c)),
      expected: SIGNED_IN(200),
    },
    {
      name: 'GET /notifications/unread-count',
      send: (c) => http().get('/notifications/unread-count').set(as(c)),
      expected: SIGNED_IN(200),
    },
    {
      name: 'POST /notifications/read-all',
      send: (c) => http().post('/notifications/read-all').set(as(c)),
      expected: SIGNED_IN(200),
    },
    /* ── Phase 4: attendance, QR codes, exports, biometrics ── */
    {
      name: 'GET /visits/:id/attendance',
      send: (c, t) => http().get(`/visits/${t.pastVisit}/attendance`).set(as(c)),
      expected: STAFF_ONLY(200),
    },
    {
      name: 'PUT /visits/:id/attendance/:studentId',
      send: (c, t) =>
        http()
          .put(`/visits/${t.pastVisit}/attendance/${t.callingStudentRecord}`)
          .set(as(c))
          .send({ status: 'PRESENT', reason: 'matrix test' }),
      expected: STAFF_ONLY(200),
    },
    {
      name: 'GET /visits/:id/qr',
      send: (c, t) => http().get(`/visits/${t.visit}/qr`).set(as(c)),
      expected: STAFF_ONLY(200),
    },
    {
      name: 'GET /attendance/overview',
      send: (c) => http().get('/attendance/overview').set(as(c)),
      expected: STAFF_ONLY(200),
    },
    {
      name: 'GET /attendance/export',
      send: (c) => http().get('/attendance/export?format=csv').set(as(c)),
      expected: STAFF_ONLY(200),
    },
    {
      name: 'GET /me/attendance',
      send: (c) => http().get('/me/attendance').set(as(c)),
      expected: STUDENT_ONLY(200),
    },
    {
      name: 'GET /attendance/check-in/:token',
      send: (c, t) => http().get(`/attendance/check-in/${t.checkInToken}`).set(as(c)),
      expected: STUDENT_ONLY(200),
    },
    {
      name: 'POST /attendance/check-in/options (window not open yet)',
      send: (c, t) =>
        http().post('/attendance/check-in/options').set(as(c)).send({ token: t.checkInToken }),
      expected: STUDENT_ONLY(409),
    },
    {
      name: 'POST /attendance/check-in (window not open yet)',
      send: (c, t) =>
        http()
          .post('/attendance/check-in')
          .set(as(c))
          .send({ token: t.checkInToken, location: { latitude: 30, longitude: 31 } }),
      expected: STUDENT_ONLY(409),
    },
    {
      name: 'POST /internal/attendance/process-absences (no cron key)',
      send: (c) => http().post('/internal/attendance/process-absences').set(as(c)),
      expected: {
        SUPER_ADMIN: 401,
        TRAINING_DIRECTOR: 401,
        FACULTY: 401,
        STUDENT: 401,
        ANONYMOUS: 401,
      },
    },
    {
      name: 'GET /auth/biometric/credentials',
      send: (c) => http().get('/auth/biometric/credentials').set(as(c)),
      expected: SIGNED_IN(200),
    },
    {
      name: 'POST /auth/biometric/credentials/options',
      send: (c) => http().post('/auth/biometric/credentials/options').set(as(c)),
      expected: SIGNED_IN(200),
    },
    {
      name: 'POST /auth/biometric/credentials (malformed)',
      send: (c) => http().post('/auth/biometric/credentials').set(as(c)).send({}),
      expected: SIGNED_IN(400),
    },
    {
      name: 'DELETE /auth/biometric/credentials/:id (not own)',
      send: (c) =>
        http()
          .delete('/auth/biometric/credentials/01900000-0000-7000-8000-000000000000')
          .set(as(c))
          .send({}),
      expected: SIGNED_IN(404),
    },
    {
      name: 'POST /auth/biometric/login/options (public)',
      send: (c) => http().post('/auth/biometric/login/options').set(as(c)),
      expected: {
        SUPER_ADMIN: 200,
        TRAINING_DIRECTOR: 200,
        FACULTY: 200,
        STUDENT: 200,
        ANONYMOUS: 200,
      },
    },
    /* ── Phase 5: tickets and group swaps ── */
    {
      name: 'POST /tickets',
      send: (c) =>
        http()
          .post('/tickets')
          .set(as(c))
          .field('category', 'SUGGESTION')
          .field('subject', 'Matrix subject')
          .field('description', 'Matrix description'),
      expected: STUDENT_ONLY(201),
    },
    {
      name: 'GET /me/tickets',
      send: (c) => http().get('/me/tickets').set(as(c)),
      expected: STUDENT_ONLY(200),
    },
    {
      name: 'GET /tickets',
      send: (c) => http().get('/tickets').set(as(c)),
      expected: STAFF_ONLY(200),
    },
    {
      name: 'GET /tickets/:id (student: own)',
      send: (c, t) => http().get(`/tickets/${t.ticket}`).set(as(c)),
      expected: SIGNED_IN(200),
    },
    {
      name: 'POST /tickets/:id/messages (student: own)',
      send: (c, t) =>
        http().post(`/tickets/${t.ticket}/messages`).set(as(c)).field('body', 'Matrix'),
      expected: SIGNED_IN(201),
    },
    {
      name: 'POST /tickets/:id/status',
      send: (c, t) =>
        http().post(`/tickets/${t.ticket}/status`).set(as(c)).send({ status: 'IN_PROGRESS' }),
      expected: STAFF_ONLY(200),
    },
    {
      name: 'POST /group-swaps (counterpart without an account)',
      send: (c, t) =>
        http()
          .post('/group-swaps')
          .set(as(c))
          .send({ targetGroupId: t.otherGroup, counterpartSeatNumber: t.otherStudentSeat }),
      expected: STUDENT_ONLY(400),
    },
    {
      name: 'GET /me/group-swaps',
      send: (c) => http().get('/me/group-swaps').set(as(c)),
      expected: STUDENT_ONLY(200),
    },
    {
      name: 'GET /me/group-swaps/groups',
      send: (c) => http().get('/me/group-swaps/groups').set(as(c)),
      expected: STUDENT_ONLY(200),
    },
    {
      name: 'GET /group-swaps',
      send: (c) => http().get('/group-swaps').set(as(c)),
      expected: STAFF_ONLY(200),
    },
    {
      name: 'GET /group-swaps/history',
      send: (c) => http().get('/group-swaps/history').set(as(c)),
      expected: DIRECTOR_ONLY(200),
    },
    {
      name: 'GET /group-swaps/:id (student: counterpart)',
      send: (c, t) => http().get(`/group-swaps/${t.swapForStudent}`).set(as(c)),
      expected: SIGNED_IN(200),
    },
    {
      name: 'POST /group-swaps/:id/accept',
      send: (c, t) => http().post(`/group-swaps/${t.swapForStudent}/accept`).set(as(c)),
      expected: STUDENT_ONLY(200),
    },
    {
      name: 'POST /group-swaps/:id/decline',
      send: (c, t) => http().post(`/group-swaps/${t.swapForStudent}/decline`).set(as(c)).send({}),
      expected: STUDENT_ONLY(200),
    },
    {
      name: 'POST /group-swaps/:id/withdraw (not the requester)',
      send: (c, t) => http().post(`/group-swaps/${t.swapForStudent}/withdraw`).set(as(c)).send({}),
      expected: {
        SUPER_ADMIN: 403,
        TRAINING_DIRECTOR: 403,
        FACULTY: 403,
        STUDENT: 403,
        ANONYMOUS: 401,
      },
    },
    {
      name: 'POST /group-swaps/:id/approve',
      send: (c, t) => http().post(`/group-swaps/${t.swapForFaculty}/approve`).set(as(c)),
      expected: STAFF_ONLY(200),
    },
    {
      name: 'POST /group-swaps/:id/reject',
      send: (c, t) =>
        http()
          .post(`/group-swaps/${t.swapForFaculty}/reject`)
          .set(as(c))
          .send({ reason: 'Matrix rejection' }),
      expected: STAFF_ONLY(200),
    },
    /* ── Phase 6: audit log and training-wide reports ── */
    {
      name: 'GET /audit-logs',
      send: (c) => http().get('/audit-logs').set(as(c)),
      expected: DIRECTOR_ONLY(200),
    },
    {
      name: 'GET /audit-logs/facets',
      send: (c) => http().get('/audit-logs/facets').set(as(c)),
      expected: DIRECTOR_ONLY(200),
    },
    {
      name: 'GET /audit-logs/activity',
      send: (c) => http().get('/audit-logs/activity').set(as(c)),
      expected: DIRECTOR_ONLY(200),
    },
    {
      name: 'GET /audit-logs/:id',
      send: (c, t) => http().get(`/audit-logs/${t.auditEvent}`).set(as(c)),
      expected: DIRECTOR_ONLY(200),
    },
    {
      name: 'GET /audit-logs/export',
      send: (c) => http().get('/audit-logs/export?format=csv').set(as(c)),
      expected: DIRECTOR_ONLY(200),
    },
    {
      name: 'DELETE /audit-logs/:id (no such route)',
      send: (c, t) => http().delete(`/audit-logs/${t.auditEvent}`).set(as(c)),
      expected: {
        SUPER_ADMIN: 404,
        TRAINING_DIRECTOR: 404,
        FACULTY: 404,
        STUDENT: 404,
        ANONYMOUS: 404,
      },
    },
    {
      name: 'GET /reports/attendance-summary',
      send: (c) => http().get('/reports/attendance-summary').set(as(c)),
      expected: STAFF_ONLY(200),
    },
    {
      name: 'GET /reports/attendance-summary/export',
      send: (c) => http().get('/reports/attendance-summary/export?format=csv').set(as(c)),
      expected: STAFF_ONLY(200),
    },
    {
      name: 'GET /reports/faculty-activity/export',
      send: (c) => http().get('/reports/faculty-activity/export?format=csv').set(as(c)),
      expected: DIRECTOR_ONLY(200),
    },
    {
      name: 'GET /local-files/:token (public; forged token)',
      send: (c) => http().get('/local-files/e30.0000').set(as(c)),
      expected: {
        SUPER_ADMIN: 404,
        TRAINING_DIRECTOR: 404,
        FACULTY: 404,
        STUDENT: 404,
        ANONYMOUS: 404,
      },
    },
  ];

  it.each(cases.flatMap((c) => CALLERS.map((caller) => [c.name, caller, c] as const)))(
    '%s as %s',
    async (_name, caller, testCase) => {
      const student = await createUser(app, 'STUDENT');
      const record = await createStudentRecord(app);
      const busyGroup = await createGroup(app);
      await addToGroup(app, record.id, busyGroup.id);
      const group = await createGroup(app);

      // Phase 3 fixtures: the calling student's group has the visits.
      const program = await createProgram(app);
      const studentGroup = await createGroup(app);
      await addToGroup(app, await recordOf(app, users.STUDENT.id), studentGroup.id);
      const visit = await createVisit(app, program.id, [studentGroup.id]);
      const cancelledVisit = await createVisit(app, program.id, [studentGroup.id], {
        status: 'CANCELLED',
      });
      const file = await prisma.visitFile.create({
        data: {
          visitId: visit.id,
          kind: 'DOCUMENT',
          bucket: 'visit-documents',
          storagePath: `visits/${visit.id}/matrix.pdf`,
          fileName: 'matrix.pdf',
          contentType: 'application/pdf',
          sizeBytes: 100,
        },
      });
      const schedule = await prisma.trainingSchedule.create({
        data: {
          programId: program.id,
          title: 'Matrix weekly',
          weekdays: [2],
          startTime: new Date('1970-01-01T09:00:00Z'),
          startsOn: new Date(`${cairoDate(1)}T00:00:00Z`),
          endsOn: new Date(`${cairoDate(28)}T00:00:00Z`),
          groups: { create: [{ groupId: group.id }] },
        },
      });
      const exception = await prisma.scheduleException.create({
        data: {
          programId: program.id,
          date: new Date(`${cairoDate(29)}T00:00:00Z`),
          reason: 'Matrix day off',
        },
      });

      const pastVisit = await createVisit(app, program.id, [studentGroup.id], {
        date: cairoDate(-1),
      });

      // Phase 5 fixtures.
      const callingStudentRecord = await recordOf(app, users.STUDENT.id);
      const ticket = await prisma.supportTicket.create({
        data: {
          studentId: callingStudentRecord,
          createdById: users.STUDENT.id,
          category: 'COMPLAINT',
          subject: 'Matrix ticket',
          description: 'Matrix description',
        },
      });
      const swapBetween = async (
        requesterId: string,
        requesterGroupId: string,
        counterpartId: string,
        counterpartGroupId: string,
        waitingForFaculty: boolean,
      ) =>
        prisma.$transaction(async (tx) => {
          const t = await tx.supportTicket.create({
            data: {
              studentId: requesterId,
              createdById: student.id,
              category: 'GROUP_SWAP',
              subject: 'Matrix swap',
              description: 'Matrix swap',
            },
          });
          const r = await tx.groupSwapRequest.create({
            data: {
              ticketId: t.id,
              requesterId,
              requesterGroupId,
              counterpartId,
              counterpartGroupId,
            },
          });
          if (waitingForFaculty) {
            await tx.groupSwapRequest.update({
              where: { id: r.id },
              data: { status: 'PENDING_FACULTY', counterpartDecidedAt: new Date() },
            });
          }
          return r.id;
        });
      const otherGroup = await createGroup(app);
      const asker = await createStudentRecord(app);
      await addToGroup(app, asker.id, otherGroup.id);
      const swapForStudent = await swapBetween(
        asker.id,
        otherGroup.id,
        callingStudentRecord,
        studentGroup.id,
        false,
      );
      const [g1, g2] = [await createGroup(app), await createGroup(app)];
      const [y, z] = [await createStudentRecord(app), await createStudentRecord(app)];
      await addToGroup(app, y.id, g1.id);
      await addToGroup(app, z.id, g2.id);
      const swapForFaculty = await swapBetween(y.id, g1.id, z.id, g2.id, true);

      const target: Target = {
        faculty: await createUser(app, 'FACULTY'),
        student,
        studentRecord: await recordOf(app, student.id),
        record,
        group,
        busyGroup,
        visit: visit.id,
        cancelledVisit: cancelledVisit.id,
        fileId: file.id,
        schedule: schedule.id,
        exception: exception.id,
        pastVisit: pastVisit.id,
        checkInToken: app.get(AttendanceTokens).sign(visit.id),
        callingStudentRecord,
        ticket: ticket.id,
        swapForStudent,
        swapForFaculty,
        otherGroup: otherGroup.id,
        otherStudentSeat: asker.seatNumber,
        auditEvent: (
          await prisma.auditLog.create({
            data: {
              action: 'visit.updated',
              resourceType: 'visit',
              resourceId: visit.id,
              outcome: 'SUCCESS',
              before: { title: 'Before' },
              after: { title: 'After' },
            },
          })
        ).id.toString(),
      };
      const res = await testCase.send(caller, target);
      expect({ status: res.status, code: res.body?.code }).toMatchObject({
        status: testCase.expected[caller],
      });
      if (res.status === 403) expect(res.body.code).toBe('FORBIDDEN');
      if (res.status === 401) expect(res.body.code).toBe('AUTH_REQUIRED');
    },
  );

  /* ───────────────────────────── account rules ───────────────────────────── */

  it('creates an account without a password, audits it, and emails an invitation', async () => {
    const res = await http()
      .post('/admin/users')
      .set(bearer(tokens.TRAINING_DIRECTOR))
      .send({
        role: 'FACULTY',
        email: ' Dr.Mona@AGR.asu.edu.eg ',
        fullName: 'د. منى أحمد',
        academicTitle: 'أستاذ مساعد',
      })
      .expect(201);
    const created = UserDetailSchema.parse(res.body);
    expect(created).toMatchObject({
      email: 'dr.mona@agr.asu.edu.eg',
      role: 'FACULTY',
      hasPassword: false,
    });

    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { action: 'user.created', resourceId: created.id },
    });
    expect(audit.actorId).toBe(users.TRAINING_DIRECTOR.id);
    expect(audit.actorRole).toBe('TRAINING_DIRECTOR');
    await mailboxDrain();
    expect(mailbox.messages.find((m) => m.to === created.email)?.subject).toContain(
      'Your account has been created',
    );
  });

  it('rejects duplicate emails (any capitalization) and seat numbers', async () => {
    const dupEmail = await http()
      .post('/admin/users')
      .set(bearer(tokens.SUPER_ADMIN))
      .send({
        role: 'FACULTY',
        email: users.FACULTY.email.toUpperCase(),
        fullName: 'Duplicate Person',
      })
      .expect(409);
    expect(dupEmail.body.code).toBe('EMAIL_ALREADY_EXISTS');

    const dupSeat = await http()
      .post('/admin/users')
      .set(bearer(tokens.SUPER_ADMIN))
      .send({
        role: 'STUDENT',
        email: 'another@agr.asu.edu.eg',
        fullName: 'Duplicate Seat',
        seatNumber: users.STUDENT.seatNumber,
      })
      .expect(409);
    expect(dupSeat.body.code).toBe('SEAT_NUMBER_ALREADY_EXISTS');
  });

  it('suspending an account revokes its sessions and is audited with before/after', async () => {
    await http()
      .patch(`/admin/users/${users.FACULTY.id}/status`)
      .set(bearer(tokens.SUPER_ADMIN))
      .send({ status: 'SUSPENDED', reason: 'left the faculty' })
      .expect(200);
    await http().get('/auth/me').set(bearer(tokens.FACULTY)).expect(401);
    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { action: 'user.status_changed' },
    });
    expect(audit).toMatchObject({
      reason: 'left the faculty',
      before: { status: 'ACTIVE' },
      after: { status: 'SUSPENDED' },
      actorId: users.SUPER_ADMIN.id,
    });
  });

  it('refuses actions on your own account', async () => {
    const res = await http()
      .patch(`/admin/users/${users.SUPER_ADMIN.id}/status`)
      .set(bearer(tokens.SUPER_ADMIN))
      .send({ status: 'SUSPENDED', reason: 'oops' })
      .expect(409);
    expect(res.body.code).toBe('SELF_ACTION_FORBIDDEN');
    await http()
      .patch(`/admin/users/${users.SUPER_ADMIN.id}/role`)
      .set(bearer(tokens.SUPER_ADMIN))
      .send({ role: 'FACULTY', reason: 'oops' })
      .expect(409);
  });

  it('never turns a student into staff (or back)', async () => {
    const res = await http()
      .patch(`/admin/users/${users.STUDENT.id}/role`)
      .set(bearer(tokens.SUPER_ADMIN))
      .send({ role: 'FACULTY', reason: 'not allowed' })
      .expect(409);
    expect(res.body.code).toBe('ROLE_CHANGE_NOT_ALLOWED');
    await http()
      .patch(`/admin/users/${users.FACULTY.id}/role`)
      .set(bearer(tokens.SUPER_ADMIN))
      .send({ role: 'STUDENT', reason: 'not allowed' })
      .expect(400);
  });

  it('per-user grants change what the API allows, on the next request', async () => {
    await http().get('/admin/users').set(bearer(tokens.FACULTY)).expect(403);
    await http()
      .put(`/admin/users/${users.FACULTY.id}/permissions`)
      .set(bearer(tokens.SUPER_ADMIN))
      .send({
        grants: [
          { permission: 'users.read', effect: 'ALLOW' },
          { permission: 'students.import', effect: 'DENY' },
        ],
        reason: 'acting coordinator',
      })
      .expect(200);
    await http().get('/admin/users').set(bearer(tokens.FACULTY)).expect(200);
    const me = (await http().get('/auth/me').set(bearer(tokens.FACULTY))).body;
    expect(me.permissions).toContain('users.read');
    expect(me.permissions).not.toContain('students.import');

    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { action: 'user.permissions_changed' },
    });
    expect(audit.before).toEqual({ grants: [] });
    expect(audit.after).toEqual({
      grants: expect.arrayContaining([
        { permission: 'users.read', effect: 'ALLOW' },
        { permission: 'students.import', effect: 'DENY' },
      ]),
    });
  });

  it('refuses Super-Admin-only permissions and grants to students', async () => {
    const superOnly = await http()
      .put(`/admin/users/${users.TRAINING_DIRECTOR.id}/permissions`)
      .set(bearer(tokens.SUPER_ADMIN))
      .send({
        grants: [{ permission: 'users.manage', effect: 'ALLOW' }],
        reason: 'escalation attempt',
      })
      .expect(400);
    expect(superOnly.body).toMatchObject({
      code: 'PERMISSION_NOT_GRANTABLE',
      details: { grants: ['users.manage'] },
    });

    const toStudent = await http()
      .put(`/admin/users/${users.STUDENT.id}/permissions`)
      .set(bearer(tokens.SUPER_ADMIN))
      .send({ grants: [{ permission: 'attendance.read', effect: 'ALLOW' }], reason: 'not allowed' })
      .expect(400);
    expect(toStudent.body.code).toBe('PERMISSION_NOT_GRANTABLE');
  });

  it('promoting to Super Admin drops per-user grants (audited)', async () => {
    await http()
      .put(`/admin/users/${users.FACULTY.id}/permissions`)
      .set(bearer(tokens.SUPER_ADMIN))
      .send({ grants: [{ permission: 'audit.read', effect: 'ALLOW' }], reason: 'temporary' })
      .expect(200);
    const res = await http()
      .patch(`/admin/users/${users.FACULTY.id}/role`)
      .set(bearer(tokens.SUPER_ADMIN))
      .send({ role: 'SUPER_ADMIN', reason: 'new system administrator' })
      .expect(200);
    expect(res.body.grants).toEqual([]);
    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { action: 'user.role_changed' },
    });
    expect(audit.before).toMatchObject({
      role: 'FACULTY',
      grants: [{ permission: 'audit.read', effect: 'ALLOW' }],
    });
    expect(audit.after).toMatchObject({ role: 'SUPER_ADMIN', grants: [] });
  });

  it('lists and searches accounts by seat number, name or email with pagination', async () => {
    const page = (
      await http().get('/admin/users?pageSize=2&page=1').set(bearer(tokens.SUPER_ADMIN)).expect(200)
    ).body;
    expect(page).toMatchObject({ total: 4, page: 1, pageSize: 2 });
    expect(page.items).toHaveLength(2);

    const bySeat = ListUsersResponseSchema.parse(
      (
        await http()
          .get(`/admin/users?q=${users.STUDENT.seatNumber!.toLowerCase()}`)
          .set(bearer(tokens.SUPER_ADMIN))
          .expect(200)
      ).body,
    );
    expect(bySeat.items.map((u) => u.id)).toEqual([users.STUDENT.id]);

    const byRole = (
      await http().get('/admin/users?role=FACULTY').set(bearer(tokens.SUPER_ADMIN)).expect(200)
    ).body;
    expect(byRole.total).toBe(1);
    await http().get('/admin/users?pageSize=1000').set(bearer(tokens.SUPER_ADMIN)).expect(400);
  });

  it('a student cannot read anyone else, even by guessing an id', async () => {
    const other = await createUser(app, 'STUDENT');
    await http().get(`/admin/users/${other.id}`).set(bearer(tokens.STUDENT)).expect(403);
  });

  function mailboxDrain(): Promise<void> {
    return app.get(BackgroundTasks).drain();
  }
});
