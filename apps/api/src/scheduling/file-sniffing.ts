/**
 * Identifies an uploaded file from its content (§16.3), never from the name or
 * the type the browser claims. Returns the media type and the extension used
 * for the stored object, or null when the content is not an accepted format.
 */
export interface SniffedType {
  contentType: string;
  extension: string;
}

const startsWith = (buf: Buffer, bytes: number[], offset = 0): boolean =>
  buf.length >= offset + bytes.length && bytes.every((b, i) => buf[offset + i] === b);

const ascii = (text: string): number[] => [...text].map((c) => c.charCodeAt(0));

/** Office Open XML packages are ZIP files whose part names reveal the kind. */
const OOXML: { marker: string; type: SniffedType }[] = [
  {
    marker: 'word/document.xml',
    type: {
      contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      extension: 'docx',
    },
  },
  {
    marker: 'xl/workbook.xml',
    type: {
      contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      extension: 'xlsx',
    },
  },
  {
    marker: 'ppt/presentation.xml',
    type: {
      contentType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      extension: 'pptx',
    },
  },
];

export function sniffFileType(buf: Buffer): SniffedType | null {
  if (startsWith(buf, [0xff, 0xd8, 0xff])) return { contentType: 'image/jpeg', extension: 'jpg' };
  if (startsWith(buf, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return { contentType: 'image/png', extension: 'png' };
  }
  if (startsWith(buf, ascii('RIFF')) && startsWith(buf, ascii('WEBP'), 8)) {
    return { contentType: 'image/webp', extension: 'webp' };
  }
  if (startsWith(buf, ascii('%PDF-'))) return { contentType: 'application/pdf', extension: 'pdf' };
  if (startsWith(buf, [0x50, 0x4b, 0x03, 0x04])) {
    const names = buf.toString('latin1');
    return OOXML.find((o) => names.includes(o.marker))?.type ?? null;
  }
  return null;
}

/** A display name safe to store and show: no path, no control characters, bounded. */
export function cleanFileName(original: string | undefined, fallback: string): string {
  const base = (original ?? '').split(/[\\/]/).pop() ?? '';
  const name = base
    .normalize('NFC')
    .replace(/[\p{Cc}\p{Cf}]/gu, '')
    .trim()
    .slice(0, 200);
  return name || fallback;
}
