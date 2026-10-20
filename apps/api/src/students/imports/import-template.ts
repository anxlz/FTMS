import { Workbook } from 'exceljs';
import { IMPORT_MAX_ROWS, type ImportColumn } from '@ftms/core';

/** Template columns, in order: bilingual headers the importer recognizes. */
export const TEMPLATE_COLUMNS: {
  column: ImportColumn;
  header: string;
  width: number;
  text?: boolean;
}[] = [
  { column: 'seatNumber', header: 'رقم الجلوس / Seat number', width: 22, text: true },
  { column: 'firstName', header: 'الاسم الأول / First name', width: 20 },
  { column: 'fatherName', header: "اسم الأب / Father's name", width: 20 },
  { column: 'grandfatherName', header: "اسم الجد / Grandfather's name", width: 24 },
  { column: 'familyName', header: 'اسم العائلة / Family name', width: 22 },
  { column: 'universityEmail', header: 'البريد الجامعي / University email', width: 34 },
  { column: 'group', header: 'المجموعة / Group', width: 18 },
  { column: 'phone', header: 'رقم الهاتف / Phone', width: 18, text: true },
];

const INSTRUCTIONS: [string, string][] = [
  ['تعليمات الاستيراد', 'Import instructions'],
  ['', ''],
  [
    'املأ ورقة «الطلاب» بدءًا من الصف الثاني؛ صف واحد لكل طالب. لا تغيّر صف العناوين.',
    'Fill in the "Students" sheet from row 2, one student per row. Do not change the header row.',
  ],
  [
    'رقم الجلوس مطلوب وفريد لكل طالب (حروف إنجليزية وأرقام وشرطة فقط).',
    'Seat number is required and unique per student (letters, digits and hyphens only).',
  ],
  [
    'الاسم: الاسم الأول وجزء آخر على الأقل؛ الأجزاء الأربعة كلها إن توفرت.',
    'Name: the first name and at least one more part; all four parts where available.',
  ],
  [
    'البريد الجامعي اختياري، لكنه إن وُجد يجب أن يكون بريد الجامعة. يتيح للطالب الدخول أول مرة برمز يُرسل إليه.',
    'University email is optional; if given it must be a university address. It lets the student sign in the first time with an emailed code.',
  ],
  [
    'المجموعة اختيارية، ويجب أن تكون موجودة في النظام (أنشئها أولًا من صفحة المجموعات).',
    'Group is optional and must already exist (create it first on the Groups page).',
  ],
  ['رقم الهاتف اختياري.', 'Phone is optional.'],
  [
    'الخلايا الفارغة لا تمسح بيانات موجودة. تعديل طالب موجود (نفس رقم الجلوس) لا يُطبَّق إلا بعد تأكيدك في المعاينة.',
    'Blank cells never erase existing data. Changes to an existing student (same seat number) apply only after you confirm them in the preview.',
  ],
  [
    `بحد أقصى ${IMPORT_MAX_ROWS} صف في الملف الواحد، وبحجم أقل من 4 ميجابايت.`,
    `At most ${IMPORT_MAX_ROWS} rows per file, and under 4 MB.`,
  ],
  ['', ''],
  ['مثال (لا تنسخه إلى ورقة الطلاب):', 'Example (do not copy it into the Students sheet):'],
  ['2024-0153 | محمد | أحمد | علي | حسن | st0153@agr.asu.edu.eg | المجموعة 1 | 01012345678', ''],
];

/** The downloadable example spreadsheet (§4.1). */
export async function buildImportTemplate(): Promise<Buffer> {
  const workbook = new Workbook();
  workbook.creator = 'FTMS';
  workbook.created = new Date(0);

  const sheet = workbook.addWorksheet('الطلاب Students', {
    views: [{ state: 'frozen', ySplit: 1, rightToLeft: true }],
  });
  sheet.columns = TEMPLATE_COLUMNS.map((c) => ({
    header: c.header,
    key: c.column,
    width: c.width,
    // Text format keeps leading zeros of phones and seat numbers.
    style: c.text ? { numFmt: '@' } : {},
  }));
  const header = sheet.getRow(1);
  header.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F5F3A' } };
  header.alignment = { vertical: 'middle', wrapText: true };
  header.height = 32;

  const help = workbook.addWorksheet('تعليمات Instructions', {
    views: [{ rightToLeft: true }],
  });
  help.columns = [
    { key: 'ar', width: 90 },
    { key: 'en', width: 90 },
  ];
  for (const [ar, en] of INSTRUCTIONS) help.addRow({ ar, en });
  help.getRow(1).font = { bold: true, size: 14 };
  help.eachRow((row) => {
    row.alignment = { wrapText: true, vertical: 'top' };
  });

  const data = await workbook.xlsx.writeBuffer();
  return Buffer.from(data);
}
