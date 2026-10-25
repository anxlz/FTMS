#!/usr/bin/env node
/**
 * Fails if the browser bundle of the web app (apps/web/.next/static, after
 * `next build`) contains anything server-only (§17: never expose secrets in
 * client bundles): the value of any secret environment variable set while it
 * was built, the names of server-only variables, or anything shaped like a key.
 *
 *   pnpm --filter @ftms/web build && pnpm scan:bundle
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const STATIC = join(ROOT, 'apps/web/.next/static');

/** Server-only settings: none may be named, let alone valued, in browser code. */
const SERVER_ONLY = [
  'BFF_SHARED_SECRET',
  'API_URL',
  'DATABASE_URL',
  'DIRECT_URL',
  'JWT_ACCESS_SECRET',
  'JWT_REFRESH_SECRET',
  'QR_HMAC_SECRET',
  'CRON_SECRET',
  'SUPABASE_SERVICE_ROLE_KEY',
  'UPSTASH_REDIS_REST_TOKEN',
  'SMTP_PASS',
];
const PATTERNS = [
  { name: 'private key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: 'JWT', re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/ },
  { name: 'Supabase secret key', re: /\bsb_secret_[A-Za-z0-9_-]{20,}/ },
  { name: 'database URL', re: /\bpostgres(?:ql)?:\/\/[^\s'"`]+@/ },
];

function files(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : [path];
  });
}

let all;
try {
  all = files(STATIC).filter((f) => /\.(js|css|json|txt|map)$/.test(f));
} catch {
  console.error(`No browser bundle at ${STATIC}: run \`pnpm --filter @ftms/web build\` first.`);
  process.exit(2);
}

const secrets = SERVER_ONLY.map((name) => [name, process.env[name]?.trim()]).filter(
  ([, value]) => value && value.length >= 8,
);
const findings = [];
for (const file of all) {
  const text = readFileSync(file, 'utf8');
  const rel = file.slice(ROOT.length);
  for (const name of SERVER_ONLY) {
    if (new RegExp(`\\b${name}\\b`).test(text)) findings.push(`${rel}: names ${name}`);
  }
  for (const [name, value] of secrets) {
    if (text.includes(value)) findings.push(`${rel}: contains the value of ${name}`);
  }
  for (const { name, re } of PATTERNS) {
    if (re.test(text)) findings.push(`${rel}: ${name}`);
  }
}

if (findings.length) {
  console.error(`Server-only data in the browser bundle:\n${findings.join('\n')}`);
  process.exit(1);
}
console.log(
  `Browser bundle clean: ${all.length} files, ${secrets.length} secret value(s) checked, ` +
    `${SERVER_ONLY.length} server-only names, ${PATTERNS.length} key patterns.`,
);
