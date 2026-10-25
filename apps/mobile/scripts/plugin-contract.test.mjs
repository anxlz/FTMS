/**
 * Keeps the three sides of the device-key plugin in step (Phase 8): the commands
 * the web app invokes (apps/web/lib/native.ts), the commands declared for
 * permissions (build.rs) and the Kotlin methods that implement them — Tauri
 * forwards `plugin:device-key|create_key` to the Kotlin method `createKey`.
 * The Kotlin code cannot be compiled here without the Android SDK, so this also
 * checks the security-relevant key settings textually.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(path.join(here, '..', p), 'utf8');
const native = read('../web/lib/native.ts');
const buildRs = read('plugins/tauri-plugin-device-key/build.rs');
const kotlin = read('plugins/tauri-plugin-device-key/android/src/main/java/DeviceKeyPlugin.kt');
const defaults = read('plugins/tauri-plugin-device-key/permissions/default.toml');

const camel = (s) => s.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
const invoked = [...native.matchAll(/'plugin:device-key\|([a-z_]+)'/g)].map((m) => m[1]);
const declared = [
  ...(/COMMANDS[^=]*=\s*&\[([^\]]*)\]/.exec(buildRs)?.[1] ?? '').matchAll(/"([a-z_]+)"/g),
].map((m) => m[1]);
const implemented = [...kotlin.matchAll(/@Command\s+fun (\w+)\(invoke: Invoke\)/g)].map(
  (m) => m[1],
);

test('every command the web app calls is declared and implemented natively', () => {
  assert.ok(invoked.length >= 5);
  assert.deepEqual([...new Set(invoked)].sort(), [...declared].sort());
  assert.deepEqual(declared.map(camel).sort(), [...implemented].sort());
  for (const command of declared) {
    assert.ok(defaults.includes(`"allow-${command.replace(/_/g, '-')}"`), command);
  }
});

test('the Keystore key needs a strong biometric check for every signature', () => {
  assert.match(kotlin, /setUserAuthenticationRequired\(true\)/);
  assert.match(kotlin, /setInvalidatedByBiometricEnrollment\(true\)/);
  assert.match(
    kotlin,
    /setUserAuthenticationParameters\(0, KeyProperties\.AUTH_BIOMETRIC_STRONG\)/,
  );
  assert.match(kotlin, /setAllowedAuthenticators\(BIOMETRIC_STRONG\)/);
  assert.match(kotlin, /BiometricPrompt\.CryptoObject\(signature\)/);
  assert.match(kotlin, /ECGenParameterSpec\("secp256r1"\)/);
  assert.match(kotlin, /SHA256withECDSA/);
  // Only the public key ever leaves the plugin.
  assert.doesNotMatch(kotlin, /private\.encoded|\.getPrivate\(\)\.encoded/);
});

test('every rejection code the plugin uses has a message in the web app', () => {
  const codes = [...kotlin.matchAll(/private const val \w+ = "([A-Z_]+)"/g)].map((m) => m[1]);
  const messages = JSON.parse(read('../web/messages/en.json')).errors;
  for (const code of codes) {
    if (code === 'BIOMETRIC_NOT_SET_UP' || code === 'INVALID_ARGUMENT') continue; // shown as BIOMETRIC_FAILED
    assert.equal(typeof messages[code], 'string', code);
  }
});
