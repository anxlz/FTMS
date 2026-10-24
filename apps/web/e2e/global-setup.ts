import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const here = path.dirname(fileURLToPath(import.meta.url));
const apiDir = path.join(here, '..', '..', 'api');
const stateDir = path.join(here, '..', '.e2e');

const TABLES = [
  'attendance_records',
  'webauthn_challenges',
  'webauthn_credentials',
  'notifications',
  'visit_files',
  'visit_groups',
  'training_visits',
  'schedule_exceptions',
  'schedule_groups',
  'training_schedules',
  'training_programs',
  'auth_challenges',
  'auth_sessions',
  'user_permission_grants',
  'profile_change_requests',
  'student_verification_requests',
  'student_imports',
  'group_memberships',
  'training_groups',
  'student_profiles',
  'faculty_profiles',
  'users',
  'audit_logs',
].join(', ');

/**
 * Prepares a clean, known database: wipes account data (disposable test
 * databases only) and runs the real Super Admin seed script, keeping the
 * one-time password it prints. Requires the API to be built (`apps/api/dist`).
 */
export default async function globalSetup(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl)
    throw new Error('Browser e2e tests need DATABASE_URL (a disposable test database).');
  if (/supabase\.(co|com)/.test(databaseUrl))
    throw new Error('Refusing to wipe a Supabase database from tests.');
  mkdirSync(stateDir, { recursive: true });

  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query('BEGIN');
    // The audit log is append-only by trigger; replica mode (superuser only) suspends triggers.
    await client.query('SET LOCAL session_replication_role = replica');
    await client.query(`TRUNCATE ${TABLES} RESTART IDENTITY CASCADE`);
    await client.query('COMMIT');
  } finally {
    await client.end();
  }

  const output = execFileSync('node', ['dist/scripts/seed-super-admin.js', '--reset-password'], {
    cwd: apiDir,
    env: { ...process.env, DATABASE_URL: databaseUrl },
    encoding: 'utf8',
  });
  const password = /^One-time password: (\S+)$/m.exec(output)?.[1];
  if (!password) throw new Error(`Seed script did not print a password:\n${output}`);
  writeFileSync(path.join(stateDir, 'super-admin.json'), JSON.stringify({ password }), {
    mode: 0o600,
  });
}
