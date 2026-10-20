import { assertSafeObjectPath, InvalidObjectPathError } from './object-path';

describe('assertSafeObjectPath', () => {
  it.each(['visits/2026/cover.webp', 'imports/abc-123_v2.xlsx', 'a'])('accepts %s', (path) => {
    expect(assertSafeObjectPath(path)).toBe(path);
  });

  it.each([
    '',
    '../secrets.txt',
    'visits/../../etc/passwd',
    '/absolute/path.png',
    'trailing/',
    'double//slash.png',
    'visits/.hidden',
    'spaces in name.png',
    'visits/..',
    `${'a'.repeat(129)}.png`,
  ])('rejects %j', (path) => {
    expect(() => assertSafeObjectPath(path)).toThrow(InvalidObjectPathError);
  });
});
