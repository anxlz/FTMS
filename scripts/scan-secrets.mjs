#!/usr/bin/env node
/**
 * Fails if a committed file looks like it contains a real secret (§17: never
 * expose secrets in committed config). Scans every file git tracks (or the
 * paths given as arguments) for high-confidence patterns. Test fixtures use
 * values that say they are fake (e.g. `e2e-access-secret-…`) and local test
 * databases on localhost; those are not secrets. A deliberate fake in a test
 * is marked with `scan-secrets: allow` on its line or the line above.
 *
 *   pnpm scan:secrets              # files in the working tree
 *   pnpm scan:secrets --history    # every change ever committed (git log -p)
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';

const PATTERNS = [
  { name: 'private key', re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/ },
  // Supabase anon/service keys and any other signed JWT.
  { name: 'JWT', re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/ },
  { name: 'Supabase secret key', re: /\bsb_secret_[A-Za-z0-9_-]{20,}/ },
  {
    name: 'GitHub token',
    re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}|\bgithub_pat_[A-Za-z0-9_]{40,}/,
  },
  { name: 'AWS access key', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'Slack token', re: /\bxox[abpr]-[A-Za-z0-9-]{10,}/ },
  { name: 'Google API key', re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  // A connection string with a password, other than local or documentation hosts.
  {
    name: 'database password',
    re: /\bpostgres(?:ql)?:\/\/[^:\s/@]+:([^@\s]+)@([^\s/:?'"`]+)/,
    allow: (m) =>
      /^(?:\[?PASSWORD\]?|<[^>]+>|\$\{?\w+\}?|\*+|…|\.\.\.)$/i.test(m[1]) ||
      /^(?:localhost|127\.0\.0\.1|\[::1\]|db|postgres|[\w.-]*\bexample\b[\w.-]*)$/i.test(m[2]),
  },
  // A secret-named setting given a value in a committed env file.
  {
    name: 'secret in an env file',
    re: /^(?:[A-Z0-9_]*(?:SECRET|PASSWORD|PASS|TOKEN|SERVICE_ROLE_KEY|ANON_KEY)[A-Z0-9_]*)=(\S+)/m,
    files: /(^|\/)\.env(\.[\w.-]+)?$/,
  },
];

const BINARY = /\.(png|ico|jpg|jpeg|gif|webp|pdf|xlsx|zip|woff2?|ttf|otf)$/i;
const SKIP = /(^|\/)(pnpm-lock\.yaml|node_modules\/)/;

const findings = [];

if (process.argv[2] === '--history') {
  // Added lines of every commit: a secret removed later is still in the history.
  const log = execFileSync('git', ['log', '-p', '--all', '--no-color', '--unified=0'], {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 1024,
  });
  let file = '';
  let commit = '';
  for (const line of log.split('\n')) {
    if (line.startsWith('commit ')) commit = line.slice(7, 19);
    else if (line.startsWith('+++ b/')) file = line.slice(6);
    else if (line.startsWith('+') && !line.startsWith('+++')) {
      if (BINARY.test(file) || SKIP.test(file)) continue;
      for (const pattern of PATTERNS) {
        if (pattern.files && !pattern.files.test(file)) continue;
        const m = pattern.re.exec(line.slice(1));
        if (m && !pattern.allow?.(m) && !/scan-secrets: allow/.test(line)) {
          findings.push(`${commit} ${file}  ${pattern.name}`);
        }
      }
    }
  }
  report(`the history (${log.split('\ncommit ').length} commits)`);
}

const files =
  process.argv.length > 2
    ? process.argv.slice(2)
    : execFileSync('git', ['ls-files'], { encoding: 'utf8' }).split('\n').filter(Boolean);

for (const file of files) {
  if (BINARY.test(file) || SKIP.test(file)) continue;
  let text;
  try {
    if (statSync(file).size > 2_000_000) continue;
    text = readFileSync(file, 'utf8');
  } catch {
    continue;
  }
  for (const pattern of PATTERNS) {
    if (pattern.files && !pattern.files.test(file)) continue;
    const global = new RegExp(pattern.re.source, `${pattern.re.flags.replace('g', '')}g`);
    for (const m of text.matchAll(global)) {
      if (pattern.allow?.(m)) continue;
      const line = text.slice(0, m.index).split('\n').length;
      const lines = text.split('\n');
      if (/scan-secrets: allow/.test(`${lines[line - 2] ?? ''}${lines[line - 1] ?? ''}`)) continue;
      findings.push(`${file}:${line}  ${pattern.name}`);
    }
  }
}

report(`${files.length} files`);

function report(scope) {
  if (findings.length > 0) {
    console.error(`Possible secrets in committed files:\n${findings.join('\n')}`);
    process.exit(1);
  }
  console.log(`No secrets found in ${scope}.`);
  process.exit(0);
}
