import { Logger } from '@nestjs/common';
import { type AppConfigService } from '../config/app-config.service';
import {
  cronCommand,
  ENDPOINT_PATH,
  parseApiUrl,
  VAULT_SECRET_NAME,
} from '../scripts/install-cron';
import { AttendanceTokens } from './attendance-tokens';
import { EXPORT_LABELS } from './export-labels';
import { neutralizeFormula } from './export.service';

const config = (values: Record<string, string | undefined>) =>
  ({ get: (key: string) => values[key] }) as unknown as AppConfigService;

const SECRET = 'unit-qr-secret-0123456789abcdef0123456789abcdef';
const VISIT = '01900000-0000-7000-8000-00000000abcd';

describe('AttendanceTokens (§7.2)', () => {
  const tokens = new AttendanceTokens(
    config({ QR_HMAC_SECRET: SECRET, WEB_APP_URL: 'https://ftms.example.edu/' }),
  );

  it('signs a visit id into a stable, URL-safe token that verifies back to it', () => {
    const token = tokens.sign(VISIT);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(tokens.sign(VISIT)).toBe(token);
    expect(tokens.verify(token)).toBe(VISIT);
    expect(tokens.checkInUrl(VISIT)).toBe(`https://ftms.example.edu/check-in/${token}`);
    expect(tokens.detailsUrl(VISIT)).toBe(`https://ftms.example.edu/visits/${VISIT}`);
  });

  it('rejects altered, truncated, padded and foreign tokens', () => {
    const token = tokens.sign(VISIT);
    const bytes = Buffer.from(token, 'base64url');
    const flipId = Buffer.from(bytes);
    flipId[0] = flipId[0]! ^ 1;
    const flipMac = Buffer.from(bytes);
    flipMac[31] = flipMac[31]! ^ 1;
    const foreign = new AttendanceTokens(
      config({ QR_HMAC_SECRET: 'another-secret-0123456789abcdef0123456789abcdef' }),
    ).sign(VISIT);
    for (const bad of [
      flipId.toString('base64url'),
      flipMac.toString('base64url'),
      token.slice(0, -1),
      `${token}A`,
      `${token}=`,
      foreign,
      '',
    ]) {
      expect(tokens.verify(bad)).toBeNull();
    }
  });

  it('derives a key from JWT_ACCESS_SECRET only when QR_HMAC_SECRET is unset', () => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const fallback = new AttendanceTokens(
      config({ JWT_ACCESS_SECRET: 'jwt-access-secret-0123456789abcdef0123456789' }),
    );
    const token = fallback.sign(VISIT);
    expect(fallback.verify(token)).toBe(VISIT);
    expect(tokens.verify(token)).toBeNull();
    expect(fallback.checkInUrl(VISIT)).toBe(`http://localhost:3000/check-in/${token}`);
  });

  it('renders both codes as SVG data URIs', async () => {
    const codes = await tokens.qrCodes(VISIT);
    for (const code of [codes.details, codes.attendance]) {
      const svg = Buffer.from(code.svg.replace('data:image/svg+xml;base64,', ''), 'base64');
      expect(svg.toString('utf8')).toMatch(/^<svg[\s\S]*<\/svg>\s*$/);
    }
  });
});

describe('export safety (§19)', () => {
  it.each([
    ['=SUM(A1:A2)', "'=SUM(A1:A2)"],
    ['+201000000000', "'+201000000000"],
    ['-5', "'-5"],
    ['@cmd', "'@cmd"],
    ['\tTab', "'\tTab"],
    ['محمد = أحمد', 'محمد = أحمد'],
    ['2026-101', '2026-101'],
  ])('neutralizes formula-like text: %j', (input, expected) => {
    expect(neutralizeFormula(input)).toBe(expected);
  });

  it('has a label for every status and source in both languages', () => {
    for (const labels of Object.values(EXPORT_LABELS)) {
      expect(Object.keys(labels.status).sort()).toEqual(['ABSENT', 'LATE', 'PRESENT']);
      expect(Object.keys(labels.source).sort()).toEqual([
        'AUTOMATIC',
        'GUEST',
        'GUEST_UNMATCHED',
        'MANUAL',
        'QR',
      ]);
    }
  });
});

describe('pg_cron installation (§8.3)', () => {
  it('accepts only plain https URLs (http only for localhost)', () => {
    expect(parseApiUrl('https://api.example.edu/')).toBe('https://api.example.edu');
    expect(parseApiUrl('https://example.edu/ftms-api//')).toBe('https://example.edu/ftms-api');
    expect(parseApiUrl('http://localhost:4000')).toBe('http://localhost:4000');
    for (const bad of [
      'http://api.example.edu',
      'ftp://api.example.edu',
      'https://api.example.edu/?x=1',
      "https://api.example.edu/a'b",
      'https://api.example.edu/$$',
      'not a url',
    ]) {
      expect(() => parseApiUrl(bad)).toThrow();
    }
  });

  it('builds a job that reads the secret from Vault instead of embedding it', () => {
    const sql = cronCommand('https://api.example.edu');
    expect(sql).toContain(`url := 'https://api.example.edu${ENDPOINT_PATH}'`);
    expect(sql).toContain(`vault.decrypted_secrets where name = '${VAULT_SECRET_NAME}'`);
    expect(sql).toContain("'x-ftms-cron-key'");
    expect(sql).not.toMatch(/test-cron-secret|CRON_SECRET/);
  });
});
