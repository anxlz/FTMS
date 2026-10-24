/**
 * Runs before each e2e test file is loaded (and therefore before the config
 * module validates the environment). Makes the run hermetic: only the database
 * is real; Redis, Storage and SMTP are deliberately unconfigured so their
 * readiness status is deterministic.
 */
for (const key of [
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
  'SUPABASE_ANON_KEY',
  'UPSTASH_REDIS_REST_URL',
  'UPSTASH_REDIS_REST_TOKEN',
  'SMTP_PASS',
]) {
  delete process.env[key];
}

process.env.NODE_ENV = 'test';

// Fixed, clearly fake secrets (the same values the unit tests use).
process.env.JWT_ACCESS_SECRET = 'test-access-secret-0123456789abcdef0123456789';
process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-0123456789abcdef012345678';
process.env.BFF_SHARED_SECRET = 'test-bff-shared-secret-0123456789abcdef012345';
process.env.QR_HMAC_SECRET = 'test-qr-hmac-secret-0123456789abcdef0123456789';
process.env.CRON_SECRET = 'test-cron-secret-0123456789abcdef0123456789ab';

if (!process.env.DATABASE_URL) {
  throw new Error(
    'E2E tests need a real Postgres: set DATABASE_URL (and apply migrations with `pnpm db:deploy`).',
  );
}
