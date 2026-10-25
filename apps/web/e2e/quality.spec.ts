import AxeBuilder from '@axe-core/playwright';
import { type Browser, expect, type Page, test } from '@playwright/test';
import { ADMIN_EMAIL, codeFor, resetAdminPassword, signIn } from './helpers';

/**
 * Phase 7 across the whole interface, for each role: accessibility (axe-core,
 * WCAG 2.1 A/AA), layout at phone, tablet and desktop widths in Arabic (RTL)
 * and English (LTR), no untranslated message keys, Western digits only, and
 * the security headers with no Content-Security-Policy violations.
 */

const API = 'http://localhost:4100';
const ADMIN_PASSWORD = 'harvest field lantern 59';
const STUDENT_PASSWORD = 'quiet meadow lantern 64';
const run = Date.now().toString(36).toUpperCase();
const STUDENT = {
  email: `p7.s.${run.toLowerCase()}@agr.asu.edu.eg`,
  seat: `P7S-${run}`,
  name: 'ريم أحمد فتحي سالم',
};

const STAFF_PAGES = [
  '/dashboard',
  '/students',
  '/groups',
  '/visits',
  '/calendar',
  '/attendance',
  '/tickets',
  '/group-swaps',
  '/schedule',
  '/reviews',
  '/audit',
  '/audit/activity',
  '/reports',
  '/admin/users',
  '/settings',
  '/notifications',
  '/profile',
];
const STUDENT_PAGES = [
  '/dashboard',
  '/calendar',
  '/attendance',
  '/notifications',
  '/tickets',
  '/profile',
];
const VIEWPORTS = [
  { name: 'phone', width: 375, height: 740 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 900 },
];

/** Message keys that leaked into the page instead of their translation. */
const RAW_KEY =
  /\b(?:common|nav|auth|audit|reports|tickets|groupSwaps|attendance|visits|errors|errorPage|dashboard|students|schedule|settings|notifications|calendar|profile|groups|reviews|imports|biometrics|checkIn|qr|roles|statuses|guest|scan|location|start)\.[a-zA-Z_]+(?:\.[a-zA-Z_]+)*\b/;

