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

if (!process.env.DATABASE_URL) {
  throw new Error(
    'E2E tests need a real Postgres: set DATABASE_URL (and apply migrations with `pnpm db:deploy`).',
  );
}
