import { Document, Page, renderToBuffer, StyleSheet, Text, View } from '@react-pdf/renderer';
import { createElement as h } from 'react';
import { registerFonts } from '../attendance/export-pdf';

/**
 * A printable table report (landscape A4) in IBM Plex Sans Arabic, right to
 * left for Arabic. Pages are cut at a fixed number of rows: react-pdf's
 * automatic page breaking grows quadratically with the rows (see Phase 4).
 */
export async function renderTablePdf(params: {
  title: string;
  /** Lines under the title (generated at, filters, counts). */
  meta: string[];
  columns: { label: string; width: number }[];
  rows: string[][];
  rtl: boolean;
  pageLabel: string;
  rowsPerPage?: number;
  firstPageRows?: number;
}): Promise<Buffer> {
  registerFonts();
  const { columns, rows, rtl } = params;
  const rowsPerPage = params.rowsPerPage ?? 24;
  const firstPageRows = params.firstPageRows ?? rowsPerPage - 5;
  const align = rtl ? 'right' : 'left';
  const styles = StyleSheet.create({
    page: { fontFamily: 'Plex Arabic', fontSize: 8, padding: 24, paddingBottom: 36 },
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
  const cells = (texts: string[], header = false) =>
    h(
      View,
      { style: header ? [styles.row, styles.head] : styles.row, wrap: false },
      ...columns.map((c, i) =>
        h(Text, { key: String(i), style: [styles.cell, { width: `${c.width}%` }] }, texts[i] ?? ''),
      ),
    );
  const pages: string[][][] = [];
  for (let start = 0; start < rows.length || pages.length === 0;) {
    const size = pages.length === 0 ? firstPageRows : rowsPerPage;
    pages.push(rows.slice(start, start + size));
    start += size;
  }
  const header = cells(
    columns.map((c) => c.label),
    true,
  );
  const footer = h(Text, {
    style: styles.footer,
    fixed: true,
    render: ({ pageNumber, totalPages }: { pageNumber: number; totalPages: number }) =>
      `${params.pageLabel} ${pageNumber} / ${totalPages}`,
  });
  const doc = h(
    Document,
    { title: params.title, author: 'FTMS', language: rtl ? 'ar' : 'en' },
    ...pages.map((pageRows, p) =>
      h(
        Page,
        { key: String(p), size: 'A4', orientation: 'landscape', style: styles.page },
        ...(p === 0
          ? [
              h(Text, { style: styles.title }, params.title),
              ...params.meta.map((line, i) =>
                h(
                  Text,
                  {
                    key: `m${i}`,
                    style:
                      i === params.meta.length - 1
                        ? [styles.meta, { marginBottom: 8 }]
                        : styles.meta,
                  },
                  line,
                ),
              ),
            ]
          : []),
        header,
        ...pageRows.map((row, index) => h(View, { key: String(index) }, cells(row))),
        footer,
      ),
    ),
  );
  return renderToBuffer(doc);
}
