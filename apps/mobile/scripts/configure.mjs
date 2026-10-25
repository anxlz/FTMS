#!/usr/bin/env node
/**
 * Writes the build configuration of the Android app from `FTMS_WEB_URL`:
 *
 * - `src/config.json` — read by the launcher page and compiled into the Rust
 *   shell (its navigation allow-list);
 * - `src-tauri/capabilities/remote.json` — which pages may call native plugins.
 *
 * Both are generated (git-ignored). No secret is involved: the app holds no API
 * keys, database credentials or server secrets — it only opens the web app.
 *
 *   FTMS_WEB_URL=https://ftms.example.edu node scripts/configure.mjs
 *   node scripts/configure.mjs --placeholder   # compile checks and tests only;
 *                                              # keeps an existing configuration
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseWebUrl, PLACEHOLDER_URL, remoteCapability } from './web-url.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const placeholder = process.argv.includes('--placeholder');
if (
  placeholder &&
  existsSync(path.join(root, 'src/config.json')) &&
  existsSync(path.join(root, 'src-tauri/capabilities/remote.json'))
) {
  console.log('configure: keeping the existing configuration.');
  process.exit(0);
}
const parsed = parseWebUrl(placeholder ? PLACEHOLDER_URL : process.env.FTMS_WEB_URL);
if (!parsed.ok) {
  console.error(`configure: ${parsed.error}`);
  process.exit(1);
}

const write = (file, value) => {
  const target = path.join(root, file);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`);
  console.log(`configure: wrote ${file}`);
};

write('src/config.json', { webUrl: parsed.origin, placeholder });
write('src-tauri/capabilities/remote.json', remoteCapability(parsed.origin));
if (placeholder)
  console.log('configure: placeholder URL — for compile checks only, not for a build.');
