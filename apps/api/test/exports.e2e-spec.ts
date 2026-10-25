import {
  type LocalDate,
  PROGRAM_TIME_ZONE,
  VisitAttendanceResponseSchema,
  zonedToUtc,
} from '@ftms/core';
import { type CellValue, Workbook } from 'exceljs';
import request from 'supertest';
import { EXPORT_LABELS } from '../src/attendance/export-labels';
import { PrismaService } from '../src/prisma/prisma.service';
import { pdfLines } from './helpers/pdf';
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

const at = (date: LocalDate, time: string): Date => zonedToUtc(date, time, PROGRAM_TIME_ZONE);

/** RFC 4180 CSV, as a spreadsheet program reads it. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\r' && text[i + 1] === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      i += 1;
    } else field += ch;
  }
  if (field !== '' || row.length > 0) rows.push([...row, field]);
  return rows;
}

describe('Attendance exports: PDF, XLSX and CSV match the records (§10.4, §19, §20.6)', () => {
  const clock = new TestClock();
  let app: TestApp;
  let prisma: PrismaService;
  const http = () => request(app.getHttpServer());

  let faculty: SeededUser;
  let facultyToken: string;
  let groupA: { id: string; name: string };
  let groupB: { id: string; name: string };
  let ids: Record<'s1' | 's2' | 's3' | 's4' | 's5', string>;
  let v1: string;
  let v2: string;

  beforeAll(async () => {
    ({ app } = await bootTestApp({ clock }));
    prisma = app.get(PrismaService);
  });
  afterAll(async () => {
    await app.close();
  });

  /**
   * Two visits with Arabic and English names, both groups, every status and
   * source, a correction note with quotes and a comma, a missing check-in time,
   * a name that looks like a spreadsheet formula — and a cancelled visit that
   * must not appear.
   */
  beforeEach(async () => {
    clock.reset();
    await resetDatabase(app);
    faculty = await createUser(app, 'FACULTY');
    facultyToken = (await login(app, faculty.email, faculty.password!)).accessToken;
    const { id: programId } = await createProgram(app);
    groupA = await createGroup(app, 'المجموعة أ');
    groupB = await createGroup(app, 'المجموعة ب');

    const student = async (fullName: string, seatNumber: string, groupId: string) => {
      const user = await createUser(app, 'STUDENT', { seatNumber });
      const id = await recordOf(app, user.id);
      await prisma.studentProfile.update({ where: { id }, data: { fullName } });
      await addToGroup(app, id, groupId);
      return id;
    };
    ids = {
      s1: await student('محمد أحمد علي حسن', '2026-101', groupA.id),
      s2: await student('فاطمة محمود السيد', '2026-102', groupB.id),
      s3: await student('Omar Khaled', '2026-103', groupB.id),
      s4: await student('=HYPERLINK("http://evil.example")', '2026-104', groupA.id),
      s5: await student('سارة إبراهيم', '2026-105', groupA.id),
    };

    v1 = (
      await createVisit(app, programId, [groupA.id, groupB.id], {
        date: '2026-12-01',
        title: 'زيارة مزرعة الخضر',
      })
    ).id;
    await prisma.trainingVisit.update({
      where: { id: v1 },
      data: { endTime: new Date('1970-01-01T12:00:00Z') },
    });
    v2 = (
      await createVisit(app, programId, [groupB.id], {
        date: '2026-12-03',
        startTime: '09:00',
        title: 'Dairy farm, unit 2',
      })
    ).id;
    const v3 = (
      await createVisit(app, programId, [groupA.id, groupB.id], {
        date: '2026-12-05',
        title: 'Cancelled visit',
      })
    ).id;

    const qr = { source: 'QR' as const };
    await prisma.attendanceRecord.createMany({
      data: [
        {
          visitId: v1,
          studentId: ids.s1,
          groupId: groupA.id,
          status: 'PRESENT',
          checkedInAt: at('2026-12-01', '09:58'),
          biometricVerified: true,
          ...qr,
        },
        {
          visitId: v1,
          studentId: ids.s2,
          groupId: groupB.id,
          status: 'LATE',
          minutesLate: 7,
          checkedInAt: at('2026-12-01', '10:22'),
          ...qr,
        },
        {
          visitId: v1,
          studentId: ids.s3,
          groupId: groupB.id,
          status: 'ABSENT',
          source: 'AUTOMATIC',
        },
        {
          visitId: v1,
          studentId: ids.s4,
          groupId: groupA.id,
          status: 'PRESENT',
          source: 'MANUAL',
          correctedById: faculty.id,
          correctedAt: at('2026-12-01', '13:00'),
          correctionReason: 'Arrived with the supervisor, "confirmed"',
        },
        // s5 has no record: the export finalizes the absence first.
        {
          visitId: v2,
          studentId: ids.s2,
          groupId: groupB.id,
          status: 'PRESENT',
          checkedInAt: at('2026-12-03', '08:50'),
          ...qr,
        },
        {
          visitId: v2,
          studentId: ids.s3,
          groupId: groupB.id,
          status: 'LATE',
          minutesLate: 3,
          checkedInAt: at('2026-12-03', '09:18'),
          ...qr,
        },
        {
          visitId: v3,
          studentId: ids.s1,
          groupId: groupA.id,
          status: 'PRESENT',
          checkedInAt: at('2026-12-05', '09:55'),
          ...qr,
        },
      ],
    });
    await prisma.trainingVisit.update({
      where: { id: v3 },
      data: { status: 'CANCELLED', cancelReason: 'Weather', cancelledAt: new Date() },
    });
    clock.set(at('2026-12-10', '12:00'));
  });

  const download = (query: string, token = facultyToken) =>
    http()
      .get(`/attendance/export?${query}`)
      .set(bearer(token))
      .buffer(true)
      .parse((r, done) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => done(null, Buffer.concat(chunks)));
      });

  /** The rows every format must contain, in the reader's language. */
  function expectedRows(locale: 'ar' | 'en'): string[][] {
    const L = EXPORT_LABELS[locale];
    const v1Row = (group: string, name: string, seat: string, rest: string[]) => [
      '2026-12-01',
      '10:00–12:00',
      'زيارة مزرعة الخضر',
      group,
      name,
      seat,
      ...rest,
    ];
    const v2Row = (name: string, seat: string, rest: string[]) => [
      '2026-12-03',
      '09:00',
      'Dairy farm, unit 2',
      'المجموعة ب',
      name,
      seat,
      ...rest,
    ];
    return [
      v1Row('المجموعة أ', 'محمد أحمد علي حسن', '2026-101', [
        L.status.PRESENT,
        '2026-12-01 09:58',
        '0',
        L.source.QR,
        '',
      ]),
      v1Row('المجموعة أ', `'=HYPERLINK("http://evil.example")`, '2026-104', [
        L.status.PRESENT,
        '',
        '0',
        L.source.MANUAL,
        'Arrived with the supervisor, "confirmed"',
      ]),
      v1Row('المجموعة أ', 'سارة إبراهيم', '2026-105', [
        L.status.ABSENT,
        '',
        '0',
        L.source.AUTOMATIC,
        '',
      ]),
      v1Row('المجموعة ب', 'فاطمة محمود السيد', '2026-102', [
        L.status.LATE,
        '2026-12-01 10:22',
        '7',
        L.source.QR,
        '',
      ]),
      v1Row('المجموعة ب', 'Omar Khaled', '2026-103', [
        L.status.ABSENT,
        '',
        '0',
        L.source.AUTOMATIC,
        '',
      ]),
      v2Row('فاطمة محمود السيد', '2026-102', [
        L.status.PRESENT,
        '2026-12-03 08:50',
        '0',
        L.source.QR,
        '',
      ]),
      v2Row('Omar Khaled', '2026-103', [L.status.LATE, '2026-12-03 09:18', '3', L.source.QR, '']),
    ];
  }

  const header = (locale: 'ar' | 'en') => {
    const c = EXPORT_LABELS[locale].columns;
    return [
      c.date,
      c.time,
      c.visit,
      c.group,
      c.student,
      c.seat,
      c.status,
      c.checkIn,
      c.minutesLate,
      c.source,
      c.note,
    ];
  };

  /** Same visit and group order; names within a group may follow the collation. */
  const sameRows = (actual: string[][], expected: string[][]) => {
    expect(actual.map((r) => `${r[0]}|${r[3]}`)).toEqual(expected.map((r) => `${r[0]}|${r[3]}`));
    expect([...actual].sort()).toEqual([...expected].sort());
  };

  it('CSV: UTF-8 with BOM, Arabic intact, formulas neutralized, every record once', async () => {
    const res = await download('format=csv').expect(200);
    expect(res.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(res.headers['content-disposition']).toMatch(
      /^attachment; filename="ftms-attendance-202612101200\.csv"/,
    );
    expect(res.headers['cache-control']).toBe('no-store');
    const body = res.body as Buffer;
    expect([...body.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const text = body.subarray(3).toString('utf8');
    expect(text.endsWith('\r\n')).toBe(true);
    expect(text).toContain('"\'=HYPERLINK(""http://evil.example"")"');
    const [head, ...rows] = parseCsv(text);
    expect(head).toEqual(header('ar'));
    sameRows(rows, expectedRows('ar'));

    // The export finalized the missing absence, exactly as the dashboard would.
    const absence = await prisma.attendanceRecord.findFirstOrThrow({
      where: { visitId: v1, studentId: ids.s5 },
    });
    expect(absence).toMatchObject({ status: 'ABSENT', source: 'AUTOMATIC' });
    const table = await http()
      .get(`/visits/${v1}/attendance`)
      .set(bearer(facultyToken))
      .expect(200);
    const statuses = VisitAttendanceResponseSchema.parse(table.body)
      .rows.map((r) => `${r.student.seatNumber}:${r.record?.status}`)
      .sort();
    expect(statuses).toEqual([
      '2026-101:PRESENT',
      '2026-102:LATE',
      '2026-103:ABSENT',
      '2026-104:PRESENT',
      '2026-105:ABSENT',
    ]);
  });

  it('XLSX: structured cells, numbers as numbers, right-to-left for Arabic', async () => {
    const read = async (locale: 'ar' | 'en') => {
      const res = await download(`format=xlsx&locale=${locale}`).expect(200);
      expect(res.headers['content-type']).toBe(
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      );
      const workbook = new Workbook();
      await workbook.xlsx.load(res.body as Parameters<typeof workbook.xlsx.load>[0]);
      const sheet = workbook.worksheets[0]!;
      const rows: CellValue[][] = [];
      sheet.eachRow((row) => {
        rows.push(Array.from({ length: 11 }, (_, i) => row.getCell(i + 1).value ?? ''));
      });
      return { sheet, rows };
    };

    for (const locale of ['ar', 'en'] as const) {
      const { sheet, rows } = await read(locale);
      expect(sheet.name).toBe(EXPORT_LABELS[locale].sheet);
      expect(sheet.views[0]).toMatchObject({ state: 'frozen', ySplit: 1 });
      expect(Boolean(sheet.views[0]?.rightToLeft)).toBe(locale === 'ar');
      expect(sheet.autoFilter).toBeTruthy();
      const [head, ...data] = rows;
      expect(head).toEqual(header(locale));
      // Minutes late are numbers; nothing is a formula.
      for (const row of data) expect(typeof row[8]).toBe('number');
      sheet.eachRow((row) => row.eachCell((cell) => expect(cell.formula).toBeUndefined()));
      sameRows(
        data.map((r) => r.map(String)),
        expectedRows(locale),
      );
    }
  });

  it('PDF: a printable document with the Arabic font embedded, showing every record', async () => {
    for (const locale of ['ar', 'en'] as const) {
      const res = await download(`format=pdf&locale=${locale}`).expect(200);
      expect(res.headers['content-type']).toBe('application/pdf');
      const pdf = (res.body as Buffer).toString('latin1');
      expect(pdf.startsWith('%PDF-')).toBe(true);
      expect(pdf.trimEnd().endsWith('%%EOF')).toBe(true);
      expect(pdf).toContain('IBMPlexSansArabic');
      expect(pdf.match(/\/Type\s*\/Page[^s]/g)).toHaveLength(1);

      // The text drawn on the page: one record per row (long cells wrap onto
      // the following lines). The PDF's text layer stores shaped Arabic glyphs,
      // so extracted Arabic can come out with letters swapped or split (see
      // docs/limitations.md); Arabic cells are compared by their letters, and
      // dates, times, seat numbers and minutes late exactly.
      const lines = pdfLines(res.body as Buffer, locale === 'ar')[0]!;
      const records: { cells: string[]; text: string }[] = [];
      for (const line of lines) {
        if (/^\d{4}-\d{2}-\d{2}$/.test(line[0] ?? '')) records.push({ cells: line, text: '' });
        if (records.length > 0 && !/^\S+ \d+ \/ \d+$/.test(line.join(' '))) {
          records.at(-1)!.text += line.join('');
        }
      }
      const letters = (text: string) =>
        [...text.normalize('NFKC').replace(/[\s\-—]/g, '')].sort().join('');
      const L = EXPORT_LABELS[locale];
      const expected = expectedRows(locale).map((r) => {
        const name = r[4]!.replace(/^'/, ''); // a PDF cannot run formulas: shown as typed
        const checkIn = r[7] || '—';
        const late = r[6] === L.status.LATE ? r[8]! : '—';
        return {
          key: [r[0], r[1], r[5], checkIn, late],
          letters: letters(
            [r[0], r[1], r[2], r[3], name, r[5], r[6], checkIn, late, r[9], r[10]].join(''),
          ),
          group: `${r[0]}|${r[3]}`,
        };
      });
      expect(
        records.map((r) => [r.cells[0], r.cells[1], r.cells[5], r.cells[7], r.cells[8]]).sort(),
      ).toEqual(expected.map((e) => e.key).sort());
      expect(records.map((r) => letters(r.text)).sort()).toEqual(
        expected.map((e) => e.letters).sort(),
      );
      // Same visit and group order as the other formats.
      expect(records.map((r) => letters(`${r.cells[0]}${r.cells[3]}`))).toEqual(
        expected.map((e) => letters(e.group.replace('|', ''))),
      );
      const count = lines.find(
        (l) => l.join(' ').includes(String(expected.length)) && l.length === 1,
      );
      expect(count).toBeDefined();
    }
  });

  it('filters by visit, date range, group, student and status', async () => {
    const seats = async (query: string) => {
      const res = await download(`format=csv&locale=en&${query}`).expect(200);
      const [, ...rows] = parseCsv((res.body as Buffer).subarray(3).toString('utf8'));
      return rows.map((r) => `${r[0]}:${r[5]}:${r[6]}`).sort();
    };
    expect(await seats(`visit=${v2}`)).toEqual([
      '2026-12-03:2026-102:Present',
      '2026-12-03:2026-103:Late',
    ]);
    expect(await seats('from=2026-12-02&to=2026-12-31')).toEqual([
      '2026-12-03:2026-102:Present',
      '2026-12-03:2026-103:Late',
    ]);
    expect(await seats('to=2026-12-01')).toHaveLength(5);
    expect(await seats(`group=${groupA.id}`)).toEqual([
      '2026-12-01:2026-101:Present',
      '2026-12-01:2026-104:Present',
      '2026-12-01:2026-105:Absent',
    ]);
    expect(await seats(`student=${ids.s3}`)).toEqual([
      '2026-12-01:2026-103:Absent',
      '2026-12-03:2026-103:Late',
    ]);
    expect(await seats('status=LATE')).toEqual([
      '2026-12-01:2026-102:Late',
      '2026-12-03:2026-103:Late',
    ]);
    expect(await seats(`status=LATE&group=${groupA.id}`)).toEqual([]);
    const bad = await download('format=csv&from=2026-12-05&to=2026-12-01').expect(400);
    expect(JSON.parse((bad.body as Buffer).toString('utf8'))).toMatchObject({
      code: 'VALIDATION_FAILED',
      details: { to: ['END_BEFORE_START'] },
    });
    await download('format=docx').expect(400);
  });

  it('lists guest records and guest submissions that matched nobody, marked as not verified (Phase 8)', async () => {
    // A guest submission whose seat number matched s5 created s5's record (unverified)…
    const s5Record = await prisma.attendanceRecord.findFirst({
      where: { visitId: v1, studentId: ids.s5 },
    });
    expect(s5Record).toBeNull();
    clock.set(at('2026-12-01', '10:30'));
    const guestRecord = await prisma.attendanceRecord.create({
      data: {
        visitId: v1,
        studentId: ids.s5,
        groupId: groupA.id,
        status: 'LATE',
        minutesLate: 4,
        checkedInAt: at('2026-12-01', '10:19'),
        source: 'GUEST',
        latitude: 30.1,
        longitude: 31.2,
      },
    });
    await prisma.guestCheckIn.createMany({
      data: [
        {
          visitId: v1,
          submissionKey: '01900000-0000-7000-8000-0000000000a1',
          fullName: 'سارة إبراهيم',
          seatNumber: '2026-105',
          status: 'LATE',
          minutesLate: 4,
          submittedAt: at('2026-12-01', '10:19'),
          latitude: 30.1,
          longitude: 31.2,
          outcome: 'RECORDED',
          studentId: ids.s5,
          attendanceRecordId: guestRecord.id,
          nameMatches: true,
        },
        // …and one typed a seat number nobody in the visit's group has.
        {
          visitId: v2,
          submissionKey: '01900000-0000-7000-8000-0000000000a2',
          fullName: 'زائر غير معروف',
          seatNumber: '2026-999',
          status: 'PRESENT',
          minutesLate: 0,
          submittedAt: at('2026-12-03', '08:55'),
          latitude: 30.1,
          longitude: 31.2,
          outcome: 'UNMATCHED',
        },
      ],
    });
    clock.set(at('2026-12-10', '12:00'));
    const L = EXPORT_LABELS.en;
    const csv = async (query = '') =>
      parseCsv(
        ((await download(`format=csv&locale=en${query}`).expect(200)).body as Buffer)
          .subarray(3)
          .toString('utf8'),
      ).slice(1);
    const rows = await csv();
    expect(rows).toHaveLength(8);
    expect(rows.find((r) => r[5] === '2026-105')).toEqual([
      '2026-12-01',
      '10:00–12:00',
      'زيارة مزرعة الخضر',
      'المجموعة أ',
      'سارة إبراهيم',
      '2026-105',
      L.status.LATE,
      '2026-12-01 10:19',
      '4',
      L.source.GUEST,
      '',
    ]);
    // The unmatched submission comes after the visit's groups, with no group.
    expect(rows.at(-1)).toEqual([
      '2026-12-03',
      '09:00',
      'Dairy farm, unit 2',
      '',
      'زائر غير معروف',
      '2026-999',
      L.status.PRESENT,
      '2026-12-03 08:55',
      '0',
      L.source.GUEST_UNMATCHED,
      '',
    ]);
    // It belongs to no group or student, so those filters leave it out.
    expect((await csv(`&group=${groupB.id}`)).map((r) => r[5])).not.toContain('2026-999');
    expect((await csv('&status=PRESENT')).map((r) => r[5])).toContain('2026-999');
    expect((await csv('&status=LATE')).map((r) => r[5])).not.toContain('2026-999');
    // The PDF shows the same rows (the empty group as a dash).
    const pdf = await download('format=pdf&locale=en').expect(200);
    const text = pdfLines(pdf.body as Buffer, false)
      .flat()
      .map((l) => l.join(' '));
    expect(text.some((l) => l.includes('2026-999') && l.includes('—'))).toBe(true);
    expect(text.some((l) => l.includes('Records: 8'))).toBe(true);
  });

  it('is audited without personal data', async () => {
    await download(`format=xlsx&group=${groupA.id}`).expect(200);
    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { action: 'attendance.exported' },
    });
    expect(audit).toMatchObject({
      actorId: faculty.id,
      outcome: 'SUCCESS',
      metadata: { format: 'xlsx', rows: 3, filters: { group: groupA.id, visit: null } },
    });
    const text = JSON.stringify([audit.before, audit.after, audit.metadata, audit.reason]);
    expect(text).not.toContain('محمد');
    expect(text).not.toContain('2026-101');
  });

  it('only exports for accounts allowed to read attendance and export reports', async () => {
    const student = await createUser(app, 'STUDENT');
    const studentToken = (await login(app, student.email, student.password!)).accessToken;
    expect((await download('format=csv', studentToken)).status).toBe(403);
    expect((await http().get('/attendance/export?format=csv')).status).toBe(401);

    const admin = await createUser(app, 'SUPER_ADMIN');
    expect(
      (await download('format=csv', (await login(app, admin.email, admin.password!)).accessToken))
        .status,
    ).toBe(200);
    const director = await createUser(app, 'TRAINING_DIRECTOR');
    const directorToken = (await login(app, director.email, director.password!)).accessToken;
    expect((await download('format=pdf', directorToken)).status).toBe(200);

    for (const permissionKey of ['reports.export', 'attendance.read']) {
      const restricted = await createUser(app, 'FACULTY');
      await prisma.userPermissionGrant.create({
        data: {
          userId: restricted.id,
          permissionKey,
          effect: 'DENY',
          grantedById: director.id,
          reason: 'Export restricted',
        },
      });
      const token = (await login(app, restricted.email, restricted.password!)).accessToken;
      const res = await download('format=csv', token);
      expect(res.status).toBe(403);
    }
    expect(await prisma.auditLog.count({ where: { action: 'attendance.exported' } })).toBe(2);
  });

  it('handles a large visit and refuses a PDF beyond its row limit', async () => {
    const { id: programId } = await prisma.trainingProgram.findFirstOrThrow({
      select: { id: true },
    });
    const big = await createGroup(app, 'Big group');
    const visit = await createVisit(app, programId, [big.id], { date: '2026-12-07' });
    const count = 3001;
    const profiles = await prisma.studentProfile.createManyAndReturn({
      data: Array.from({ length: count }, (_, i) => ({
        seatNumber: `L-${String(i).padStart(4, '0')}`,
        fullName: `طالب رقم ${i}`,
      })),
      select: { id: true },
    });
    await prisma.groupMembership.createMany({
      data: profiles.map((p) => ({ studentId: p.id, groupId: big.id, source: 'MANUAL' as const })),
    });
    await prisma.attendanceRecord.createMany({
      data: profiles.map((p, i) => ({
        visitId: visit.id,
        studentId: p.id,
        groupId: big.id,
        status: i % 2 ? ('LATE' as const) : ('PRESENT' as const),
        minutesLate: i % 2 ? (i % 45) + 1 : 0,
        checkedInAt: at('2026-12-07', '10:05'),
        source: 'QR' as const,
      })),
    });

    const pdf = await download(`format=pdf&visit=${visit.id}`).expect(422);
    expect(JSON.parse((pdf.body as Buffer).toString('utf8'))).toMatchObject({
      code: 'EXPORT_TOO_LARGE',
    });
    const csv = await download(`format=csv&visit=${visit.id}`).expect(200);
    const [, ...rows] = parseCsv((csv.body as Buffer).subarray(3).toString('utf8'));
    expect(rows).toHaveLength(count);
    const late = rows.filter((r) => r[6] === EXPORT_LABELS.ar.status.LATE);
    expect(late).toHaveLength(1500);
    expect(late.reduce((sum, r) => sum + Number(r[8]), 0)).toBe(
      profiles.reduce((sum, _p, i) => sum + (i % 2 ? (i % 45) + 1 : 0), 0),
    );
  });
});
