import { FileStore } from '../storage/file-store';
import { type StorageService } from '../storage/storage.service';
import { testConfig } from '../testing/test-config';
import { cleanFileName, sniffFileType } from './file-sniffing';
import { planOccurrences } from './occurrences';

describe('planOccurrences (§6.1)', () => {
  const occurrence = (
    id: string,
    occurrenceDate: string,
    flags: Partial<{ detached: boolean; locked: boolean }> = {},
  ) => ({
    id,
    occurrenceDate,
    detached: flags.detached ?? false,
    locked: flags.locked ?? false,
  });

  it('keeps matching sessions, removes stale ones and creates missing dates', () => {
    const plan = planOccurrences(
      ['2026-11-01', '2026-11-04', '2026-11-06'],
      [occurrence('a', '2026-11-01'), occurrence('b', '2026-11-03')],
    );
    expect(plan).toEqual({ create: ['2026-11-04', '2026-11-06'], keep: ['a'], remove: ['b'] });
  });

  it('never touches sessions changed on their own or already started', () => {
    const plan = planOccurrences(
      ['2026-11-01'],
      [
        occurrence('moved', '2026-11-03', { detached: true }),
        occurrence('started', '2026-10-28', { locked: true }),
        occurrence('kept-detached', '2026-11-01', { detached: true }),
      ],
    );
    // A date that already has a session — even an individually changed one — gets no second one.
    expect(plan).toEqual({ create: [], keep: [], remove: [] });
  });
});

describe('sniffFileType (§16.3)', () => {
  const zipWith = (part: string) =>
    Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from(`....${part}....`)]);

  it('recognizes accepted formats by their content', () => {
    expect(sniffFileType(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]))?.contentType).toBe(
      'image/jpeg',
    );
    expect(
      sniffFileType(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]))?.extension,
    ).toBe('png');
    expect(sniffFileType(Buffer.from('RIFF\0\0\0\0WEBPVP8 '))?.contentType).toBe('image/webp');
    expect(sniffFileType(Buffer.from('%PDF-1.7\n'))?.contentType).toBe('application/pdf');
    expect(sniffFileType(zipWith('word/document.xml'))?.extension).toBe('docx');
    expect(sniffFileType(zipWith('xl/workbook.xml'))?.extension).toBe('xlsx');
    expect(sniffFileType(zipWith('ppt/presentation.xml'))?.extension).toBe('pptx');
  });

  it('refuses everything else, whatever it is called', () => {
    expect(sniffFileType(Buffer.from('<svg onload="alert(1)"/>'))).toBeNull();
    expect(sniffFileType(Buffer.from('MZ\x90\0'))).toBeNull();
    expect(sniffFileType(zipWith('random/file.txt'))).toBeNull();
    expect(sniffFileType(Buffer.alloc(0))).toBeNull();
  });

  it('cleans display names without losing Arabic', () => {
    expect(cleanFileName('C:\\Users\\x\\خطة الزيارة.pdf', 'file.pdf')).toBe('خطة الزيارة.pdf');
    expect(cleanFileName('../../etc/passwd', 'file')).toBe('passwd');
    expect(cleanFileName('a\u0000b\u202Ec.pdf', 'file')).toBe('abc.pdf');
    expect(cleanFileName('   ', 'file.png')).toBe('file.png');
  });
});

describe('FileStore local links', () => {
  const storage = { isConfigured: false } as StorageService;

  it('issues signed, expiring links that cannot be altered', async () => {
    const store = new FileStore(storage, testConfig());
    expect(store.driver).toBe('local');
    const path = `visits/test/${Date.now()}.pdf`;
    await store.put('visit-documents', path, Buffer.from('%PDF-1.4'), 'application/pdf');
    const link = await store.link('visit-documents', path, 'application/pdf', 'خطة.pdf');
    expect(link).toMatch(/^\/files\//);
    const token = link.slice('/files/'.length);

    const file = await store.readLocal(token);
    expect(file).toMatchObject({ contentType: 'application/pdf', download: 'خطة.pdf' });
    expect(file?.body.toString()).toBe('%PDF-1.4');

    // Another payload with the same signature, or the same payload after expiry, is refused.
    const [payload, signature] = token.split('.');
    const forged = Buffer.from(
      JSON.stringify({ ...JSON.parse(Buffer.from(payload!, 'base64url').toString()), p: 'x.pdf' }),
    ).toString('base64url');
    expect(await store.readLocal(`${forged}.${signature}`)).toBeNull();
    expect(await store.readLocal(token, Date.now() + 11 * 60_000)).toBeNull();
    await store.remove('visit-documents', [path]);
    expect(await store.readLocal(token)).toBeNull();
  });

  it('is never used in production', () => {
    const store = new FileStore(storage, {
      ...testConfig(),
      isProduction: true,
      get: testConfig().get,
    } as ReturnType<typeof testConfig>);
    expect(store.driver).toBeNull();
  });
});
