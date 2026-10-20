import { type CellValue, Workbook, type Worksheet } from 'exceljs';
import { IMPORT_MAX_ROWS, type ImportColumn, nameMatchKey } from '@ftms/core';
import { StudentErrors } from '../student-errors';

/**
 * Header names recognized for each column, in Arabic and English. Headers are
 * compared with `nameMatchKey`, so case, spacing, punctuation and the usual
 * Arabic spelling variants do not matter. A header may also combine both
 * languages ("رقم الجلوس / Seat number"), as the template does.
 */
export const COLUMN_ALIASES: Record<ImportColumn, readonly string[]> = {
  seatNumber: ['Seat number', 'Seat no', 'Seat', 'رقم الجلوس', 'رقم جلوس'],
  fullName: [
    'Full name',
    'Name',
    'Student name',
    'الاسم',
    'الاسم بالكامل',
    'الاسم الكامل',
    'اسم الطالب',
    'الاسم رباعي',
    'الاسم الرباعي',
  ],
  firstName: ['First name', 'Given name', 'الاسم الأول'],
  fatherName: ["Father's name", 'Father name', 'Second name', 'اسم الأب'],
  grandfatherName: ["Grandfather's name", 'Grandfather name', 'Third name', 'اسم الجد'],
  familyName: ['Family name', 'Last name', 'Surname', 'Fourth name', 'اسم العائلة', 'اللقب'],
  universityEmail: [
    'University email',
    'Email',
    'E-mail',
    'البريد الجامعي',
    'البريد الإلكتروني الجامعي',
    'البريد الإلكتروني',
    'الإيميل الجامعي',
    'الإيميل',
  ],
  group: ['Group', 'Training group', 'Group name', 'المجموعة', 'مجموعة التدريب', 'اسم المجموعة'],
  phone: [
    'Phone',
    'Phone number',
    'Mobile',
    'Mobile number',
    'رقم الهاتف',
    'الهاتف',
    'رقم الموبايل',
    'الموبايل',
    'رقم المحمول',
  ],
};

const ALIAS_INDEX = new Map<string, ImportColumn>(
  (Object.entries(COLUMN_ALIASES) as [ImportColumn, readonly string[]][]).flatMap(
    ([column, aliases]) => aliases.map((alias) => [nameMatchKey(alias), column] as const),
  ),
);

/** Which column a header cell names, if any ("رقم الجلوس / Seat number" works too). */
export function columnForHeader(header: string): ImportColumn | null {
  const candidates = [header, ...header.split(/[/|\n]/)];
  for (const candidate of candidates) {
    const column = ALIAS_INDEX.get(nameMatchKey(candidate.replace(/\*/g, '')));
    if (column) return column;
  }
  return null;
}

export type CellText = string | null | { unreadable: true };

export interface RawImportRow {
  /** Spreadsheet row number (1-based, as Excel shows it). */
  rowNumber: number;
  cells: Partial<Record<ImportColumn, CellText>>;
}

export interface ParsedWorkbook {
  sheetName: string;
  columns: ImportColumn[];
  ignoredColumns: string[];
  rows: RawImportRow[];
}

/** How far down the header row may be (title rows above it are allowed). */
const HEADER_SEARCH_ROWS = 10;

/**
 * Plain text of a cell. Numbers become integer strings (seat numbers and phones
 * are often stored as numbers); rich text, hyperlinks (emails) and formula
 * results are unwrapped; dates and Excel errors are unreadable for these columns.
 */
export function cellText(value: CellValue | undefined): CellText {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value.trim() === '' ? null : value;
  if (typeof value === 'number') {
    return Number.isFinite(value) && Number.isInteger(value)
      ? value.toFixed(0)
      : { unreadable: true };
  }
  if (typeof value === 'boolean') return { unreadable: true };
  if (value instanceof Date) return { unreadable: true };
  if ('richText' in value) {
    const text = value.richText.map((part) => part.text).join('');
    return text.trim() === '' ? null : text;
  }
  if ('hyperlink' in value) {
    const text = value.text as unknown;
    if (typeof text === 'string' && text.trim() !== '') return text;
    if (text && typeof text === 'object' && 'richText' in text) {
      return cellText(text as CellValue);
    }
    return value.hyperlink.replace(/^mailto:/i, '') || null;
  }
  if ('formula' in value || 'sharedFormula' in value) {
    return cellText((value as { result?: CellValue }).result);
  }
  return { unreadable: true };
}

function findHeader(
  sheet: Worksheet,
): { rowNumber: number; columns: Map<number, ImportColumn>; ignored: string[] } | null {
  const last = Math.min(sheet.rowCount, HEADER_SEARCH_ROWS);
  for (let r = 1; r <= last; r += 1) {
    const row = sheet.getRow(r);
    const columns = new Map<number, ImportColumn>();
    const seen = new Set<ImportColumn>();
    const ignored: string[] = [];
    row.eachCell({ includeEmpty: false }, (cell, colNumber) => {
      const text = cellText(cell.value);
      if (typeof text !== 'string') return;
      const column = columnForHeader(text);
      if (column && !seen.has(column)) {
        columns.set(colNumber, column);
        seen.add(column);
      } else {
        ignored.push(text.trim());
      }
    });
    if (seen.has('seatNumber')) return { rowNumber: r, columns, ignored };
  }
  return null;
}

/** XLSX files are ZIP archives: check the signature before handing bytes to the parser. */
const looksLikeZip = (buffer: Buffer) =>
  buffer.length > 4 &&
  buffer[0] === 0x50 &&
  buffer[1] === 0x4b &&
  buffer[2] === 0x03 &&
  buffer[3] === 0x04;

/**
 * Reads the first worksheet that has a recognizable header row (one naming the
 * seat-number column) and returns its non-empty rows. Structure problems throw
 * API errors that the upload answers with directly.
 */
export async function parseStudentWorkbook(buffer: Buffer): Promise<ParsedWorkbook> {
  if (!looksLikeZip(buffer)) throw StudentErrors.fileInvalid('not an .xlsx workbook');
  const workbook = new Workbook();
  try {
    await workbook.xlsx.load(buffer as unknown as Parameters<typeof workbook.xlsx.load>[0]);
  } catch {
    throw StudentErrors.fileInvalid('the workbook is damaged or not an .xlsx file');
  }

  for (const sheet of workbook.worksheets) {
    const header = findHeader(sheet);
    if (!header) continue;
    const present = new Set(header.columns.values());
    const missing: ImportColumn[] = [];
    if (!present.has('fullName') && !present.has('firstName')) missing.push('fullName');
    if (missing.length > 0) throw StudentErrors.headersMissing(missing);

    const rows: RawImportRow[] = [];
    for (let r = header.rowNumber + 1; r <= sheet.rowCount; r += 1) {
      const row = sheet.getRow(r);
      const cells: RawImportRow['cells'] = {};
      let empty = true;
      for (const [col, column] of header.columns) {
        const text = cellText(row.getCell(col).value);
        cells[column] = text;
        if (text !== null) empty = false;
      }
      if (empty) continue;
      rows.push({ rowNumber: r, cells });
      if (rows.length > IMPORT_MAX_ROWS) throw StudentErrors.importTooManyRows(IMPORT_MAX_ROWS);
    }
    if (rows.length === 0) throw StudentErrors.importEmpty();
    return {
      sheetName: sheet.name,
      columns: [...present],
      ignoredColumns: header.ignored,
      rows,
    };
  }
  throw StudentErrors.headersMissing(['seatNumber']);
}
