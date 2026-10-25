import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseWebUrl, PLACEHOLDER_URL, remoteCapability } from './web-url.mjs';

test('accepts an https origin, normalized', () => {
  assert.deepEqual(parseWebUrl(' https://FTMS.example.edu/ '), {
    ok: true,
    origin: 'https://ftms.example.edu',
    dev: false,
  });
  assert.equal(parseWebUrl('https://ftms.example.edu:8443').ok, true);
});

test('accepts plain http only for local development hosts', () => {
  assert.equal(parseWebUrl('http://10.0.2.2:3000').ok, true);
  assert.equal(parseWebUrl('http://localhost:3000').ok, true);
  assert.equal(parseWebUrl('http://ftms.example.edu').ok, false);
});

test('refuses missing values, paths, queries, credentials and other schemes', () => {
  for (const bad of [
    undefined,
    '',
    'ftms.example.edu',
    'https://ftms.example.edu/dashboard',
    'https://ftms.example.edu/?x=1',
    'https://user:pass@ftms.example.edu',
    'javascript:alert(1)',
    'file:///etc/passwd',
  ]) {
    assert.equal(parseWebUrl(bad).ok, false, String(bad));
  }
});

test('the placeholder parses but is clearly not a real host', () => {
  const parsed = parseWebUrl(PLACEHOLDER_URL);
  assert.equal(parsed.ok, true);
  assert.match(PLACEHOLDER_URL, /\.invalid$/);
});

test('remote pages get only the scanner, location and device-key permissions', () => {
  const capability = remoteCapability('https://ftms.example.edu');
  assert.deepEqual(capability.remote, { urls: ['https://ftms.example.edu/*'] });
  assert.deepEqual(capability.windows, ['main']);
  for (const permission of capability.permissions) {
    assert.match(permission, /^(barcode-scanner|geolocation|device-key):/);
  }
  assert.ok(!capability.permissions.some((p) => p.startsWith('core:')));
  assert.ok(!capability.permissions.includes('geolocation:allow-watch-position'));
});
