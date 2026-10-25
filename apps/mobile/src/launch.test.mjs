import assert from 'node:assert/strict';
import { test } from 'node:test';
import { languageFor, MESSAGES, reachable, START_PATH, webUrlFrom } from './launch.js';

test('opens only a configured, non-placeholder web origin', () => {
  assert.equal(
    webUrlFrom({ webUrl: 'https://ftms.example.edu', placeholder: false }),
    'https://ftms.example.edu',
  );
  assert.equal(webUrlFrom({ webUrl: 'https://ftms.example.invalid', placeholder: true }), null);
  assert.equal(webUrlFrom({ webUrl: 'javascript:alert(1)' }), null);
  assert.equal(webUrlFrom(null), null);
  assert.equal(webUrlFrom({}), null);
});

test('opens the web app on its Log In / Continue as Guest screen', () => {
  assert.equal(START_PATH, '/start');
});

test('speaks Arabic unless the phone prefers English', () => {
  assert.equal(languageFor(['en-GB', 'ar']), 'en');
  assert.equal(languageFor(['ar-EG']), 'ar');
  assert.equal(languageFor([]), 'ar');
  assert.equal(languageFor('fr'), 'ar');
  assert.deepEqual(Object.keys(MESSAGES.ar).sort(), Object.keys(MESSAGES.en).sort());
});

test('treats any response as reachable, and a failure or timeout as not', async () => {
  const calls = [];
  assert.equal(
    await reachable('https://ftms.example.edu', async (url, init) => {
      calls.push([url, init.mode, init.credentials]);
      return {};
    }),
    true,
  );
  assert.deepEqual(calls, [['https://ftms.example.edu/login', 'no-cors', 'omit']]);
  assert.equal(
    await reachable('https://x', async () => Promise.reject(new TypeError('offline'))),
    false,
  );
  const hang = (_url, init) =>
    new Promise((_, reject) =>
      init.signal.addEventListener('abort', () => reject(new Error('abort'))),
    );
  assert.equal(await reachable('https://x', hang, 20), false);
});
