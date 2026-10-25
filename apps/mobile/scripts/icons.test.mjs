import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const official = path.join(root, '../../assets/branding/generated/android/res');
const copy = path.join(root, 'src-tauri/icons/android');

const files = (dir) =>
  readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => path.relative(dir, path.join(e.parentPath, e.name)))
    .sort();

test('the app ships the official launcher icons, unchanged', () => {
  const names = files(official);
  assert.ok(names.length >= 15);
  assert.deepEqual(files(copy), names);
  for (const name of names) {
    assert.ok(
      readFileSync(path.join(copy, name)).equals(readFileSync(path.join(official, name))),
      name,
    );
  }
});
