import { AttendanceSummaryResponseSchema, ListAuditLogsResponseSchema } from '@ftms/core';
import { Workbook } from 'exceljs';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import { REPORT_LABELS } from '../src/reports/report-labels';
import { standingOf } from '../src/reports/reports.service';
import { pdfLines } from './helpers/pdf';
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
  resetDatabase,
  type TestApp,
} from './helpers/test-app';

/**
 * Training-wide reports (§3.2, §15, §19): every student's standing against
 * the absence allowance, computed from the same records and rules as the
 * dashboards, exported in three formats, each export recorded, and each
 * report limited by its own permissions.
 */
describe('Training-wide reports', () => {
  let app: TestApp;
  let prisma: PrismaService;
  const http = () => request(app.getHttpServer());
  let directorToken: string;
  let facultyToken: string;
  let studentToken: string;
  let A: { id: string; name: string };
  let B: { id: string; name: string };
  const students: Record<string, string> = {};

  const binary = (path: string, token = directorToken) =>
    http()
      .get(path)
      .set(bearer(token))
      .buffer(true)
      .parse((r, done) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => done(null, Buffer.concat(chunks)));
      });

  const summary = async (query = '', token = directorToken) =>
    AttendanceSummaryResponseSchema.parse(
      (await http().get(`/reports/attendance-summary?${query}`).set(bearer(token)).expect(200))
        .body,
    );

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
    const faculty = await createUser(app, 'FACULTY');
    const student = await createUser(app, 'STUDENT');
    directorToken = (await login(app, director.email, director.password!)).accessToken;
    facultyToken = (await login(app, faculty.email, faculty.password!)).accessToken;
    studentToken = (await login(app, student.email, student.password!)).accessToken;
    A = await createGroup(app, 'Group A');
    B = await createGroup(app, 'Group B');
    for (const [key, seat, name, group] of [
      ['ok', '2001', 'أحمد سامي علي', A.id],
      ['limit', '2002', 'منى خالد حسن', A.id],
      ['over', '2003', 'Omar Hany Adel', B.id],
      ['none', '2004', 'سلمى يوسف كمال', null],
    ] as const) {
      const record = await createStudentRecord(app, { seatNumber: seat, fullName: name });
      students[key] = record.id;
      if (group) await addToGroup(app, record.id, group);
    }
  });

  /** Three past visits; records written directly (a check-in, lateness, absences). */
  async function seedRecords() {
    const program = await createProgram(app, { allowedAbsences: 2 });
    const visits = await Promise.all(
      [-3, -2, -1].map((d, i) =>
        createVisit(app, program.id, [A.id, B.id], { date: cairoDate(d), title: `V${i + 1}` }),
      ),
    );
    const cancelled = await createVisit(app, program.id, [A.id, B.id], { date: cairoDate(-4) });
    const rec = (
      visit: string,
      key: string,
      group: string,
      status: 'PRESENT' | 'LATE' | 'ABSENT',
      minutesLate = 0,
    ) =>
      prisma.attendanceRecord.create({
        data: {
          visitId: visit,
          studentId: students[key]!,
          groupId: group,
          status,
          minutesLate,
          source: status === 'ABSENT' ? 'AUTOMATIC' : 'QR',
          checkedInAt: status === 'ABSENT' ? null : new Date(),
        },
      });
    const [v1, v2, v3] = visits.map((v) => v.id) as [string, string, string];
    await rec(v1, 'ok', A.id, 'PRESENT');
    await rec(v2, 'ok', A.id, 'LATE', 12);
    await rec(v3, 'ok', A.id, 'LATE', 3);
    await rec(v1, 'limit', A.id, 'ABSENT');
    await rec(v2, 'limit', A.id, 'ABSENT');
    await rec(v3, 'limit', A.id, 'PRESENT');
    await rec(v1, 'over', B.id, 'ABSENT');
    await rec(v2, 'over', B.id, 'ABSENT');
    await rec(v3, 'over', B.id, 'ABSENT');
    // Records of a visit cancelled afterwards never count.
    await rec(cancelled.id, 'ok', A.id, 'ABSENT');
    await prisma.trainingVisit.update({
      where: { id: cancelled.id },
      data: { status: 'CANCELLED', cancelReason: 'Weather', cancelledAt: new Date() },
    });
  }

  it('computes each student’s standing from the finalized records, like the dashboards', async () => {
    await seedRecords();
    const report = await summary();
    expect(report.allowedAbsences).toBe(2);
    const row = (key: string) => report.rows.find((r) => r.studentId === students[key])!;
    expect(row('ok')).toMatchObject({
      group: { id: A.id, name: 'Group A' },
      recorded: 3,
      present: 1,
      late: 2,
      absent: 0,
      lateMinutes: 15,
      remainingAbsences: 2,
      standing: 'within',
    });
    expect(row('limit')).toMatchObject({ absent: 2, remainingAbsences: 0, standing: 'atLimit' });
    expect(row('over')).toMatchObject({ absent: 3, remainingAbsences: 0, standing: 'over' });
    expect(row('none')).toMatchObject({ group: null, recorded: 0, standing: 'within' });
    // (The signed-in student of the fixture is a fifth record, without a group.)
    expect(report.totals).toEqual({
      students: 5,
      present: 2,
      late: 2,
      absent: 5,
      over: 1,
      atLimit: 1,
    });
    // Ordered by group, then name; students without a group last.
    expect(report.rows.map((r) => r.group?.name ?? null)).toEqual([
      'Group A',
      'Group A',
      'Group B',
      null,
      null,
    ]);
    // The same figures the student sees on their own dashboard.
    const own = await createUser(app, 'STUDENT', { status: 'PENDING_VERIFICATION' });
    await prisma.studentProfile.update({ where: { id: students.over! }, data: { userId: own.id } });
    await prisma.user.update({ where: { id: own.id }, data: { status: 'ACTIVE' } });
    const ownToken = (await login(app, own.email, own.password!)).accessToken;
    const mine = (await http().get('/me/attendance').set(bearer(ownToken)).expect(200)).body;
    expect(mine.summary).toMatchObject({
      absent: row('over').absent,
      remainingAbsences: row('over').remainingAbsences,
    });
  });

  it('filters by group, no group, name or seat, and standing', async () => {
    await seedRecords();
    expect((await summary(`group=${B.id}`)).rows.map((r) => r.studentId)).toEqual([students.over]);
    const ungrouped = (await summary('group=none')).rows.map((r) => r.studentId);
    expect(ungrouped).toHaveLength(2);
    expect(ungrouped).toContain(students.none);
    expect((await summary('q=2002')).rows.map((r) => r.studentId)).toEqual([students.limit]);
    // Arabic spelling variants match (ى/ي, ة/ه, hamza forms).
    expect((await summary(`q=${encodeURIComponent('سلمي')}`)).rows.map((r) => r.studentId)).toEqual(
      [students.none],
    );
    expect((await summary('standing=over')).rows.map((r) => r.studentId)).toEqual([students.over]);
    expect((await summary('standing=atLimit')).rows.map((r) => r.studentId)).toEqual([
      students.limit,
    ]);
    const bad = await http()
      .get('/reports/attendance-summary?standing=great')
      .set(bearer(directorToken));
    expect(bad.status).toBe(400);
  });

  it('reports without a training program, never hardcoding an allowance', async () => {
    const report = await summary();
    expect(report.allowedAbsences).toBeNull();
    expect(report.rows).toHaveLength(5);
    expect(report.rows.every((r) => r.recorded === 0 && r.standing === 'within')).toBe(true);
    expect(standingOf(0, 0)).toBe('within');
    expect(standingOf(1, 0)).toBe('over');
    expect(standingOf(3, 3)).toBe('atLimit');
    expect(standingOf(5, null)).toBe('within');
  });

  it('exports CSV, XLSX and PDF with the same figures, and records each export', async () => {
    await seedRecords();
    const L = REPORT_LABELS.en.summary;
    const csv = await binary('/reports/attendance-summary/export?format=csv&locale=en').expect(200);
    expect(csv.headers['content-disposition']).toMatch(/ftms-attendance-summary-\d{12}\.csv/);
    const text = (csv.body as Buffer).toString('utf8');
    expect(text.charCodeAt(0)).toBe(0xfeff);
    const lines = text.slice(1).trim().split('\r\n');
    expect(lines[0]).toBe(Object.values(L.columns).join(','));
    expect(lines).toContain('أحمد سامي علي,2001,Group A,3,1,2,0,15,2,Within the limit');
    expect(lines).toContain('Omar Hany Adel,2003,Group B,3,0,0,3,0,0,Over the limit');
    expect(lines).toContain('سلمى يوسف كمال,2004,No group,0,0,0,0,0,2,Within the limit');

    const xlsx = await binary('/reports/attendance-summary/export?format=xlsx&locale=ar').expect(
      200,
    );
    const workbook = new Workbook();
    await workbook.xlsx.load(xlsx.body as Parameters<typeof workbook.xlsx.load>[0]);
    const sheet = workbook.worksheets[0]!;
    expect(sheet.views[0]?.rightToLeft).toBe(true);
    expect(sheet.getRow(1).getCell(1).value).toBe(REPORT_LABELS.ar.summary.columns.student);
    expect(sheet.rowCount).toBe(6);
    const over = sheet.getRow(4).values as unknown[];
    expect(over.slice(1)).toEqual([
      'Omar Hany Adel',
      '2003',
      'Group B',
      3,
      0,
      0,
      3,
      0,
      0,
      REPORT_LABELS.ar.summary.standings.over,
    ]);

    const pdf = await binary(`/reports/attendance-summary/export?format=pdf&group=${A.id}`).expect(
      200,
    );
    const raw = (pdf.body as Buffer).toString('latin1');
    expect(pdf.headers['content-type']).toBe('application/pdf');
    expect(raw.startsWith('%PDF-')).toBe(true);
    expect(raw).toContain('IBMPlexSansArabic');
    // The PDF shows the group's rows with the CSV's figures (seat, then counts).
    const groupA = lines.slice(1).filter((l) => l.split(',')[2] === 'Group A');
    expect(groupA).toHaveLength(2);
    const page = pdfLines(pdf.body as Buffer, true)[0]!;
    for (const row of groupA) {
      const [, seat, , ...rest] = row.split(',');
      const line = page.find((l) => l.includes(seat!));
      expect(line?.filter((c) => /^\d+$/.test(c))).toEqual([seat, ...rest.slice(0, 6)]);
    }
    expect(page.filter((l) => l.some((c) => /^20\d\d$/.test(c)))).toHaveLength(2);

    const exports = ListAuditLogsResponseSchema.parse(
      (
        await http()
          .get('/audit-logs?action=report.exported')
          .set(bearer(directorToken))
          .expect(200)
      ).body,
    ).items;
    expect(exports.map((e) => e.metadata?.format)).toEqual(['pdf', 'xlsx', 'csv']);
    expect(exports[0]).toMatchObject({
      resourceType: 'report',
      resourceId: 'attendance_summary',
      metadata: { rows: 2, filters: { group: A.id } },
    });
  });

  it('exports the faculty activity report for the period', async () => {
    // Activity: the faculty member creates a group; the director exports the report.
    await http().post('/groups').set(bearer(facultyToken)).send({ name: 'Group C' }).expect(201);
    const csv = await binary(
      `/reports/faculty-activity/export?format=csv&locale=en&from=${cairoDate(-6)}&to=${cairoDate(0)}`,
    ).expect(200);
    const lines = (csv.body as Buffer).toString('utf8').slice(1).trim().split('\r\n');
    const L = REPORT_LABELS.en;
    expect(lines[0]!.startsWith(`${L.activity.columns.staff},${L.activity.columns.role}`)).toBe(
      true,
    );
    expect(lines[0]).toContain(L.categories.GROUPS);
    const faculty = lines.find((l) => l.includes('Faculty member'))!;
    // name, role, status, total, decisions, failures, then one column per category.
    expect(faculty.split(',').slice(1, 6)).toEqual(['Faculty member', 'Active', '2', '0', '0']);
    for (const format of ['xlsx', 'pdf']) {
      await binary(`/reports/faculty-activity/export?format=${format}`).expect(200);
    }
    const recorded = ListAuditLogsResponseSchema.parse(
      (
        await http()
          .get('/audit-logs?action=report.exported&resourceId=faculty_activity')
          .set(bearer(directorToken))
          .expect(200)
      ).body,
    );
    expect(recorded.total).toBe(3);
  });

  it('limits each report to its own permissions', async () => {
    for (const path of [
      '/reports/attendance-summary',
      '/reports/attendance-summary/export?format=csv',
      '/reports/faculty-activity/export?format=csv',
    ]) {
      const res = await http().get(path).set(bearer(studentToken));
      expect([path, res.status]).toEqual([path, 403]);
      expect((await http().get(path)).status).toBe(401);
    }
    // Faculty: attendance reports yes, the activity report (audit.read) no.
    await http().get('/reports/attendance-summary').set(bearer(facultyToken)).expect(200);
    await binary('/reports/attendance-summary/export?format=csv', facultyToken).expect(200);
    const denied = await http()
      .get('/reports/faculty-activity/export?format=csv')
      .set(bearer(facultyToken));
    expect(denied.status).toBe(403);
  });
});
