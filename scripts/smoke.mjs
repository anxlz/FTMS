#!/usr/bin/env node
/**
 * Post-deployment smoke test (docs/deployment.md, step 9). Read-only: it signs
 * nobody in and changes nothing. Checks that the API and the web app answer,
 * that the API reaches its database, Redis and storage, and that the security
 * headers are in place.
 *
 *   node scripts/smoke.mjs --api https://ftms-api.example.app --web https://ftms.example.app
 *
 * Exits 1 if any check fails. `--allow-not-ready` accepts a 503 from
 * /health/ready (used for a local production run without real credentials).
 */
const args = Object.fromEntries(
  process.argv
    .slice(2)
    .join(' ')
    .split(/\s*--/)
    .filter(Boolean)
    .map((part) => {
      const [key, ...value] = part.split(/\s+/);
      return [key, value.join(' ') || true];
    }),
);
const api = typeof args.api === 'string' ? args.api.replace(/\/$/, '') : undefined;
const web = typeof args.web === 'string' ? args.web.replace(/\/$/, '') : undefined;
if (!api && !web) {
  console.error('Usage: node scripts/smoke.mjs --api <url> --web <url> [--allow-not-ready]');
  process.exit(2);
}

const results = [];
async function check(name, fn) {
  try {
    const note = await fn();
    results.push({ ok: true, name, note });
  } catch (error) {
    results.push({ ok: false, name, note: error instanceof Error ? error.message : String(error) });
  }
}
function expect(condition, message) {
  if (!condition) throw new Error(message);
}
const get = (url, init) => fetch(url, { redirect: 'manual', ...init });

if (api) {
  const https = api.startsWith('https://');
  await check('API liveness: GET /health → 200', async () => {
    const res = await get(`${api}/health`);
    expect(res.status === 200, `status ${res.status}`);
    const body = await res.json();
    return `version ${body.version ?? '?'}`;
  });
  await check('API readiness: GET /health/ready (database, Redis, storage, mail)', async () => {
    const res = await get(`${api}/health/ready`);
    const body = await res.json();
    const summary = Object.entries(body.checks ?? {})
      .map(([k, v]) => `${k}=${typeof v === 'object' && v ? v.status : v}`)
      .join(', ');
    expect(
      res.status === 200 || (res.status === 503 && args['allow-not-ready']),
      `status ${res.status}: ${summary}`,
    );
    expect(body.checks?.database?.status === 'up', `database not up: ${summary}`);
    return `${res.status}: ${summary}`;
  });
  await check('API security headers', async () => {
    const res = await get(`${api}/health`);
    const h = (k) => res.headers.get(k);
    expect(h('x-content-type-options') === 'nosniff', 'X-Content-Type-Options');
    expect(h('x-frame-options') === 'DENY', 'X-Frame-Options');
    expect(h('content-security-policy')?.includes("default-src 'none'"), 'CSP');
    expect(h('cache-control') === 'no-store', 'Cache-Control');
    expect(!h('x-powered-by'), 'X-Powered-By is exposed');
    if (https) expect(h('strict-transport-security')?.includes('max-age='), 'HSTS');
    return https ? 'with HSTS' : 'HSTS not expected over http';
  });
  await check('API refuses unauthenticated access: GET /auth/me → 401', async () => {
    const res = await get(`${api}/auth/me`);
    expect(res.status === 401, `status ${res.status}`);
    const body = await res.json();
    expect(body.code && body.message && !body.stack, 'error body shape');
  });
  await check('API answers no cross-origin browser calls', async () => {
    const res = await get(`${api}/auth/login`, {
      method: 'OPTIONS',
      headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' },
    });
    expect(!res.headers.get('access-control-allow-origin'), 'Access-Control-Allow-Origin set');
  });
  await check('API unknown route → 404 JSON', async () => {
    const res = await get(`${api}/no/such/route`);
    expect(res.status === 404, `status ${res.status}`);
  });
}

if (web) {
  const https = web.startsWith('https://');
  await check('Web sign-in page: GET /login → 200, Arabic RTL by default', async () => {
    const res = await get(`${web}/login`);
    expect(res.status === 200, `status ${res.status}`);
    const html = await res.text();
    expect(
      /<html[^>]*lang="ar"[^>]*dir="rtl"|<html[^>]*dir="rtl"[^>]*lang="ar"/.test(html),
      'lang/dir',
    );
    const csp = res.headers.get('content-security-policy') ?? '';
    expect(/script-src 'self' 'nonce-[^']+' 'strict-dynamic'/.test(csp), 'CSP with a nonce');
    expect(!csp.includes('unsafe-eval'), "CSP allows 'unsafe-eval' (development build?)");
    expect(res.headers.get('x-frame-options') === 'DENY', 'X-Frame-Options');
    if (https) expect(res.headers.get('strict-transport-security'), 'HSTS');
  });
  await check('Web protects signed-in pages: GET /dashboard → redirect to /login', async () => {
    const res = await get(`${web}/dashboard`);
    expect([302, 303, 307, 308].includes(res.status), `status ${res.status}`);
    expect(
      res.headers.get('location')?.includes('/login'),
      `location ${res.headers.get('location')}`,
    );
  });
  await check('Web icons and manifest', async () => {
    for (const path of ['/favicon.ico', '/icon.png', '/apple-icon.png', '/manifest.webmanifest']) {
      const res = await get(`${web}${path}`);
      expect(res.status === 200, `${path}: ${res.status}`);
    }
    const manifest = await (await get(`${web}/manifest.webmanifest`)).json();
    for (const icon of manifest.icons) {
      const res = await get(`${web}${icon.src}`);
      expect(res.status === 200, `${icon.src}: ${res.status}`);
    }
    return `${manifest.icons.length} manifest icons`;
  });
  await check('Web unknown page → 404 (translated page, not a crash)', async () => {
    const res = await get(`${web}/no-such-page`);
    expect(res.status === 404, `status ${res.status}`);
  });
}

let failed = 0;
for (const r of results) {
  if (!r.ok) failed += 1;
  console.log(`${r.ok ? '✓' : '✗'} ${r.name}${r.note ? ` — ${r.note}` : ''}`);
}
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
