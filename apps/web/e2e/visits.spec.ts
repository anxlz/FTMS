import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { addDays, PROGRAM_TIME_ZONE, todayIn } from '@ftms/core';
import { type Browser, expect, type Page, test } from '@playwright/test';
import pg from 'pg';
import { ADMIN_EMAIL, chooseEnglish, codeFor, input, resetAdminPassword, signIn } from './helpers';

const ADMIN_PASSWORD = 'harvest field lantern 58';
const STUDENT_PASSWORD = 'citrus orchard evening 26';
const run = Date.now().toString(36).toUpperCase();
const GROUPS = { a: `P3 Group A ${run}`, b: `P3 Group B ${run}`, c: `P3 Group C ${run}` };
const STUDENT_A = { seat: `P3A-${run}`, email: `p3.a.${run.toLowerCase()}@agr.asu.edu.eg` };
const STUDENT_C = { seat: `P3C-${run}`, email: `p3.c.${run.toLowerCase()}@agr.asu.edu.eg` };
const today = todayIn(PROGRAM_TIME_ZONE);
const VISIT_DATE = addDays(today, 7);
const VISIT_TITLE = `Greenhouse visit ${run}`;
/** Arabic labels of the sign-in page, from the catalog the app uses. */
const ar = JSON.parse(readFileSync(new URL('../messages/ar.json', import.meta.url), 'utf8')) as {
  auth: { login: { tabCode: string }; code: { send: string; verify: string } };
};
const AR = {
  tabCode: ar.auth.login.tabCode,
  send: ar.auth.code.send,
  verify: ar.auth.code.verify,
};

