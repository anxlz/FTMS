import { Workbook } from 'exceljs';
import { ApiException } from '../../common/api-exception';
import { cellText, columnForHeader, parseStudentWorkbook } from './import-parser';
import { type ExistingStudent, normalizeRow, type PlanContext, planImport } from './import-plan';
import { buildImportTemplate, TEMPLATE_COLUMNS } from './import-template';

const DOMAINS = ['agr.asu.edu.eg'];

async function workbook(rows: unknown[][]): Promise<Buffer> {
  const wb = new Workbook();
  const sheet = wb.addWorksheet('Sheet1');
  for (const row of rows) sheet.addRow(row);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

const codeOf = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    return error instanceof ApiException ? error.code : 'OTHER';
  }
  return 'NONE';
};

describe('spreadsheet parsing', () => {
  it('recognizes Arabic, English and combined headers', () => {
    expect(columnForHeader('رقم الجلوس')).toBe('seatNumber');
    expect(columnForHeader('Seat Number *')).toBe('seatNumber');
    expect(columnForHeader('رقم الجلوس / Seat number')).toBe('seatNumber');
    expect(columnForHeader("Father's name")).toBe('fatherName');
    expect(columnForHeader('اسم الاب')).toBe('fatherName');
    expect(columnForHeader('البريد الالكتروني')).toBe('universityEmail');
    expect(columnForHeader('مجموعه التدريب')).toBe('group');
    expect(columnForHeader('Remarks')).toBeNull();
  });

  it('reads cell values into text (numbers, rich text, links, formulas)', () => {
    expect(cellText(20240153)).toBe('20240153');
    expect(cellText(12.5)).toEqual({ unreadable: true });
    expect(cellText(new Date())).toEqual({ unreadable: true });
    expect(cellText({ richText: [{ text: 'محمد ' }, { text: 'علي' }] })).toBe('محمد علي');
    expect(cellText({ text: 'a@agr.asu.edu.eg', hyperlink: 'mailto:a@agr.asu.edu.eg' })).toBe(
      'a@agr.asu.edu.eg',
    );
    expect(cellText({ formula: 'A1', result: 'S-1' })).toBe('S-1');
    expect(cellText({ error: '#REF!' })).toEqual({ unreadable: true });
    expect(cellText('   ')).toBeNull();
  });

  it('finds the header below title rows and skips empty rows', async () => {
    const parsed = await parseStudentWorkbook(
      await workbook([
        ['كشف طلاب التدريب الميداني'],
        [],
        ['Seat number', 'Full name', 'Notes'],
        ['1', 'Ali Hassan', 'x'],
        [null, null, null],
        ['2', 'Mona Saeed', null],
      ]),
    );
    expect(parsed.ignoredColumns).toEqual(['Notes']);
    expect(parsed.rows.map((r) => r.rowNumber)).toEqual([4, 6]);
  });

  it('the generated template parses back with every column recognized', async () => {
    const template = await buildImportTemplate();
    const wb = new Workbook();
    await wb.xlsx.load(template as unknown as Parameters<typeof wb.xlsx.load>[0]);
    wb.worksheets[0]!.addRow(['S-1', 'محمد', 'أحمد', 'علي', 'حسن', null, null, null]);
    const parsed = await parseStudentWorkbook(Buffer.from(await wb.xlsx.writeBuffer()));
    expect(parsed.columns.sort()).toEqual(TEMPLATE_COLUMNS.map((c) => c.column).sort());
    expect(parsed.ignoredColumns).toEqual([]);
    expect(parsed.rows).toHaveLength(1);
  });

  it('rejects non-workbooks and workbooks without the required columns', async () => {
    expect(await codeOf(parseStudentWorkbook(Buffer.from('hello')))).toBe('FILE_INVALID');
    expect(await codeOf(parseStudentWorkbook(await workbook([['Name'], ['x y']])))).toBe(
      'IMPORT_HEADERS_MISSING',
    );
    expect(await codeOf(parseStudentWorkbook(await workbook([['Seat number', 'Full name']])))).toBe(
      'IMPORT_EMPTY',
    );
  });
});

