/**
 * Schedules automatic absence processing (§8.3) inside the database:
 * Supabase `pg_cron` runs every 5 minutes and, through `pg_net`, calls the
 * API's secured endpoint `POST /internal/attendance/process-absences`.
 *
 *   pnpm --filter @ftms/api cron:install -- --api-url=https://api.example.edu
 *   pnpm --filter @ftms/api cron:install -- --uninstall
 *
 * Needs DIRECT_URL (or DATABASE_URL) and CRON_SECRET. The secret is kept in
 * Supabase Vault and read by the job at run time, so it never appears in the
 * job's definition. The endpoint is idempotent, so overlapping or repeated runs
 * are harmless.
 */
import { PrismaPg } from '@prisma/adapter-pg';
import { EnvObjectSchema, formatIssues } from '../config/env';
import { loadEnvFiles } from '../config/load-env-files';
import { PrismaClient } from '../generated/prisma/client';

export const CRON_JOB_NAME = 'ftms-absences';
export const CRON_SCHEDULE = '*/5 * * * *';
export const VAULT_SECRET_NAME = 'ftms_cron_secret';
export const ENDPOINT_PATH = '/internal/attendance/process-absences';

/** The API base URL the database will call: https, or http only for local testing. */
export function parseApiUrl(value: string): string {
  const url = new URL(value);
  const local = ['localhost', '127.0.0.1'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) {
    throw new Error('--api-url must use https');
  }
  if (url.search || url.hash || /[$'\\]/.test(url.href))
    throw new Error('--api-url is not a plain URL');
  return url.origin + url.pathname.replace(/\/+$/, '');
}

/** The command pg_cron runs: one HTTP POST with the secret read from Vault. */
export function cronCommand(apiUrl: string): string {
  return [
    'select net.http_post(',
    `  url := '${apiUrl}${ENDPOINT_PATH}',`,
    "  headers := jsonb_build_object('content-type', 'application/json',",
    `    'x-ftms-cron-key', (select decrypted_secret from vault.decrypted_secrets where name = '${VAULT_SECRET_NAME}')),`,
    "  body := '{}'::jsonb,",
    '  timeout_milliseconds := 20000)',
  ].join('\n');
}

async function main(): Promise<number> {
  loadEnvFiles();
  const env = EnvObjectSchema.pick({ DATABASE_URL: true, DIRECT_URL: true, CRON_SECRET: true });
  const parsed = env.safeParse(process.env);
  if (!parsed.success) {
    process.stderr.write(`Cannot install:\n  ${formatIssues(parsed.error.issues).join('\n  ')}\n`);
    return 1;
  }
  const args = process.argv.slice(2);
  const uninstall = args.includes('--uninstall');
  const apiArg = args.find((a) => a.startsWith('--api-url='))?.slice('--api-url='.length);
  if (!uninstall && (!apiArg || !parsed.data.CRON_SECRET)) {
    process.stderr.write(
      'Usage: cron:install -- --api-url=https://<api host>  (CRON_SECRET must be set)\n',
    );
    return 1;
  }
  const prisma = new PrismaClient({
    adapter: new PrismaPg({
      connectionString: parsed.data.DIRECT_URL ?? parsed.data.DATABASE_URL,
    }),
  });
  try {
    const available = await prisma.$queryRaw<{ name: string }[]>`
      SELECT name FROM pg_available_extensions WHERE name IN ('pg_cron', 'pg_net')`;
    if (available.length < 2) {
      process.stderr.write(
        'pg_cron and pg_net are not available on this database (they are on Supabase:\n' +
          'Dashboard → Database → Extensions). Without them, run the endpoint from another scheduler.\n',
      );
      return 1;
    }
    await prisma.$executeRawUnsafe('CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA pg_catalog');
    await prisma.$executeRawUnsafe('CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions');
    await prisma.$executeRaw`
      SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname = ${CRON_JOB_NAME}`;
    if (uninstall) {
      process.stdout.write(`Removed the ${CRON_JOB_NAME} job.\n`);
      return 0;
    }

    const vault = await prisma.$queryRaw<{ ok: boolean }[]>`
      SELECT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'vault') AS ok`;
    if (!vault[0]?.ok) {
      process.stderr.write(
        'Supabase Vault is not available; refusing to store the secret in the job.\n',
      );
      return 1;
    }
    const existing = await prisma.$queryRaw<{ id: string }[]>`
      SELECT id::text FROM vault.secrets WHERE name = ${VAULT_SECRET_NAME}`;
    if (existing[0]) {
      await prisma.$executeRaw`SELECT vault.update_secret(${existing[0].id}::uuid, ${parsed.data.CRON_SECRET})`;
    } else {
      await prisma.$executeRaw`SELECT vault.create_secret(${parsed.data.CRON_SECRET}, ${VAULT_SECRET_NAME})`;
    }
    const apiUrl = parseApiUrl(apiArg!);
    await prisma.$executeRaw`SELECT cron.schedule(${CRON_JOB_NAME}, ${CRON_SCHEDULE}, ${cronCommand(apiUrl)})`;
    process.stdout.write(
      `Scheduled ${CRON_JOB_NAME} (${CRON_SCHEDULE}) → POST ${apiUrl}${ENDPOINT_PATH}\n` +
        'Check runs with: select * from cron.job_run_details order by start_time desc limit 5;\n',
    );
    return 0;
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main().then(
    (code) => process.exit(code),
    (error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(1);
    },
  );
}
