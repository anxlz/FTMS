import { randomBytes } from 'node:crypto';
import { expect, type Page, test } from '@playwright/test';
import pg from 'pg';
import { ADMIN_EMAIL, chooseEnglish, codeFor, input, resetAdminPassword, signIn } from './helpers';

/**
 * Phase 5 in a real browser: a student files a complaint with a file, the
 * staff answer it (with an internal note the student never sees) and resolve
 * it; then the student asks another student to swap groups, the other student
 * accepts, the faculty approve, and both students move. Students never see
 * which staff member answered or decided; the audit history does.
 */

const ADMIN_PASSWORD = 'harvest field lantern 59';
const PASSWORD = 'olive grove morning 31';
const run = Date.now().toString(36).toUpperCase();
const GROUP_A = `P5 Group A ${run}`;
const GROUP_B = `P5 Group B ${run}`;
const REQUESTER = {
  seat: `P5R-${run}`,
  name: 'سلمى عادل فؤاد',
  email: `p5.r.${run.toLowerCase()}@agr.asu.edu.eg`,
};
const COUNTERPART = {
  seat: `P5C-${run}`,
  name: 'كريم نبيل حسن',
  email: `p5.c.${run.toLowerCase()}@agr.asu.edu.eg`,
};
const SUBJECT = `Bus did not arrive ${run}`;

