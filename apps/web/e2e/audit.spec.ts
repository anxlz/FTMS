import { readFileSync } from 'node:fs';
import { expect, type Page, test } from '@playwright/test';
import { ADMIN_EMAIL, codeFor, resetAdminPassword, signIn } from './helpers';

/**
 * Phase 6 in a real browser: a faculty member works through the API; the
 * Super Admin (who holds `audit.read`, like the Training Director) finds each
 * operation in the activity log, opens it with its before/after comparison,
 * sees the faculty activity summary, the reports and the dashboard card, and
 * exports the log. The faculty member, without `audit.read`, is refused.
 */

const API = 'http://localhost:4100';
const ADMIN_PASSWORD = 'harvest field lantern 59';
const FACULTY_PASSWORD = 'quiet orchard river 42';
const run = Date.now().toString(36).toUpperCase();
const FACULTY = { email: `p6.f.${run.toLowerCase()}@agr.asu.edu.eg`, name: `Dr. Audit ${run}` };
const GROUP = `P6 Group ${run}`;
const RENAMED = `P6 Group ${run} renamed`;
const VISIT = `P6 visit ${run}`;

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
  if (!res.ok)
    throw new Error(`${init.method ?? 'GET'} ${path} → ${res.status} ${await res.text()}`);
  return (res.status === 204 ? undefined : await res.json()) as T;
}

const tomorrowPlus = (days: number) => {
  const d = new Date(Date.now() + days * 86_400_000);
  return d.toISOString().slice(0, 10);
};

