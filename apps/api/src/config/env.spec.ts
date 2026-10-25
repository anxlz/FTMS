import { InvalidEnvironmentError, parseEnv, PRODUCTION_REQUIRED } from './env';

// scan-secrets: allow (fake credentials for the configuration parser)
const DB = 'postgresql://user:p%40ss@db.example.supabase.co:6543/postgres?pgbouncer=true';

/** The minimum every environment needs: a database and the two token secrets. */
const BASE = {
  DATABASE_URL: DB,
  JWT_ACCESS_SECRET: 'a'.repeat(48),
  JWT_REFRESH_SECRET: 'b'.repeat(48),
};

const fullProduction = {
  NODE_ENV: 'production',
  ...BASE,
  SUPABASE_URL: 'https://abcd.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'service-role-key-0123456789',
  UPSTASH_REDIS_REST_URL: 'https://eu1-example.upstash.io',
  UPSTASH_REDIS_REST_TOKEN: 'upstash-token-0123456789',
  SMTP_PASS: 'abcd efgh ijkl mnop',
  QR_HMAC_SECRET: 'c'.repeat(48),
  BFF_SHARED_SECRET: 'd'.repeat(48),
  CRON_SECRET: 'e'.repeat(48),
  WEB_APP_URL: 'https://ftms.example.edu.eg',
};

function problemsOf(raw: Record<string, unknown>): string[] {
  try {
    parseEnv(raw);
  } catch (error) {
    if (error instanceof InvalidEnvironmentError) return error.problems;
    throw error;
  }
  return [];
}

describe('parseEnv', () => {
  it('applies documented defaults in development', () => {
    const env = parseEnv(BASE);
    expect(env.NODE_ENV).toBe('development');
    expect(env.PORT).toBe(4000);
    expect(env.APP_TIMEZONE).toBe('Africa/Cairo');
    expect(env.SMTP_HOST).toBe('smtp.gmail.com');
    expect(env.SMTP_PORT).toBe(465);
    expect(env.SMTP_USER).toBe('ST22425244@agr.asu.edu.eg');
  });

  it('treats blank `KEY=` placeholders as unset', () => {
    const env = parseEnv({ ...BASE, SMTP_PASS: '', SUPABASE_URL: '  ', SMTP_PORT: '' });
    expect(env.SMTP_PASS).toBeUndefined();
    expect(env.SUPABASE_URL).toBeUndefined();
    expect(env.SMTP_PORT).toBe(465);
  });

  it('requires DATABASE_URL and both JWT secrets in every environment', () => {
    expect(problemsOf({})).toEqual([
      'DATABASE_URL is required',
      'JWT_ACCESS_SECRET is required',
      'JWT_REFRESH_SECRET is required',
    ]);
    expect(problemsOf({ ...BASE, DATABASE_URL: '' })).toEqual(['DATABASE_URL is required']);
    expect(problemsOf({ ...BASE, NODE_ENV: 'test', JWT_ACCESS_SECRET: '' })).toEqual([
      'JWT_ACCESS_SECRET is required',
    ]);
  });

  it('rejects a non-Postgres DATABASE_URL', () => {
    expect(problemsOf({ ...BASE, DATABASE_URL: 'mysql://u:p@host/db' })).toEqual([
      expect.stringContaining('DATABASE_URL must be a postgres://'),
    ]);
  });

  it('rejects an invalid time zone', () => {
    expect(problemsOf({ ...BASE, APP_TIMEZONE: 'Mars/Olympus' })).toEqual([
      'APP_TIMEZONE must be a valid IANA time zone',
    ]);
  });

  it('accepts a complete production configuration', () => {
    expect(problemsOf(fullProduction)).toEqual([]);
  });

  it.each(PRODUCTION_REQUIRED)('requires %s in production', (key) => {
    const raw: Record<string, unknown> = { ...fullProduction };
    delete raw[key];
    expect(problemsOf(raw)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(
          new RegExp(`^${key} (is required in production|must be set together)`),
        ),
      ]),
    );
  });

  it('allows service credentials to be absent outside production', () => {
    expect(problemsOf({ NODE_ENV: 'development', ...BASE })).toEqual([]);
    expect(problemsOf({ NODE_ENV: 'test', ...BASE })).toEqual([]);
  });

  it('requires paired variables together', () => {
    expect(problemsOf({ ...BASE, SUPABASE_URL: 'https://abcd.supabase.co' })).toEqual([
      'SUPABASE_SERVICE_ROLE_KEY must be set together with SUPABASE_URL',
    ]);
    expect(problemsOf({ ...BASE, UPSTASH_REDIS_REST_TOKEN: 'upstash-token-0123456789' })).toEqual([
      'UPSTASH_REDIS_REST_URL must be set together with UPSTASH_REDIS_REST_TOKEN',
    ]);
  });

  it('rejects short signing secrets', () => {
    expect(problemsOf({ ...BASE, QR_HMAC_SECRET: 'too-short' })).toEqual([
      'QR_HMAC_SECRET must be at least 32 characters',
    ]);
  });

  it('rejects identical access and refresh secrets in any environment', () => {
    const same = { ...fullProduction, JWT_REFRESH_SECRET: fullProduction.JWT_ACCESS_SECRET };
    expect(problemsOf(same)).toEqual(['JWT_REFRESH_SECRET must differ from JWT_ACCESS_SECRET']);
    expect(problemsOf({ ...BASE, JWT_REFRESH_SECRET: BASE.JWT_ACCESS_SECRET })).toEqual([
      'JWT_REFRESH_SECRET must differ from JWT_ACCESS_SECRET',
    ]);
  });

  it('only accepts an https Upstash REST URL', () => {
    expect(
      problemsOf({
        ...BASE,
        UPSTASH_REDIS_REST_URL: 'http://insecure.upstash.io',
        UPSTASH_REDIS_REST_TOKEN: 'upstash-token-0123456789',
      }),
    ).toEqual([expect.stringMatching(/^UPSTASH_REDIS_REST_URL /)]);
  });

  it('parses the university email domains (default agr.asu.edu.eg)', () => {
    expect(parseEnv(BASE).UNIVERSITY_EMAIL_DOMAINS).toEqual(['agr.asu.edu.eg']);
    expect(
      parseEnv({ ...BASE, UNIVERSITY_EMAIL_DOMAINS: ' AGR.asu.edu.eg, std.asu.edu.eg ,' })
        .UNIVERSITY_EMAIL_DOMAINS,
    ).toEqual(['agr.asu.edu.eg', 'std.asu.edu.eg']);
    expect(problemsOf({ ...BASE, UNIVERSITY_EMAIL_DOMAINS: '@gmail' }).join(' ')).toContain(
      'UNIVERSITY_EMAIL_DOMAINS',
    );
  });

  it('never echoes secret values in error messages', () => {
    const secret = 'sk_live_SUPER_SECRET_VALUE';
    let message = '';
    try {
      parseEnv({ ...BASE, DATABASE_URL: `notaurl-${secret}`, QR_HMAC_SECRET: secret });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('DATABASE_URL');
    expect(message).toContain('QR_HMAC_SECRET');
    expect(message).not.toContain(secret);
  });
});
