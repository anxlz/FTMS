import path from 'node:path';
import { type AttendanceExportRow } from '@ftms/core';
import { Document, Font, Page, renderToBuffer, StyleSheet, Text, View } from '@react-pdf/renderer';
import { createElement as h } from 'react';
import { type ExportLabels } from './export-labels';

/**
 * Printable attendance report (§10.4, §19). IBM Plex Sans Arabic (SIL OFL,
 * `assets/fonts`) covers Arabic and Latin; react-pdf shapes Arabic letters and
 * orders mixed right-to-left / left-to-right text. Arabic reports run right to left.
 */
const FONT_DIR = path.join(__dirname, '..', '..', 'assets', 'fonts');
let registered = false;
export function registerFonts(): void {
  if (registered) return;
  Font.register({
    family: 'Plex Arabic',
    fonts: [
      { src: path.join(FONT_DIR, 'IBMPlexSansArabic-Regular.ttf') },
      { src: path.join(FONT_DIR, 'IBMPlexSansArabic-Bold.ttf'), fontWeight: 700 },
    ],
  });
  // Names and titles must never be hyphenated.
  Font.registerHyphenationCallback((word) => [word]);
  registered = true;
}

const COLUMNS: { key: keyof ExportLabels['columns']; width: number }[] = [
  { key: 'date', width: 9 },
  { key: 'time', width: 8 },
  { key: 'visit', width: 14 },
  { key: 'group', width: 9 },
  { key: 'student', width: 16 },
  { key: 'seat', width: 8 },
  { key: 'status', width: 7 },
  { key: 'checkIn', width: 10 },
  { key: 'minutesLate', width: 6 },
  { key: 'source', width: 8 },
  { key: 'note', width: 9 },
];

/** Rows per landscape A4 page (the first page also carries the title block). */
const ROWS_PER_PAGE = 24;
const FIRST_PAGE_ROWS = 19;

export async function renderAttendancePdf(params: {
  rows: AttendanceExportRow[];
  labels: ExportLabels;
  rtl: boolean;
  generatedAt: string;
  filters: string;
}): Promise<Buffer> {
  registerFonts();
  const { rows, labels, rtl } = params;
  const align = rtl ? 'right' : 'left';
  const styles = StyleSheet.create({
    page: { fontFamily: 'Plex Arabic', fontSize: 7.5, padding: 24, paddingBottom: 36 },
    title: { fontSize: 13, fontWeight: 700, textAlign: align, marginBottom: 4 },
    meta: { fontSize: 8, color: '#4a6272', textAlign: align, marginBottom: 2 },
    row: {
      flexDirection: rtl ? 'row-reverse' : 'row',
      borderBottom: '0.5pt solid #d9e2e8',
      paddingVertical: 3,
    },
    head: { backgroundColor: '#e8f1f7', fontWeight: 700 },
    cell: { paddingHorizontal: 2, textAlign: align },
    footer: {
      position: 'absolute',
      bottom: 14,
      left: 24,
      right: 24,
      fontSize: 7,
      color: '#4a6272',
      textAlign: 'center',
    },
  });
  const value = (row: AttendanceExportRow, key: (typeof COLUMNS)[number]['key']): string => {
    switch (key) {
      case 'date':
        return row.date;
      case 'time':
        return row.scheduledTime;
      case 'visit':
        return row.visitTitle;
      case 'group':
        return row.group;
      case 'student':
        return row.studentName;
      case 'seat':
        return row.seatNumber;
      case 'status':
        return labels.status[row.status];
      case 'checkIn':
        return row.checkedInAt || '—';
      case 'minutesLate':
        return row.status === 'LATE' ? String(row.minutesLate) : '—';
      case 'source':
        return labels.source[row.source];
      case 'note':
        return row.note || '';
      case 'biometric':
        return row.biometricVerified ? labels.yes : labels.no;
    }
  };
  const cells = (texts: string[], header = false) =>
    h(
      View,
      { style: header ? [styles.row, styles.head] : styles.row, wrap: false, fixed: header },
      ...COLUMNS.map((c, i) =>
        h(Text, { key: c.key, style: [styles.cell, { width: `${c.width}%` }] }, texts[i]),
      ),
    );

  // Pages are cut here, a fixed number of rows each: react-pdf's automatic page
  // breaking re-lays out the whole flow and grows quadratically with the rows.
  // A page whose rows wrap onto extra lines still overflows safely onto another.
  const pages: AttendanceExportRow[][] = [];
  for (let start = 0; start < rows.length || pages.length === 0;) {
    const size = pages.length === 0 ? FIRST_PAGE_ROWS : ROWS_PER_PAGE;
    pages.push(rows.slice(start, start + size));
    start += size;
  }
  const header = cells(
    COLUMNS.map((c) => labels.columns[c.key]),
    true,
  );
  const footer = h(Text, {
    style: styles.footer,
    fixed: true,
    render: ({ pageNumber, totalPages }: { pageNumber: number; totalPages: number }) =>
      `${labels.page} ${pageNumber} / ${totalPages}`,
  });

  const doc = h(
    Document,
    { title: labels.title, author: 'FTMS', language: rtl ? 'ar' : 'en' },
    ...pages.map((pageRows, p) =>
      h(
        Page,
        { key: String(p), size: 'A4', orientation: 'landscape', style: styles.page },
        ...(p === 0
          ? [
              h(Text, { style: styles.title }, labels.title),
              h(Text, { style: styles.meta }, `${labels.generated}: ${params.generatedAt}`),
              h(Text, { style: styles.meta }, `${labels.filters}: ${params.filters}`),
              h(
                Text,
                { style: [styles.meta, { marginBottom: 8 }] },
                `${labels.rows}: ${rows.length}`,
              ),
            ]
          : []),
        header,
        ...pageRows.map((row, index) =>
          h(View, { key: String(index) }, cells(COLUMNS.map((c) => value(row, c.key)))),
        ),
        footer,
      ),
    ),
  );
  return renderToBuffer(doc);
}
