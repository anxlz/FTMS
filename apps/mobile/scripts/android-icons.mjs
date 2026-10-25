#!/usr/bin/env node
/**
 * Puts the official launcher icons (src-tauri/icons/android, copied from
 * assets/branding/generated/android/res) into the Android project that
 * `tauri android init` generates under src-tauri/gen/android.
 */
import { cpSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const from = path.join(root, 'src-tauri/icons/android');
const to = path.join(root, 'src-tauri/gen/android/app/src/main/res');
if (!existsSync(to)) {
  console.error(
    'android-icons: src-tauri/gen/android does not exist yet; run `pnpm android:init` first.',
  );
  process.exit(1);
}
cpSync(from, to, { recursive: true });
console.log('android-icons: launcher icons copied into the Android project.');