/** A UUID v7 (time-ordered), like the ids the API creates. */
function uuidv7(): string {
  const hex = Date.now().toString(16).padStart(12, '0') + randomBytes(10).toString('hex');
  const variant = ((parseInt(hex[15]!, 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7${hex.slice(13, 16)}-${variant}${hex.slice(16, 19)}-${hex.slice(19, 31)}`;
}

/** Groups A, B and C, with one imported (not yet signed-in) student in A and one in C. */
async function seed(): Promise<void> {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    const ids = { a: uuidv7(), b: uuidv7(), c: uuidv7() };
    for (const key of ['a', 'b', 'c'] as const) {
      await client.query(
        'INSERT INTO training_groups (id, name, updated_at) VALUES ($1, $2, now())',
        [ids[key], GROUPS[key]],
      );
    }
    for (const [student, group, name] of [
      [STUDENT_A, ids.a, 'منى علي حسن محمود'],
      [STUDENT_C, ids.c, 'خالد سمير فؤاد عمر'],
    ] as const) {
      const id = uuidv7();
      await client.query(
        `INSERT INTO student_profiles (id, seat_number, full_name, university_email, updated_at)
         VALUES ($1, $2, $3, $4, now())`,
        [id, student.seat, name, student.email],
      );
      await client.query(
        `INSERT INTO group_memberships (id, student_id, group_id, source) VALUES ($1, $2, $3, 'IMPORT')`,
        [uuidv7(), id, group],
      );
    }
  } finally {
    await client.end();
  }
}

async function newPage(browser: Browser): Promise<Page> {
  const context = await browser.newContext();
  const page = await context.newPage();
  page.on('dialog', (dialog) => void dialog.accept());
  return page;
}

/** First sign-in of an imported student by emailed code (§4.3); `english` picks the language. */
async function firstSignIn(page: Page, email: string, english: boolean) {
  await page.goto('/login');
  if (english) await chooseEnglish(page);
  await page.getByRole('tab', { name: english ? 'Email code' : AR.tabCode }).click();
  await input(page, 'email').fill(email);
  await page.getByRole('button', { name: english ? 'Send code' : AR.send }).click();
  await input(page, 'code').fill(await codeFor(email));
  await page.getByRole('button', { name: english ? 'Verify and sign in' : AR.verify }).click();
  await expect(page).toHaveURL(/\/set-password$/);
  await input(page, 'newPassword').fill(STUDENT_PASSWORD);
  await input(page, 'confirmPassword').fill(STUDENT_PASSWORD);
  await page.locator('main form button[type="submit"]').first().click();
  await expect(page).toHaveURL(/\/dashboard$/);
}

test.describe.serial('scheduling and calendars in the browser (Phase 3)', () => {
  let admin: Page;
  let studentA: Page;
  let studentC: Page;
  let visitUrl: string;

  test.beforeAll(async ({ browser }) => {
    await seed();
    const oneTime = resetAdminPassword();
    admin = await newPage(browser);
    await signIn(admin, ADMIN_EMAIL, oneTime, ADMIN_PASSWORD);
    studentA = await newPage(browser);
    await firstSignIn(studentA, STUDENT_A.email, true);
    studentC = await newPage(browser);
    await firstSignIn(studentC, STUDENT_C.email, false); // Arabic, right-to-left
  });

  test('the Training Director configures the program; every value is editable', async () => {
    await admin.goto('/schedule');
    await expect(admin.getByRole('heading', { name: 'Training program' })).toBeVisible();
    // Suggested values are only a starting point.
    await expect(input(admin, 'durationWeeks')).toHaveValue('12');
    await expect(input(admin, 'allowedAbsences')).toHaveValue('2');
    await input(admin, 'name').fill('Field training 2026/2027');
    await input(admin, 'startDate').fill(addDays(today, -7));
    await input(admin, 'durationWeeks').fill('20');
    await input(admin, 'allowedAbsences').fill('3');
    await admin.getByRole('button', { name: 'Save the program' }).click();
    await expect(admin.locator('dd', { hasText: 'Field training 2026/2027' })).toBeVisible();
    await expect(admin.locator('dd', { hasText: '(20 weeks)' })).toBeVisible();
    // The configuration is recorded in the settings history (§11.3).
    await expect(admin.getByRole('heading', { name: 'Settings history' })).toBeVisible();
    await expect(admin.getByText('Program configured')).toBeVisible();
  });

  test('a visit for groups A and B reaches group A’s student — never group C (DoD)', async () => {
    await admin.goto('/visits/new');
    await input(admin, 'title').fill(VISIT_TITLE);
    await admin.locator('textarea[name="description"]').fill('Bring boots and a notebook.');
    await input(admin, 'date').fill(VISIT_DATE);
    await input(admin, 'startTime').fill('10:00');
    await input(admin, 'endTime').fill('12:00');
    // Searchable multi-select (§6.2).
    await admin.getByPlaceholder('Search groups').fill(run);
    await admin.getByRole('checkbox', { name: GROUPS.a }).check();
    await admin.getByRole('checkbox', { name: GROUPS.b }).check();
    await expect(admin.getByText('2 groups selected')).toBeVisible();
    await input(admin, 'locationName').fill('Faculty greenhouse 3');
    await input(admin, 'mapUrl').fill('https://maps.google.com/?q=30.11,31.24');
    await admin.getByRole('button', { name: 'Create visit' }).click();

    await expect(admin).toHaveURL(/\/visits\/[0-9a-f-]+\?notice=created/);
    // §6.4 (5): confirmation that the visit was added, and who was told.
    await expect(admin.getByRole('status')).toHaveText(
      'Visit added to the calendar. 1 student was notified.',
    );
    visitUrl = new URL(admin.url()).pathname;

    // Group A: notified, with a link to the details; the visit is in the calendar.
    await studentA.goto('/dashboard');
    await expect(studentA.getByRole('link', { name: 'Notifications, 1 unread' })).toBeVisible();
    await studentA.goto('/notifications');
    await expect(studentA.getByText(`New visit: ${VISIT_TITLE}`)).toBeVisible();
    await expect(studentA.getByText('10:00–12:00. Place: Faculty greenhouse 3.')).toBeVisible();
    await studentA.getByRole('button', { name: 'Open' }).click();
    await expect(studentA).toHaveURL(new RegExp(`${visitUrl}$`));
    await expect(studentA.getByRole('heading', { level: 1 })).toHaveText(VISIT_TITLE);
    await expect(studentA.getByText('Bring boots and a notebook.')).toBeVisible();
    await expect(studentA.getByRole('link', { name: 'Open the map' })).toBeVisible();
    await expect(studentA.locator('a.bell')).toHaveAttribute('aria-label', 'Notifications');
    await studentA.goto(`/calendar?month=${VISIT_DATE.slice(0, 7)}`);
    await expect(studentA.getByText(`Visits of your group: ${GROUPS.a}`)).toBeVisible();
    await expect(studentA.locator('.agenda').getByText(VISIT_TITLE)).toBeVisible();

    // Group C: nothing — no notification, no calendar entry, no access (Arabic, RTL).
    await studentC.goto('/notifications');
    await expect(studentC.locator('html')).toHaveAttribute('dir', 'rtl');
    await expect(studentC.getByText('لا توجد إشعارات بعد.')).toBeVisible();
    await studentC.goto(`/calendar?month=${VISIT_DATE.slice(0, 7)}`);
    await expect(studentC.getByRole('heading', { name: 'تقويم التدريب' })).toBeVisible();
    await expect(studentC.getByText('لا توجد زيارات في هذا الشهر.')).toBeVisible();
    await expect(studentC.getByText(VISIT_TITLE)).toHaveCount(0);
    const response = await studentC.goto(visitUrl);
    expect(response?.status()).toBe(404);
  });

  test('documents are kept privately and open for the visit’s students through signed links', async () => {
    await admin.goto(visitUrl);
    await admin.locator('summary', { hasText: 'Add a file' }).click();
    await admin.locator('input[name="file"]').setInputFiles({
      name: 'خطة الزيارة.pdf',
      mimeType: 'application/pdf',
      buffer: Buffer.from('%PDF-1.4\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n'),
    });
    await admin.getByRole('button', { name: 'Upload' }).click();
    await expect(admin.getByRole('link', { name: 'خطة الزيارة.pdf' })).toBeVisible();

    await studentA.goto(visitUrl);
    const link = studentA.getByRole('link', { name: 'خطة الزيارة.pdf' });
    const href = await link.getAttribute('href');
    expect(href).toMatch(/^\/files\//);
    const file = await studentA.request.get(href!);
    expect(file.status()).toBe(200);
    expect(file.headers()['content-type']).toBe('application/pdf');
    expect((await file.body()).subarray(0, 5).toString()).toBe('%PDF-');
    // A tampered link opens nothing.
    expect((await studentA.request.get(`${href!.slice(0, -4)}0000`)).status()).toBe(404);
  });

  test('a cancelled visit stays visible with its reason, and its students are told', async () => {
    await admin.goto(visitUrl);
    await input(admin, 'reason').fill('Greenhouse under maintenance');
    await admin.getByRole('button', { name: 'Cancel visit' }).click();
    await expect(admin.getByText('Visit cancelled. 1 student was notified.')).toBeVisible();

    await studentA.goto(`/calendar?month=${VISIT_DATE.slice(0, 7)}`);
    const entry = studentA.locator('.agenda li', { hasText: VISIT_TITLE });
    await expect(entry.getByText('Cancelled', { exact: true })).toBeVisible();
    await expect(entry.getByText('Cancelled — reason: Greenhouse under maintenance')).toBeVisible();
    await studentA.goto('/notifications');
    await expect(studentA.getByText(`Visit cancelled: ${VISIT_TITLE}`)).toBeVisible();
  });

  test('a weekly schedule fills the calendar of its group; a day off cancels that day', async () => {
    await admin.goto('/schedule');
    await admin.locator('summary', { hasText: 'New weekly schedule' }).click();
    await input(admin, 'title').fill(`Weekly practice ${run}`);
    await admin.getByRole('checkbox', { name: 'Sunday' }).check();
    await admin.getByRole('checkbox', { name: 'Wednesday' }).check();
    await input(admin, 'startTime').fill('09:00');
    await input(admin, 'startsOn').fill(addDays(today, 1));
    await input(admin, 'endsOn').fill(addDays(today, 14));
    await admin.getByRole('checkbox', { name: GROUPS.a }).check();
    await admin.getByRole('button', { name: 'Create schedule' }).click();
    await expect(admin.getByText('4 sessions were added to the calendar.')).toBeVisible();

    await studentA.goto('/notifications');
    await expect(studentA.getByText(`New weekly schedule: Weekly practice ${run}`)).toBeVisible();
    await expect(studentA.getByText(/^Every Sunday and Wednesday, 09:00/)).toBeVisible();

    // A day off on the first session day, for every schedule.
    const firstDay = Array.from({ length: 7 }, (_, i) => addDays(today, 1 + i)).find((d) =>
      [0, 3].includes(new Date(`${d}T12:00:00Z`).getUTCDay()),
    )!;
    await admin.goto('/schedule');
    await admin.locator('summary', { hasText: 'Add a day off' }).click();
    const dayOff = admin.locator('form').filter({ hasText: 'Applies to' });
    await dayOff.locator('input[name="date"]').fill(firstDay);
    await dayOff.locator('input[name="reason"]').fill('National holiday');
    await dayOff.getByRole('button', { name: 'Add a day off' }).click();
    await expect(
      admin.getByText('Day off added. 1 session was cancelled; 1 student was notified.'),
    ).toBeVisible();

    await studentA.goto(`/calendar?month=${firstDay.slice(0, 7)}`);
    const dayEntry = studentA.locator('.agenda li', { hasText: `Weekly practice ${run}` }).first();
    await expect(dayEntry.getByText('Cancelled — reason: National holiday')).toBeVisible();
    await studentC.goto(`/calendar?month=${firstDay.slice(0, 7)}`);
    await expect(studentC.getByText(`Weekly practice ${run}`)).toHaveCount(0);
  });
});