async function api<T>(
  path: string,
  init: { method?: string; token?: string; body?: unknown } = {},
) {
  const res = await fetch(`${API}${path}`, {
    method: init.method ?? 'GET',
    headers: {
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...(init.token ? { authorization: `Bearer ${init.token}` } : {}),
    },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
  if (!res.ok) throw new Error(`${path} → ${res.status} ${await res.text()}`);
  return (res.status === 204 ? undefined : await res.json()) as T;
}

/** Records CSP violations reported by the browser on a page. */
function watchCsp(page: Page): string[] {
  const violations: string[] = [];
  page.on('console', (message) => {
    if (/Content Security Policy|Refused to (load|execute|apply)/i.test(message.text())) {
      violations.push(message.text());
    }
  });
  return violations;
}

async function checkPage(page: Page, path: string, locale: 'ar' | 'en') {
  const response = await page.goto(path);
  expect(response?.status(), path).toBeLessThan(400);
  await expect(page.locator('html')).toHaveAttribute('lang', locale);
  await expect(page.locator('html')).toHaveAttribute('dir', locale === 'ar' ? 'rtl' : 'ltr');
  const headers = response!.headers();
  expect(headers['content-security-policy'], path).toMatch(/script-src 'self' 'nonce-[^']+'/);
  expect(headers['x-frame-options'], path).toBe('DENY');
  const text = await page.locator('body').innerText();
  expect(text.match(RAW_KEY)?.[0] ?? null, `${path}: raw message key`).toBeNull();
  expect(text.match(/[٠-٩]/)?.[0] ?? null, `${path}: Arabic-Indic digit`).toBeNull();
}

/** No part of the page is wider than the window (tables scroll inside their frame). */
async function checkWidths(page: Page, path: string) {
  for (const viewport of VIEWPORTS) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.goto(path);
    const { overflow, culprits } = await page.evaluate(() => {
      const width = window.innerWidth;
      // The outermost elements that stick out of the window (for the failure message).
      const culprits = [...document.body.querySelectorAll('*')]
        .filter((el) => {
          const r = el.getBoundingClientRect();
          const parent = el.parentElement?.getBoundingClientRect();
          const out = (b: DOMRect) => b.right > width + 1 || b.left < -1;
          return r.width > 0 && out(r) && !(parent && out(parent));
        })
        .slice(0, 3)
        .map((el) => `${el.tagName.toLowerCase()}.${[...el.classList].join('.')}`);
      return { overflow: document.documentElement.scrollWidth - width, culprits };
    });
    expect(
      overflow,
      `${path} at ${viewport.name} width: ${culprits.join(', ')}`,
    ).toBeLessThanOrEqual(1);
  }
  await page.setViewportSize({ width: 1280, height: 900 });
}

async function axe(page: Page, path: string) {
  await page.goto(path);
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  const serious = results.violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .map(
      (v) =>
        `${v.id} (${v.impact}): ${v.nodes
          .map((n) => n.target.join(' '))
          .slice(0, 3)
          .join(' | ')}`,
    );
  expect(serious, `${path}: accessibility violations`).toEqual([]);
  // Lesser findings are recorded on the test (shown by the JSON/HTML reporters).
  const minor = results.violations.filter((v) => !['serious', 'critical'].includes(v.impact ?? ''));
  test.info().annotations.push({
    type: 'axe',
    description: `${path}: ${results.passes.length} rules passed${
      minor.length ? `; minor: ${minor.map((v) => `${v.id} (${v.impact})`).join(', ')}` : ''
    }`,
  });
}

async function switchTo(page: Page, locale: 'ar' | 'en') {
  if ((await page.locator('html').getAttribute('lang')) === locale) return;
  await page
    .getByRole('button', { name: locale === 'ar' ? /العربية/ : /English/ })
    .first()
    .click();
  await expect(page.locator('html')).toHaveAttribute('lang', locale);
}

async function newPage(browser: Browser): Promise<{ page: Page; csp: string[] }> {
  const page = await (await browser.newContext()).newPage();
  return { page, csp: watchCsp(page) };
}

test.describe.serial('accessibility, layout, languages and security headers (Phase 7)', () => {
  // Each test visits every page of a role several times (axe, three widths).
  test.describe.configure({ timeout: 240_000 });
  let admin: Page;
  let adminCsp: string[];
  let student: Page;
  let studentCsp: string[];

  test.beforeAll(async ({ browser }) => {
    ({ page: admin, csp: adminCsp } = await newPage(browser));
    await signIn(admin, ADMIN_EMAIL, resetAdminPassword(), ADMIN_PASSWORD);
    const { accessToken } = await api<{ accessToken: string }>('/auth/login', {
      method: 'POST',
      body: { identifier: ADMIN_EMAIL, password: ADMIN_PASSWORD },
    });
    await api('/admin/users', {
      method: 'POST',
      token: accessToken,
      body: {
        role: 'STUDENT',
        email: STUDENT.email,
        fullName: STUDENT.name,
        seatNumber: STUDENT.seat,
      },
    });
    await api('/auth/code/request', { method: 'POST', body: { email: STUDENT.email } });
    const first = await api<{ accessToken: string }>('/auth/code/verify', {
      method: 'POST',
      body: { email: STUDENT.email, code: await codeFor(STUDENT.email) },
    });
    await api('/auth/password/change', {
      method: 'POST',
      token: first.accessToken,
      body: { newPassword: STUDENT_PASSWORD },
    });
    ({ page: student, csp: studentCsp } = await newPage(browser));
    await signIn(student, STUDENT.seat, STUDENT_PASSWORD);
  });

  test('signed-out pages: both languages, accessible, no overflow', async ({ browser }) => {
    const { page, csp } = await newPage(browser);
    for (const locale of ['ar', 'en'] as const) {
      await page.goto('/login');
      await switchTo(page, locale);
      for (const path of [
        '/login',
        '/signup',
        '/forgot-password',
        '/start',
        '/guest',
        '/check-in/NotARealToken0000000000',
        '/check-in/NotARealToken0000000000/guest',
        '/no-such-page',
      ]) {
        const response = await page.goto(path);
        if (path === '/no-such-page') expect(response?.status()).toBe(404);
        await expect(page.locator('html')).toHaveAttribute('dir', locale === 'ar' ? 'rtl' : 'ltr');
        expect((await page.locator('body').innerText()).match(RAW_KEY)?.[0] ?? null).toBeNull();
        await axe(page, path);
        await checkWidths(page, path);
      }
    }
    // The not-found page is translated, not the framework's default.
    await page.goto('/no-such-page');
    await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible();
    expect(csp).toEqual([]);
  });

  test('every staff page in Arabic: right to left, accessible, fits a phone', async () => {
    await admin.goto('/dashboard');
    await switchTo(admin, 'ar');
    for (const path of STAFF_PAGES) {
      await checkPage(admin, path, 'ar');
      await axe(admin, path);
      await checkWidths(admin, path);
    }
    expect(adminCsp).toEqual([]);
  });

  test('every staff page in English: left to right, accessible', async () => {
    await switchTo(admin, 'en');
    for (const path of STAFF_PAGES) {
      await checkPage(admin, path, 'en');
      await axe(admin, path);
    }
    expect(adminCsp).toEqual([]);
  });

  test('every student page in both languages, at every width', async () => {
    for (const locale of ['ar', 'en'] as const) {
      await student.goto('/dashboard');
      await switchTo(student, locale);
      for (const path of STUDENT_PAGES) {
        await checkPage(student, path, locale);
        await axe(student, path);
        await checkWidths(student, path);
      }
    }
    expect(studentCsp).toEqual([]);
  });

  test('a language change keeps the page and its filters', async () => {
    await admin.goto('/audit?category=VISITS&scope=all');
    await switchTo(admin, 'ar');
    await expect(admin).toHaveURL(/\/audit\?category=VISITS&scope=all$/);
    await expect(admin.locator('select[name="category"]')).toHaveValue('VISITS');
    await switchTo(admin, 'en');
    await expect(admin.locator('select[name="category"]')).toHaveValue('VISITS');
  });

  test('icons and the web app manifest are served at their declared sizes', async ({ request }) => {
    const favicon = await request.get('/favicon.ico');
    expect(favicon.status()).toBe(200);
    expect(favicon.headers()['content-type']).toMatch(/icon/);
    for (const path of ['/icon.png', '/apple-icon.png']) {
      const res = await request.get(path);
      expect([path, res.status(), res.headers()['content-type']]).toEqual([path, 200, 'image/png']);
    }
    const manifest = await request.get('/manifest.webmanifest');
    expect(manifest.status()).toBe(200);
    const body = (await manifest.json()) as {
      icons: { src: string; sizes: string; purpose?: string }[];
      lang?: string;
      dir?: string;
    };
    expect(body.icons.length).toBeGreaterThanOrEqual(3);
    for (const icon of body.icons) {
      const res = await request.get(icon.src);
      expect([icon.src, res.status()]).toEqual([icon.src, 200]);
      const png = await res.body();
      // PNG IHDR: width and height at bytes 16–23.
      const size = `${png.readUInt32BE(16)}x${png.readUInt32BE(20)}`;
      expect([icon.src, size]).toEqual([icon.src, icon.sizes]);
    }
    expect(body.icons.some((i) => i.purpose === 'maskable')).toBe(true);
  });
});
