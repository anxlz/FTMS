/**
 * Creates (or re-applies settings to) the private Supabase Storage buckets defined
 * in `src/storage/buckets.ts`, then verifies the result.
 *
 *   pnpm storage:provision
 *
 * Needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY. Safe to run repeatedly.
 */
import { createClient } from '@supabase/supabase-js';
import { EnvObjectSchema, formatIssues } from '../config/env';
import { loadEnvFiles } from '../config/load-env-files';
import { ALL_BUCKETS } from '../storage/buckets';
import { provisionBuckets, verifyBuckets } from '../storage/provision';

const ScriptEnv = EnvObjectSchema.pick({
  SUPABASE_URL: true,
  SUPABASE_SERVICE_ROLE_KEY: true,
});

async function main(): Promise<number> {
  loadEnvFiles();
  const parsed = ScriptEnv.safeParse(process.env);
  if (!parsed.success) {
    process.stderr.write(
      `Cannot provision storage:\n  ${formatIssues(parsed.error.issues).join('\n  ')}\n`,
    );
    return 1;
  }
  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = parsed.data;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    process.stderr.write(
      'Cannot provision storage: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.\n',
    );
    return 1;
  }
  const storage = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  }).storage;

  const results = await provisionBuckets(storage, ALL_BUCKETS);
  for (const { id, action } of results) process.stdout.write(`  ${action.padEnd(7)} ${id}\n`);

  const { missing, public: exposed } = await verifyBuckets(storage, ALL_BUCKETS);
  if (missing.length > 0 || exposed.length > 0) {
    process.stderr.write(
      `Verification failed. missing=[${missing.join(',')}] public=[${exposed.join(',')}]\n`,
    );
    return 1;
  }
  process.stdout.write(`All ${ALL_BUCKETS.length} buckets exist and are private.\n`);
  return 0;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  },
);