function uuidv7(): string {
  const hex = Date.now().toString(16).padStart(12, '0') + randomBytes(10).toString('hex');
  const variant = ((parseInt(hex[15]!, 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7${hex.slice(13, 16)}-${variant}${hex.slice(16, 19)}-${hex.slice(19, 31)}`;
}

/** Two groups with one student each; returns the Super Admin's display name. */
async function seed(): Promise<string> {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    for (const [group, student] of [
      [GROUP_A, REQUESTER],
      [GROUP_B, COUNTERPART],
    ] as const) {
      const groupId = uuidv7();
      await client.query(
        'INSERT INTO training_groups (id, name, updated_at) VALUES ($1, $2, now())',
        [groupId, group],
      );
      const id = uuidv7();
      await client.query(
        `INSERT INTO student_profiles (id, seat_number, full_name, university_email, updated_at)
         VALUES ($1, $2, $3, $4, now())`,
        [id, student.seat, student.name, student.email],
      );
      await client.query(
        `INSERT INTO group_memberships (id, student_id, group_id, source) VALUES ($1, $2, $3, 'IMPORT')`,
        [uuidv7(), id, groupId],
      );
    }
    const admin = await client.query<{ display_name: string }>(
      'SELECT display_name FROM users WHERE email = $1',
      [ADMIN_EMAIL],
    );
    return admin.rows[0]!.display_name;
  } finally {
    await client.end();
  }
}

/** First sign-in by emailed code, then a password (§4.3). */
async function firstSignIn(page: Page, email: string): Promise<void> {
  await page.goto('/login');
  await chooseEnglish(page);
  await page.getByRole('tab', { name: 'Email code' }).click();
  await input(page, 'email').fill(email);
  await page.getByRole('button', { name: 'Send code' }).click();
  await input(page, 'code').fill(await codeFor(email));
  await page.getByRole('button', { name: 'Verify and sign in' }).click();
  await expect(page).toHaveURL(/\/set-password$/);
  await input(page, 'newPassword').fill(PASSWORD);
  await input(page, 'confirmPassword').fill(PASSWORD);
  await page.locator('main form button[type="submit"]').first().click();
  await expect(page).toHaveURL(/\/dashboard$/);
}

test.describe.serial('support tickets and group swaps (Phase 5)', () => {
  let admin: Page;
  let requester: Page;
  let counterpart: Page;
  let adminName: string;
  let ticketUrl: string;
  let swapUrl: string;

  test.beforeAll(async ({ browser }) => {
    adminName = await seed();
    const oneTime = resetAdminPassword();
    admin = await (await browser.newContext()).newPage();
    admin.on('dialog', (dialog) => void dialog.accept());
    await signIn(admin, ADMIN_EMAIL, oneTime, ADMIN_PASSWORD);
    requester = await (await browser.newContext()).newPage();
    requester.on('dialog', (dialog) => void dialog.accept());
    await firstSignIn(requester, REQUESTER.email);
    counterpart = await (await browser.newContext()).newPage();
    counterpart.on('dialog', (dialog) => void dialog.accept());
    await firstSignIn(counterpart, COUNTERPART.email);
  });

  test('a student files a complaint with an attachment; their details are not re-typed', async () => {
    await requester.goto('/tickets');
    await expect(requester.getByRole('heading', { name: 'Support tickets' })).toBeVisible();
    const form = requester.locator('details', { hasText: 'New ticket or request' });
    await expect(form.getByText(REQUESTER.name)).toBeVisible();
    await expect(form.getByText(REQUESTER.seat)).toBeVisible();
    await form.getByLabel('Complaint / report a problem').check();
    await input(requester, 'subject').fill(SUBJECT);
    await requester
      .locator('textarea[name="description"]')
      .fill('We waited an hour at the faculty gate.');
    await input(requester, 'files').setInputFiles({
      name: 'bus-schedule.pdf',
      mimeType: 'application/pdf',
      buffer: Buffer.from('%PDF-1.4\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n'),
    });
    await requester.getByRole('button', { name: 'Send ticket' }).click();
    await expect(requester).toHaveURL(/\/tickets\/[0-9a-f-]{36}\?notice=created$/);
    ticketUrl = requester.url().split('?')[0]!;
    await expect(requester.getByText(/Ticket #\d+ was sent/)).toBeVisible();
    await expect(requester.getByRole('link', { name: 'bus-schedule.pdf' })).toBeVisible();
    await expect(requester.locator('.status-tk-open')).toHaveText('Open');
  });

  test('staff find it in the queue, note it internally, reply and resolve it', async () => {
    await admin.goto('/tickets');
    const row = admin.locator('tbody tr', { hasText: SUBJECT });
    await expect(row).toContainText(REQUESTER.seat);
    await expect(row).toContainText(GROUP_A);
    await row.getByRole('link', { name: SUBJECT }).click();
    await expect(admin.getByRole('heading', { name: SUBJECT })).toBeVisible();

    await admin.locator('summary', { hasText: 'Reply' }).click();
    await admin.locator('textarea[name="body"]').fill('Checked with transport: driver was ill.');
    await admin.getByLabel('Internal note (staff only)').check();
    await admin.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(admin.getByText('Reply sent.')).toBeVisible();
    await expect(admin.locator('.message-internal')).toContainText('driver was ill');

    await admin.locator('textarea[name="body"]').fill('Sorry about this. A second bus is booked.');
    await admin.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(admin.locator('.message-staff:not(.message-internal)')).toContainText(
      'second bus is booked',
    );
    await expect(admin.locator('.status-tk-in_progress')).toHaveText('In progress');

    await admin.locator('select[name="status"]').selectOption('RESOLVED');
    await admin
      .locator('textarea[name="note"]')
      .fill('A backup bus is now booked for every visit.');
    await admin.getByRole('button', { name: 'Update status' }).click();
    await expect(admin.getByText('Status updated.')).toBeVisible();
    await expect(admin.locator('.status-tk-resolved')).toHaveText('Resolved');
  });

  test('the student sees the reply and outcome, but not the note or who answered', async () => {
    await requester.goto(ticketUrl);
    await expect(requester.locator('.status-tk-resolved')).toHaveText('Resolved');
    await expect(
      requester.getByText('A backup bus is now booked for every visit.').first(),
    ).toBeVisible();
    const reply = requester.locator('.message-staff');
    await expect(reply).toHaveCount(1);
    await expect(reply).toContainText('Training office');
    await expect(reply).toContainText('second bus is booked');
    await expect(requester.getByText('driver was ill')).toHaveCount(0);
    await expect(requester.locator('main')).not.toContainText(adminName);

    await requester.goto('/notifications');
    await expect(requester.getByText(/New reply on ticket #\d+/)).toBeVisible();
    await expect(requester.getByText(/Ticket #\d+ was resolved/)).toBeVisible();

    // Filters run on the server.
    await requester.goto('/tickets?status=RESOLVED');
    await expect(requester.locator('tbody tr', { hasText: SUBJECT })).toBeVisible();
    await requester.goto('/tickets?status=OPEN');
    await expect(requester.locator('tbody tr', { hasText: SUBJECT })).toHaveCount(0);
  });

  test('a swap needs a counterpart in the chosen group; then the request is sent', async () => {
    await requester.goto('/tickets?new=1');
    const form = requester.locator('details', { hasText: 'New ticket or request' });
    await form.getByLabel('Group-swap request').check();
    await expect(form.getByText(GROUP_A)).toBeVisible();
    await expect(input(requester, 'subject')).toHaveCount(0);
    await requester.locator('select[name="targetGroupId"]').selectOption({ label: GROUP_B });
    // Wrong seat number: refused without saying whether such a student exists.
    await input(requester, 'counterpartSeatNumber').fill(`NOPE-${run}`);
    await requester.getByRole('button', { name: 'Send swap request' }).click();
    await expect(
      requester.getByRole('alert').filter({ hasText: 'No student with an active account' }),
    ).toBeVisible();

    await requester.locator('select[name="targetGroupId"]').selectOption({ label: GROUP_B });
    await input(requester, 'counterpartSeatNumber').fill(COUNTERPART.seat);
    await input(requester, 'counterpartName').fill(COUNTERPART.name);
    await requester.getByRole('button', { name: 'Send swap request' }).click();
    await expect(requester).toHaveURL(/\/group-swaps\/[0-9a-f-]{36}\?notice=requested$/);
    swapUrl = requester.url().split('?')[0]!;
    await expect(requester.getByText('Your request was sent.')).toBeVisible();
    await expect(requester.locator('.status-sw-pending_counterpart')).toBeVisible();
  });

  test('the other student is told, opens the request and accepts; nobody moves yet', async () => {
    await counterpart.goto('/tickets');
    const waiting = counterpart.locator('section', { hasText: 'Requests waiting for your answer' });
    await expect(waiting).toContainText(REQUESTER.name);
    await waiting.getByRole('link', { name: new RegExp(REQUESTER.seat) }).click();
    await expect(counterpart).toHaveURL(swapUrl);
    await expect(
      counterpart.getByText(`${REQUESTER.name} asked to swap groups with you.`),
    ).toBeVisible();
    await counterpart.getByRole('button', { name: 'Accept the swap' }).click();
    await expect(
      counterpart.getByText(/You accepted\. The request now goes to the faculty/),
    ).toBeVisible();
    await expect(counterpart.locator('.status-sw-pending_faculty')).toBeVisible();

    await counterpart.goto('/dashboard');
    await expect(counterpart.locator('dd', { hasText: GROUP_B })).toBeVisible();
    await requester.goto('/notifications');
    await expect(
      requester.getByText(`${COUNTERPART.name} accepted your swap request`),
    ).toBeVisible();
  });

  test('the faculty must give a reason to reject, then approve the exchange', async () => {
    await admin.goto('/group-swaps');
    const row = admin.locator('tbody tr', { hasText: REQUESTER.seat });
    await expect(row).toContainText(COUNTERPART.seat);
    await expect(row).toContainText('Waiting for faculty review');
    await row.getByRole('link').click();
    await expect(admin).toHaveURL(swapUrl);
    const exchange = admin.locator('section', { hasText: 'Proposed exchange' });
    await expect(exchange.locator('tbody tr', { hasText: REQUESTER.seat })).toContainText(GROUP_A);

    await admin.locator('summary', { hasText: 'Reject' }).click();
    await admin.getByRole('button', { name: 'Reject the request' }).click();
    await expect(admin.getByText('Give a reason (at least 3 characters).')).toBeVisible();

    await admin.getByRole('button', { name: 'Approve the exchange' }).click();
    await expect(admin.getByText(/Approved\. The two students exchanged groups/)).toBeVisible();
    await expect(admin.locator('.status-sw-approved')).toBeVisible();
  });

  test('both students moved, were told, and never see who decided', async () => {
    for (const [page, group] of [
      [requester, GROUP_B],
      [counterpart, GROUP_A],
    ] as const) {
      await page.goto('/dashboard');
      await expect(page.locator('dd', { hasText: group })).toBeVisible();
      await page.goto('/notifications');
      await expect(page.getByText('Group swap approved')).toBeVisible();
      await expect(page.getByText(`Your new group is ${group}.`)).toBeVisible();
      await page.goto(swapUrl);
      await expect(page.locator('.status-sw-approved')).toBeVisible();
      await expect(page.locator('main')).not.toContainText(adminName);
    }
    // The requester's ticket shows the outcome too.
    await requester.goto(swapUrl);
    await requester.getByRole('link', { name: /Open ticket #\d+/ }).click();
    await expect(requester.getByText('Approved: the two students exchanged groups.')).toBeVisible();
    await expect(requester.locator('main')).not.toContainText(adminName);
  });

  test('the audit history names every decision and who made it', async () => {
    await admin.goto(`/group-swaps/history?q=${encodeURIComponent(REQUESTER.seat)}`);
    const entry = admin.locator('.audit-list > li').first();
    await expect(entry).toContainText(REQUESTER.seat);
    await expect(entry).toContainText(COUNTERPART.seat);
    await expect(entry).toContainText(`Original group: ${GROUP_A}`);
    await expect(entry).toContainText(`Original group: ${GROUP_B}`);
    await expect(entry).toContainText(`Other student: accepted`);
    await expect(entry).toContainText(COUNTERPART.name);
    await expect(entry).toContainText('Faculty: approved');
    await expect(entry).toContainText(`${adminName} (Super Admin)`);
  });
});
