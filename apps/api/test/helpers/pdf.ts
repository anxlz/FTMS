import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

/**
 * The text drawn on each page of a PDF, line by line (runs at the same height,
 * in reading order for the page direction), extracted with pdf.js in a child
 * process (see pdf-text.mjs).
 */
export function pdfLines(pdf: Buffer, rtl: boolean): string[][][] {
  const out = execFileSync(
    process.execPath,
    [join(__dirname, 'pdf-text.mjs'), rtl ? 'rtl' : 'ltr'],
    {
      input: pdf,
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  return JSON.parse(out.toString('utf8')) as string[][][];
}