test.describe.serial('audit log and reports (Phase 6)', () => {
  let admin: Page;
  let groupId = '';

  test.beforeAll(async ({ browser }) => {
    const oneTime = resetAdminPassword();
    admin = await (await browser.newContext()).newPage();
    admin.on('dialog', (dialog) => void dialog.accept());
    await signIn(admin, ADMIN_EMAIL, oneTime, ADMIN_PASSWORD);
    const { accessToken: adminToken } = await api<{ accessToken: string }>('/auth/login', {
      method: 'POST',
      body: { identifier: ADMIN_EMAIL, password: ADMIN_PASSWORD },
    });

    // A faculty member: invited by the admin, first sign-in by emailed code, then a password.
    await api('/admin/users', {
      method: 'POST',
      token: adminToken,
      body: { role: 'FACULTY', email: FACULTY.email, fullName: FACULTY.name },
    });
    await api('/auth/code/request', { method: 'POST', body: { email: FACULTY.email } });
    const first = await api<{ accessToken: string }>('/auth/code/verify', {
      method: 'POST',
      body: { email: FACULTY.email, code: await codeFor(FACULTY.email) },
    });
    await api('/auth/password/change', {
      method: 'POST',
      token: first.accessToken,
      body: { newPassword: FACULTY_PASSWORD },
    });
    const { accessToken: f } = await api<{ accessToken: string }>('/auth/login', {
      method: 'POST',
      body: { identifier: FACULTY.email, password: FACULTY_PASSWORD },
    });

    // Their operations.
    groupId = (
      await api<{ id: string }>('/groups', { method: 'POST', token: f, body: { name: GROUP } })
    ).id;
    await api(`/groups/${groupId}`, { method: 'PATCH', token: f, body: { name: RENAMED } });
    const program = await api<{ program: unknown }>('/program', { token: f });
    if (program.program) {
      const visit = await api<{ visit: { id: string } }>('/visits', {
        method: 'POST',
        token: f,
        body: { title: VISIT, date: tomorrowPlus(10), startTime: '10:00', groupIds: [groupId] },
      });
      await api(`/visits/${visit.visit.id}/cancel`, {
        method: 'POST',
        token: f,
        body: { reason: 'Bus unavailable' },
      });
    }
  });

  test('the log lists each faculty operation with who did it and when', async () => {
    await admin.goto('/audit');
    await expect(admin.getByRole('heading', { name: 'Activity log' })).toBeVisible();
    await admin
      .locator('select[name="actor"]')
      .selectOption({ label: `${FACULTY.name} — Faculty member` });
    await admin.locator('select[name="category"]').selectOption('GROUPS');
    await admin.getByRole('button', { name: 'Filter' }).click();
    const rows = admin.locator('.audit-table tbody tr');
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0)).toContainText('Group edited');
    await expect(rows.nth(0)).toContainText(FACULTY.name);
    await expect(rows.nth(0)).toContainText('Faculty member');
    await expect(rows.nth(1)).toContainText('Group created');
    await expect(admin.getByText('2 events')).toBeVisible();
  });

  test('an event shows the before/after comparison and the record as it is now', async () => {
    await admin.locator('.audit-table tbody tr').first().getByRole('link').click();
    await expect(admin.getByRole('heading', { name: 'Group edited' })).toBeVisible();
    const changes = admin.locator('.changes-table');
    const name = changes.locator('tr.changed', { hasText: 'Name' });
    await expect(name.locator('del')).toHaveText(GROUP);
    await expect(name.locator('ins')).toHaveText(RENAMED);
    await expect(admin.getByRole('link', { name: RENAMED })).toHaveAttribute(
      'href',
      `/groups/${groupId}`,
    );
    await expect(admin.getByText('Name and role as they were at the time.')).toBeVisible();
    // Other events about the same group.
    await expect(
      admin.locator('section', { hasText: 'Other events for this record' }),
    ).toContainText('Group created');
  });

  test('faculty activity summarizes each staff member', async () => {
    await admin.goto('/audit/activity');
    const row = admin.locator('tbody tr', { hasText: FACULTY.name });
    await expect(row).toContainText('Groups 2');
    await expect(row).toContainText('Sign-in and account security');
    await row.getByRole('link', { name: 'Groups 2' }).click();
    await expect(admin.locator('.audit-table tbody tr')).toHaveCount(2);
  });

  test('the log exports as CSV, and the export is itself recorded', async () => {
    await admin.goto('/audit?scope=staff&category=GROUPS');
    await admin.locator('#dl-audit-format').selectOption('csv');
    await admin.locator('#dl-audit-locale').selectOption('en');
    const [download] = await Promise.all([
      admin.waitForEvent('download'),
      admin.getByRole('button', { name: 'Download' }).click(),
    ]);
    expect(download.suggestedFilename()).toMatch(/^ftms-audit-\d{12}\.csv$/);
    const text = readFileSync(await download.path(), 'utf8');
    expect(text).toContain('group.updated');
    expect(text).toContain(FACULTY.name);
    await admin.goto('/audit?category=EXPORTS');
    await expect(admin.locator('.audit-table tbody tr').first()).toContainText(
      'Activity log exported',
    );
  });

  test('reports and the dashboard show training-wide figures', async () => {
    await admin.goto('/reports');
    await expect(admin.getByRole('heading', { name: 'Training-wide reports' })).toBeVisible();
    await expect(admin.getByRole('heading', { name: 'Student attendance standing' })).toBeVisible();
    const [pdf] = await Promise.all([
      admin.waitForEvent('download'),
      admin
        .locator('section', { hasText: 'Faculty activity report' })
        .getByRole('button', { name: 'Download' })
        .click(),
    ]);
    expect(pdf.suggestedFilename()).toMatch(/^ftms-faculty-activity-\d{12}\.xlsx$/);
    await admin.goto('/dashboard');
    await expect(
      admin.getByRole('heading', { name: /Staff activity \(last 7 days\)/ }),
    ).toBeVisible();
    await expect(admin.getByRole('heading', { name: 'Latest staff actions' })).toBeVisible();
  });

  test('a faculty member without audit permission cannot open the log', async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await signIn(page, FACULTY.email, FACULTY_PASSWORD);
    await expect(
      page.getByRole('navigation').getByRole('link', { name: 'Faculty activity logs' }),
    ).toHaveCount(0);
    expect((await page.goto('/audit'))?.status()).toBe(404);
    expect((await page.goto('/audit/activity'))?.status()).toBe(404);
    await context.close();
  });
});
