/**
 * Prints the text of a PDF (read from stdin) as JSON: one array of lines per
 * page, each line the text runs at one height, in reading order for the page
 * direction. Run as a child process so the e2e tests (CommonJS under ts-jest)
 * can use pdf.js, which is an ES module.
 *
 *   node pdf-text.mjs [rtl] < file.pdf
 */
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

const rtl = process.argv[2] === 'rtl';
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const pdf = await getDocument({
  data: new Uint8Array(Buffer.concat(chunks)),
  useSystemFonts: false,
  isEvalSupported: false,
  verbosity: 0,
}).promise;

const pages = [];
for (let n = 1; n <= pdf.numPages; n += 1) {
  const page = await pdf.getPage(n);
  const { items } = await page.getTextContent();
  /** @type {Map<number, { x: number; text: string }[]>} */
  const lines = new Map();
  for (const item of items) {
    if (!('str' in item) || item.str.trim() === '') continue;
    const y = Math.round(item.transform[5]);
    const key = [...lines.keys()].find((k) => Math.abs(k - y) <= 2) ?? y;
    lines.set(key, [...(lines.get(key) ?? []), { x: item.transform[4], text: item.str }]);
  }
  pages.push(
    [...lines.entries()]
      .sort(([a], [b]) => b - a)
      .map(([, runs]) =>
        runs
          .sort((a, b) => (rtl ? b.x - a.x : a.x - b.x))
          .map((r) => r.text.normalize('NFKC').trim())
          .filter(Boolean),
      ),
  );
}
process.stdout.write(JSON.stringify(pages));