describe('row normalization', () => {
  const row = (cells: Record<string, unknown>) =>
    normalizeRow({ rowNumber: 2, cells: cells }, DOMAINS);

  it('composes the full name from parts and checks a full-name column against them', () => {
    expect(
      row({ seatNumber: 's-1', firstName: 'محمد', fatherName: 'أحمد', familyName: 'حسن' }),
    ).toMatchObject({ seatNumber: 'S-1', fullName: 'محمد أحمد حسن', errors: [] });
    expect(
      row({
        seatNumber: 'S-1',
        fullName: 'محمد احمد حسن',
        firstName: 'محمد',
        fatherName: 'أحمد',
        familyName: 'حسن',
      }).errors,
    ).toEqual([]);
    expect(
      row({ seatNumber: 'S-1', fullName: 'سارة علي', firstName: 'محمد', familyName: 'حسن' }).errors,
    ).toEqual(['NAME_PARTS_MISMATCH']);
  });

  it('restores the leading zero of Egyptian mobiles stored as numbers', () => {
    expect(row({ seatNumber: 'S-1', fullName: 'a b', phone: '1012345678' }).phone).toBe(
      '01012345678',
    );
    expect(row({ seatNumber: 'S-1', fullName: 'a b', phone: '+201012345678' }).phone).toBe(
      '+201012345678',
    );
  });

  it('collects every cell problem of a row', () => {
    expect(
      row({
        seatNumber: 'bad seat',
        fullName: 'x',
        universityEmail: 'x@gmail.com',
        phone: '12',
      }).errors.sort(),
    ).toEqual(['EMAIL_NOT_UNIVERSITY', 'NAME_TOO_SHORT', 'PHONE_INVALID', 'SEAT_NUMBER_INVALID']);
    expect(row({ seatNumber: { unreadable: true }, fullName: 'a b' }).errors).toEqual(
      expect.arrayContaining(['CELL_UNREADABLE', 'SEAT_REQUIRED']),
    );
  });
});

describe('import planning', () => {
  const existing: ExistingStudent = {
    id: '0190a6f0-0000-7000-8000-000000000001',
    userId: null,
    seatNumber: 'S-1',
    fullName: 'محمد أحمد علي حسن',
    firstName: 'محمد',
    fatherName: 'أحمد',
    grandfatherName: 'علي',
    familyName: 'حسن',
    universityEmail: null,
    phone: '01000000000',
    group: null,
  };
  const context = (over: Partial<PlanContext> = {}): PlanContext => ({
    bySeat: new Map([[existing.seatNumber, existing]]),
    emailOwners: new Map(),
    groups: new Map([
      ['a', { id: '0190a6f0-0000-7000-8000-0000000000aa', name: 'A', archived: false }],
    ]),
    canAssignGroups: true,
    ...over,
  });
  const rows = (...cells: Record<string, unknown>[]) =>
    cells.map((c, i) => normalizeRow({ rowNumber: i + 2, cells: c }, DOMAINS));

  it('creates, updates (only filled cells), leaves unchanged — deterministically', () => {
    const input = rows(
      { seatNumber: 'S-2', fullName: 'سارة محمود', group: 'a' },
      {
        seatNumber: 'S-1',
        firstName: 'محمد',
        fatherName: 'أحمد',
        grandfatherName: 'علي',
        familyName: 'حسين',
      },
    );
    const plan = planImport(input, context());
    expect(plan.rows.map((r) => r.action)).toEqual(['CREATE', 'UPDATE']);
    expect(plan.rows[1]!.changes.map((c) => c.field)).toEqual(['familyName', 'fullName']);
    expect(plan.writes[1]!.data).not.toHaveProperty('phone'); // blank: kept
    expect(plan.writes[0]!.groupId).toBe('0190a6f0-0000-7000-8000-0000000000aa');
    expect(planImport(input, context()).digest).toBe(plan.digest);

    const same = planImport(rows({ seatNumber: 'S-1', fullName: 'محمد أحمد علي حسن' }), context());
    expect(same.rows[0]!.action).toBe('UNCHANGED');
  });

  it('changes the digest when the database changes', () => {
    const input = rows({ seatNumber: 'S-9', fullName: 'a b', universityEmail: 'x@agr.asu.edu.eg' });
    const before = planImport(input, context());
    const after = planImport(
      input,
      context({
        emailOwners: new Map([['x@agr.asu.edu.eg', { studentId: 'other', staff: false }]]),
      }),
    );
    expect(after.rows[0]!.errors).toEqual(['EMAIL_USED_BY_OTHER_STUDENT']);
    expect(after.digest).not.toBe(before.digest);
  });

  it('flags duplicates inside the file on every occurrence', () => {
    const plan = planImport(
      rows(
        { seatNumber: 'D-1', fullName: 'a b', universityEmail: 'd@agr.asu.edu.eg' },
        { seatNumber: 'D-1', fullName: 'c d' },
        { seatNumber: 'D-2', fullName: 'e f', universityEmail: 'D@agr.asu.edu.eg' },
      ),
      context(),
    );
    expect(plan.rows.map((r) => r.errors)).toEqual([
      ['DUPLICATE_SEAT_IN_FILE', 'DUPLICATE_EMAIL_IN_FILE'],
      ['DUPLICATE_SEAT_IN_FILE'],
      ['DUPLICATE_EMAIL_IN_FILE'],
    ]);
    expect(plan.summary).toMatchObject({ total: 3, error: 3, create: 0 });
  });

  it('a full name alone replaces the parts of an existing record (it cannot be split)', () => {
    const plan = planImport(rows({ seatNumber: 'S-1', fullName: 'محمد أحمد علي حسين' }), context());
    expect(plan.writes[0]!.data).toEqual({
      fullName: 'محمد أحمد علي حسين',
      firstName: null,
      fatherName: null,
      grandfatherName: null,
      familyName: null,
    });
  });
});
