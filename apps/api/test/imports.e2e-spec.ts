import { type ImportPreview, ImportPreviewSchema, ListImportsResponseSchema } from '@ftms/core';
import { Workbook } from 'exceljs';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import {
  addToGroup,
  bearer,
  bootTestApp,
  buildWorkbook,
  createGroup,
  createStudentRecord,
  createUser,
  login,
  type Mailbox,
  recordOf,
  resetDatabase,
  TEMPLATE_HEADERS,
  type TestApp,
} from './helpers/test-app';

const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

describe('Spreadsheet import of student records (§4.1)', () => {
  let app: TestApp;
  let mailbox: Mailbox;
  let prisma: PrismaService;
  let faculty: { id: string; token: string };
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
    const f = await createUser(app, 'FACULTY');
    faculty = { id: f.id, token: (await login(app, f.email, f.password!)).accessToken };
  });

  const upload = (file: Buffer, token = faculty.token, name = 'students.xlsx') =>
    http()
      .post('/student-imports')
      .set(bearer(token))
      .attach('file', file, { filename: name, contentType: XLSX });

  async function preview(file: Buffer): Promise<ImportPreview> {
    const res = await upload(file).expect(201);
    return ImportPreviewSchema.parse(res.body);
  }

  const commit = (
    p: ImportPreview,
    options: { applyUpdates?: boolean; skipInvalidRows?: boolean } = {},
  ) =>
    http()
      .post(`/student-imports/${p.id}/commit`)
      .set(bearer(faculty.token))
      .send({
        planDigest: p.planDigest,
        applyUpdates: options.applyUpdates ?? false,
        skipInvalidRows: options.skipInvalidRows ?? false,
      });

  it('the downloadable template is a valid workbook the importer reads back (DoD)', async () => {
    const res = await http()
      .get('/student-imports/template')
      .set(bearer(faculty.token))
      .buffer(true)
      .parse((r, done) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => done(null, Buffer.concat(chunks)));
      })
      .expect(200);
    expect(res.headers['content-type']).toBe(XLSX);
    expect(res.headers['content-disposition']).toContain('ftms-students-template.xlsx');

    // Fill the template the way faculty would, and import it.
    const workbook = new Workbook();
    const template = res.body as Buffer;
    await workbook.xlsx.load(template as unknown as Parameters<typeof workbook.xlsx.load>[0]);
    const sheet = workbook.worksheets[0]!;
    expect(sheet.getRow(1).getCell(1).value).toBe('رقم الجلوس / Seat number');
    const group = await createGroup(app, 'المجموعة 1');
    sheet.addRow([
      '2024-0153',
      'محمد',
      'أحمد',
      'علي',
      'حسن',
      'st0153@agr.asu.edu.eg',
      'المجموعة 1',
      '01012345678',
    ]);
    sheet.addRow(['2024-0154', 'سارة', 'محمود', 'إبراهيم', 'سالم', null, null, null]);
    const filled = Buffer.from(await workbook.xlsx.writeBuffer());

    const p = await preview(filled);
    expect(p.summary).toEqual({ total: 2, create: 2, update: 0, unchanged: 0, error: 0 });
    expect(p.ignoredColumns).toEqual([]);
    const done = ImportPreviewSchema.parse((await commit(p).expect(200)).body);
    expect(done.status).toBe('COMMITTED');
    expect(done.result).toMatchObject({ created: 2, updated: 0, skippedInvalid: 0 });

    const first = await prisma.studentProfile.findUniqueOrThrow({
      where: { seatNumber: '2024-0153' },
      include: { memberships: true },
    });
    expect(first).toMatchObject({
      fullName: 'محمد أحمد علي حسن',
      firstName: 'محمد',
      familyName: 'حسن',
      universityEmail: 'st0153@agr.asu.edu.eg',
      phone: '01012345678',
      userId: null,
      createdById: faculty.id,
    });
    expect(first.memberships).toMatchObject([
      { groupId: group.id, source: 'IMPORT', endedAt: null },
    ]);
  });

  it('normalizes cells: Arabic digits, numeric cells, hyperlinked emails, full-name column', async () => {
    const file = await buildWorkbook(
      ['Seat number', 'Full name', 'E-mail', 'Mobile', 'Notes'],
      [
        [
          '٢٠٢٤٠١٥٥',
          'آمنة   عبد الرحمن',
          { text: 'Amna@AGR.asu.edu.eg', hyperlink: 'mailto:Amna@AGR.asu.edu.eg' },
          1012345678,
          'x',
        ],
        [20240156, 'يوسف خالد', null, '+20 10 1234 5678', null],
      ],
    );
    const p = await preview(file);
    expect(p.ignoredColumns).toEqual(['Notes']);
    expect(p.rows.map((r) => [r.seatNumber, r.fullName, r.universityEmail, r.action])).toEqual([
      ['20240155', 'آمنة عبد الرحمن', 'amna@agr.asu.edu.eg', 'CREATE'],
      ['20240156', 'يوسف خالد', null, 'CREATE'],
    ]);
    await commit(p).expect(200);
    const amna = await prisma.studentProfile.findUniqueOrThrow({
      where: { seatNumber: '20240155' },
    });
    expect(amna).toMatchObject({
      phone: '01012345678',
      firstName: null,
      fullName: 'آمنة عبد الرحمن',
    });
  });

  it('reports invalid rows with reasons and imports the rest only when told to skip them', async () => {
    await createStudentRecord(app, {
      seatNumber: 'TAKEN-EMAIL',
      universityEmail: 'used@agr.asu.edu.eg',
    });
    const staff = await createUser(app, 'FACULTY', { email: 'dr.staff@agr.asu.edu.eg' });
    const archived = await createGroup(app, 'Closed');
    await prisma.trainingGroup.update({
      where: { id: archived.id },
      data: { archivedAt: new Date() },
    });

    const file = await buildWorkbook(TEMPLATE_HEADERS, [
      ['OK-1', 'محمد', 'أحمد', 'علي', 'حسن', null, null, null], // row 2: valid
      [null, 'محمد', 'أحمد', null, null, null, null, null], // 3: no seat
      ['BAD SEAT', 'محمد', 'أحمد', null, null, null, null, null], // 4: invalid seat
      ['DUP-1', 'محمد', 'أحمد', null, null, null, null, null], // 5: duplicate seat in file
      ['DUP-1', 'سارة', 'محمود', null, null, null, null, null], // 6
      ['E-1', 'محمد', 'أحمد', null, null, 'someone@gmail.com', null, null], // 7: not university
      ['E-2', 'محمد', 'أحمد', null, null, 'used@agr.asu.edu.eg', null, null], // 8: other record's email
      ['E-3', 'محمد', 'أحمد', null, null, staff.email, null, null], // 9: staff email
      ['G-1', 'محمد', 'أحمد', null, null, null, 'Nowhere', null], // 10: unknown group
      ['G-2', 'محمد', 'أحمد', null, null, null, 'Closed', null], // 11: archived group
      ['N-1', 'محمد', null, null, null, null, null, null], // 12: one name part
      ['P-1', 'محمد', 'أحمد', null, null, null, null, 'call me'], // 13: bad phone
    ]);
    const p = await preview(file);
    const errorsOf = (rowNumber: number) => p.rows.find((r) => r.rowNumber === rowNumber)?.errors;
    expect(p.summary).toMatchObject({ total: 12, create: 1, error: 11 });
    expect(errorsOf(3)).toEqual(['SEAT_REQUIRED']);
    expect(errorsOf(4)).toEqual(['SEAT_NUMBER_INVALID']);
    expect(errorsOf(5)).toEqual(['DUPLICATE_SEAT_IN_FILE']);
    expect(errorsOf(6)).toEqual(['DUPLICATE_SEAT_IN_FILE']);
    expect(errorsOf(7)).toEqual(['EMAIL_NOT_UNIVERSITY']);
    expect(errorsOf(8)).toEqual(['EMAIL_USED_BY_OTHER_STUDENT']);
    expect(errorsOf(9)).toEqual(['EMAIL_USED_BY_STAFF']);
    expect(errorsOf(10)).toEqual(['GROUP_NOT_FOUND']);
    expect(errorsOf(11)).toEqual(['GROUP_ARCHIVED']);
    expect(errorsOf(12)).toEqual(['NAME_TOO_SHORT']);
    expect(errorsOf(13)).toEqual(['PHONE_INVALID']);

    const refused = await commit(p).expect(409);
    expect(refused.body.code).toBe('IMPORT_HAS_ERRORS');
    expect(await prisma.studentProfile.count({ where: { seatNumber: 'OK-1' } })).toBe(0);

    const done = ImportPreviewSchema.parse(
      (await commit(p, { skipInvalidRows: true }).expect(200)).body,
    );
    expect(done.result).toMatchObject({ created: 1, skippedInvalid: 11 });
    // The pre-existing record plus OK-1.
    expect(await prisma.studentProfile.count()).toBe(2);
  });

  it('never overwrites silently: updates need explicit confirmation, blanks never erase', async () => {
    const group = await createGroup(app, 'A');
    const other = await createGroup(app, 'B');
    const record = await createStudentRecord(app, {
      seatNumber: 'U-1',
      parts: ['محمد', 'أحمد', 'علي', 'حسن'],
      universityEmail: null,
      phone: '01000000000',
    });
    await addToGroup(app, record.id, group.id);
    const same = await createStudentRecord(app, {
      seatNumber: 'U-2',
      parts: ['سارة', 'محمود', 'سالم', 'سعيد'],
    });

    const file = await buildWorkbook(TEMPLATE_HEADERS, [
      // New family name and email, blank phone, new group.
      ['U-1', 'محمد', 'أحمد', 'علي', 'حسين', 'u1@agr.asu.edu.eg', 'B', null],
      // Identical to the database: unchanged.
      ['U-2', 'سارة', 'محمود', 'سالم', 'سعيد', null, null, null],
    ]);
    const sameBefore = await prisma.studentProfile.findUniqueOrThrow({ where: { id: same.id } });
    const p = await preview(file);
    expect(p.summary).toMatchObject({ update: 1, unchanged: 1 });
    expect(p.rows[0]!.changes).toEqual([
      { field: 'familyName', from: 'حسن', to: 'حسين' },
      { field: 'fullName', from: 'محمد أحمد علي حسن', to: 'محمد أحمد علي حسين' },
      { field: 'universityEmail', from: null, to: 'u1@agr.asu.edu.eg' },
      { field: 'group', from: 'A', to: 'B' },
    ]);

    // Committed without confirming updates: nothing changes on the existing record.
    const skipped = ImportPreviewSchema.parse((await commit(p).expect(200)).body);
    expect(skipped.result).toMatchObject({
      created: 0,
      updated: 0,
      skippedUpdates: 1,
      unchanged: 1,
    });
    expect(
      (await prisma.studentProfile.findUniqueOrThrow({ where: { id: record.id } })).familyName,
    ).toBe('حسن');

    // Upload again, confirm the updates this time.
    const again = await preview(file);
    await commit(again, { applyUpdates: true }).expect(200);
    const updated = await prisma.studentProfile.findUniqueOrThrow({
      where: { id: record.id },
      include: { memberships: { where: { endedAt: null } } },
    });
    expect(updated).toMatchObject({
      familyName: 'حسين',
      fullName: 'محمد أحمد علي حسين',
      universityEmail: 'u1@agr.asu.edu.eg',
      phone: '01000000000', // blank cell did not erase it
    });
    expect(updated.memberships).toMatchObject([{ groupId: other.id, source: 'IMPORT' }]);
    // The unchanged row was not written at all.
    expect(await prisma.studentProfile.findUniqueOrThrow({ where: { id: same.id } })).toEqual(
      sameBefore,
    );

    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { action: 'student.updated', resourceId: record.id },
    });
    expect(audit).toMatchObject({
      actorId: faculty.id,
      before: { familyName: 'حسن' },
      after: { familyName: 'حسين' },
      metadata: { source: 'import', importId: again.id, rowNumber: 2 },
    });
    const committed = await prisma.auditLog.findMany({
      where: { action: 'student_import.committed' },
    });
    expect(committed).toHaveLength(2);
  });

  it('refuses to change the email of a record linked to an account', async () => {
    const student = await createUser(app, 'STUDENT');
    const id = await recordOf(app, student.id);
    const seat = (await prisma.studentProfile.findUniqueOrThrow({ where: { id } })).seatNumber;
    const p = await preview(
      await buildWorkbook(
        ['Seat number', 'Full name', 'University email'],
        [[seat, 'Student X Y', 'new@agr.asu.edu.eg']],
      ),
    );
    expect(p.rows[0]!.errors).toEqual(['EMAIL_LOCKED_BY_ACCOUNT']);
  });

  it('refuses a stale preview: data changed after it was shown', async () => {
    const p = await preview(
      await buildWorkbook(TEMPLATE_HEADERS, [
        ['S-1', 'محمد', 'أحمد', null, null, 'race@agr.asu.edu.eg', null, null],
      ]),
    );
    // Someone else records the same email on another student meanwhile.
    await createStudentRecord(app, { universityEmail: 'race@agr.asu.edu.eg' });
    const res = await commit(p).expect(409);
    expect(res.body.code).toBe('IMPORT_PREVIEW_STALE');
    expect(await prisma.studentProfile.count({ where: { seatNumber: 'S-1' } })).toBe(0);
    // The preview is still open and shows the new situation.
    const fresh = ImportPreviewSchema.parse(
      (await http().get(`/student-imports/${p.id}`).set(bearer(faculty.token)).expect(200)).body,
    );
    expect(fresh.status).toBe('PREVIEW');
    expect(fresh.rows[0]!.errors).toEqual(['EMAIL_USED_BY_OTHER_STUDENT']);
  });

  it('only the uploader commits, and only once; others can see the history', async () => {
    const p = await preview(
      await buildWorkbook(TEMPLATE_HEADERS, [
        ['O-1', 'محمد', 'أحمد', null, null, null, null, null],
      ]),
    );
    const other = await createUser(app, 'FACULTY');
    const otherToken = (await login(app, other.email, other.password!)).accessToken;
    const notMine = await http()
      .post(`/student-imports/${p.id}/commit`)
      .set(bearer(otherToken))
      .send({ planDigest: p.planDigest, applyUpdates: false, skipInvalidRows: false })
      .expect(403);
    expect(notMine.body.code).toBe('IMPORT_NOT_OWNER');

    const [first, second] = await Promise.all([commit(p), commit(p)]);
    expect([first.status, second.status].sort()).toEqual([200, 409]);
    expect(await prisma.studentProfile.count({ where: { seatNumber: 'O-1' } })).toBe(1);

    const list = ListImportsResponseSchema.parse(
      (await http().get('/student-imports').set(bearer(otherToken)).expect(200)).body,
    );
    expect(list.items[0]).toMatchObject({ id: p.id, status: 'COMMITTED', result: { created: 1 } });
    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { action: 'student_import.previewed' },
    });
    expect(audit.metadata).toMatchObject({ fileName: 'students.xlsx', storedFile: false });
  });

  it('a discarded preview cannot be committed', async () => {
    const p = await preview(
      await buildWorkbook(TEMPLATE_HEADERS, [
        ['D-1', 'محمد', 'أحمد', null, null, null, null, null],
      ]),
    );
    await http().delete(`/student-imports/${p.id}`).set(bearer(faculty.token)).expect(204);
    const res = await commit(p).expect(409);
    expect(res.body.code).toBe('IMPORT_NOT_OPEN');
  });

  it('rejects files that are not student spreadsheets', async () => {
    const notXlsx = await upload(
      Buffer.from('seat,name\n1,x'),
      faculty.token,
      'students.csv',
    ).expect(400);
    expect(notXlsx.body.code).toBe('FILE_INVALID');
    const fake = await upload(
      Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('not really a zip')]),
      faculty.token,
    ).expect(400);
    expect(fake.body.code).toBe('FILE_INVALID');
    const noSeat = await upload(await buildWorkbook(['Name', 'Email'], [['x y', null]])).expect(
      400,
    );
    expect(noSeat.body).toMatchObject({
      code: 'IMPORT_HEADERS_MISSING',
      details: { columns: ['seatNumber'] },
    });
    const noName = await upload(
      await buildWorkbook(['Seat number', 'Email'], [['1', null]]),
    ).expect(400);
    expect(noName.body).toMatchObject({
      code: 'IMPORT_HEADERS_MISSING',
      details: { columns: ['fullName'] },
    });
    const empty = await upload(await buildWorkbook(['Seat number', 'Full name'], [])).expect(400);
    expect(empty.body.code).toBe('IMPORT_EMPTY');
    const big = await upload(Buffer.alloc(4 * 1024 * 1024 + 10, 1)).expect(413);
    expect(big.body.code).toBe('FILE_TOO_LARGE');
  });

  it('without groups.manage, group cells are refused instead of applied', async () => {
    const f = await createUser(app, 'FACULTY');
    const sa = await createUser(app, 'SUPER_ADMIN');
    const saToken = (await login(app, sa.email, sa.password!)).accessToken;
    await http()
      .put(`/admin/users/${f.id}/permissions`)
      .set(bearer(saToken))
      .send({ grants: [{ permission: 'groups.manage', effect: 'DENY' }], reason: 'import only' })
      .expect(200);
    const token = (await login(app, f.email, f.password!)).accessToken;
    await createGroup(app, 'A');
    const res = await upload(
      await buildWorkbook(TEMPLATE_HEADERS, [
        ['GP-1', 'محمد', 'أحمد', null, null, null, 'A', null],
      ]),
      token,
    ).expect(201);
    expect(res.body.rows[0].errors).toEqual(['GROUP_PERMISSION_REQUIRED']);
  });
});
