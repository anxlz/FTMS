import { Workbook } from 'exceljs';
import { PROGRAM_TIME_ZONE, utcToZoned } from '@ftms/core';
import { neutralizeFormula } from '../attendance/export.service';

export type Cell = string | number;

/** A downloadable file produced by a report. */
export interface ExportFile {
  body: Buffer;
  contentType: string;
  fileName: string;
}

export const CONTENT_TYPES = {
  csv: 'text/csv; charset=utf-8',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pdf: 'application/pdf',
} as const;

/** "YYYY-MM-DD HH:mm" in Africa/Cairo. */
export const cairoText = (instant: Date): string => {
  const z = utcToZoned(instant, PROGRAM_TIME_ZONE);
  return `${z.date} ${z.time}`;
};

/** File-name stamp, e.g. 202611011030. */
export const fileStamp = (instant: Date): string =>
  cairoText(instant).replace(/[-: ]/g, '').slice(0, 12);

const csvField = (value: Cell): string => {
  if (typeof value === 'number') return String(value);
  const safe = neutralizeFormula(value);
  return /[",\r\n]/.test(safe) || safe !== safe.trim() ? `"${safe.replace(/"/g, '""')}"` : safe;
};

/** UTF-8 with a byte-order mark so spreadsheet programs read Arabic correctly. */
export function toCsv(table: Cell[][]): Buffer {
  const lines = table.map((line) => line.map(csvField).join(','));
  return Buffer.from(`\uFEFF${lines.join('\r\n')}\r\n`, 'utf8');
}

/** One sheet, bold frozen header with filters; right to left for Arabic. */
export async function toXlsx(
  table: Cell[][],
  options: { sheet: string; rtl: boolean; widths: number[]; created: Date },
): Promise<Buffer> {
  const workbook = new Workbook();
  workbook.creator = 'FTMS';
  workbook.created = options.created;
  const sheet = workbook.addWorksheet(options.sheet, {
    views: [{ state: 'frozen', ySplit: 1, rightToLeft: options.rtl }],
  });
  for (const line of table) {
    sheet.addRow(line.map((v) => (typeof v === 'string' ? neutralizeFormula(v) : v)));
  }
  sheet.getRow(1).font = { bold: true };
  sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: table[0]!.length } };
  sheet.columns.forEach((column, i) => {
    column.width = options.widths[i] ?? 14;
  });
  return Buffer.from(await workbook.xlsx.writeBuffer());
}
