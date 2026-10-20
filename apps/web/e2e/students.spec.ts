import { type Browser, expect, type Page, test } from '@playwright/test';
import ExcelJS from 'exceljs';
import { ADMIN_EMAIL, chooseEnglish, codeFor, input, resetAdminPassword, signIn } from './helpers';

const ADMIN_PASSWORD = 'river valley seedling 77';
const STUDENT_PASSWORD = 'olive grove morning 41';
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** Same headers as the downloadable template. */
const HEADERS = [
  'رقم الجلوس / Seat number',
  'الاسم الأول / First name',
  "اسم الأب / Father's name",
  "اسم الجد / Grandfather's name",
  'اسم العائلة / Family name',
  'البريد الجامعي / University email',
  'المجموعة / Group',
  'رقم الهاتف / Phone',
];

const IMPORTED = {
  seat: 'E2E-101',
  email: `imported.${Date.now()}@agr.asu.edu.eg`,
  name: 'سارة محمود سالم سعيد',
};
const NO_EMAIL = { seat: 'E2E-102', name: 'محمد أحمد علي حسن' };

async function workbook(rows: (string | null)[][]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const sheet = wb.addWorksheet('Students');
  sheet.addRow(HEADERS);
  for (const row of rows) sheet.addRow(row);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

async function englishPage(browser: Browser): Promise<Page> {
  const context = await browser.newContext();
  const page = await context.newPage();
  page.on('dialog', (dialog) => void dialog.accept());
  return page;
}

/** Sets the first password after an email-code sign-in or a signup. */
async function setFirstPassword(page: Page) {
  await expect(page).toHaveURL(/\/set-password$/);
  await input(page, 'newPassword').fill(STUDENT_PASSWORD);
  await input(page, 'confirmPassword').fill(STUDENT_PASSWORD);
  await page.getByRole('button', { name: 'Save password' }).click();
}

test.describe.serial('student records and groups in the browser (Phase 2)', () => {
  let admin: Page;

  test.beforeAll(async ({ browser }) => {
    const oneTime = resetAdminPassword();
    admin = await englishPage(browser);
    await signIn(admin, ADMIN_EMAIL, oneTime, ADMIN_PASSWORD);
  });

  test('faculty imports students from a spreadsheet after a preview (Phase 2 DoD)', async () => {
    // A group to import into.
    await admin.goto('/groups');
    await admin.locator('summary').click();
    await input(admin, 'name').fill('المجموعة أ');
    await admin.getByRole('button', { name: 'Create a group' }).click();
    await expect(admin.getByRole('heading', { level: 1 })).toHaveText('المجموعة أ');

    // The template downloads as a real spreadsheet.
    await admin.goto('/students/import');
    const template = await admin.request.get('/students/import/template');
    expect(template.status()).toBe(200);
    expect(template.headers()['content-type']).toBe(XLSX);

    await input(admin, 'file').setInputFiles({
      name: 'students.xlsx',
      mimeType: XLSX,
      buffer: await workbook([
        [
          IMPORTED.seat,
          'سارة',
          'محمود',
          'سالم',
          'سعيد',
          IMPORTED.email,
          'المجموعة أ',
          '01012345678',
        ],
        [NO_EMAIL.seat, 'محمد', 'أحمد', 'علي', 'حسن', null, null, null],
        ['BAD SEAT', 'علي', 'حسن', null, null, null, null, null],
      ]),
    });
    await admin.getByRole('button', { name: 'Upload and preview' }).click();
    await expect(admin).toHaveURL(/\/students\/import\/[0-9a-f-]+$/);

    const stat = (label: string) =>
      admin.locator('.stat', { hasText: label }).locator('.stat-value');
    await expect(stat('New students')).toHaveText('2');
    await expect(stat('Rows with errors')).toHaveText('1');
    await expect(
      admin.getByRole('cell', { name: /English letters, digits and hyphens/ }),
    ).toBeVisible();

    // Errors must be acknowledged explicitly.
    await admin.getByRole('button', { name: 'Confirm import' }).click();
    await expect(admin.getByRole('main').getByRole('alert')).toContainText('Some rows have errors');
    await admin.getByLabel('Skip the row with errors and import the rest').check();
    await admin.getByRole('button', { name: 'Confirm import' }).click();
    await expect(admin.getByText('Imported: 2 added, 0 updated.')).toBeVisible();

    await admin.goto('/students');
    await expect(admin.getByRole('link', { name: IMPORTED.name })).toBeVisible();
    await expect(admin.getByRole('link', { name: NO_EMAIL.name })).toBeVisible();
    await expect(admin.getByText('2 students', { exact: true })).toBeVisible();
  });

  test('an imported student signs in the first time by email code and is linked, not duplicated (DoD)', async ({
    browser,
  }) => {
    const student = await englishPage(browser);
    await student.goto('/login');
    await chooseEnglish(student);
    await student.getByRole('tab', { name: 'Email code' }).click();
    await input(student, 'email').fill(IMPORTED.email);
    await student.getByRole('button', { name: 'Send code' }).click();
    await input(student, 'code').fill(await codeFor(IMPORTED.email));
    await student.getByRole('button', { name: 'Verify and sign in' }).click();
    await setFirstPassword(student);
    await expect(student).toHaveURL(/\/dashboard$/);
    // The record the faculty imported is the account's data: name, seat, group.
    await expect(student.getByRole('heading', { level: 1 })).toContainText(IMPORTED.name);
    await expect(student.getByText(IMPORTED.seat)).toBeVisible();
    await expect(student.getByText('المجموعة أ')).toBeVisible();

    // Seat number + password works from now on.
    await student.context().clearCookies();
    await signIn(student, IMPORTED.seat, STUDENT_PASSWORD);
    await expect(student).toHaveURL(/\/dashboard$/);
    await student.context().close();

    await admin.goto('/students?account=linked');
    await expect(admin.getByText('1 student', { exact: true })).toBeVisible();
    await admin.goto('/students');
    await expect(admin.getByText('2 students', { exact: true })).toBeVisible();
  });

  test('signup links a matching record at once, or waits for review (Case A / Case B)', async ({
    browser,
  }) => {
    const signup = async (page: Page, email: string, seat: string, parts: string[]) => {
      await page.goto('/signup');
      await chooseEnglish(page);
      for (const [name, value] of [
        ['firstName', parts[0]],
        ['fatherName', parts[1]],
        ['grandfatherName', parts[2]],
        ['familyName', parts[3]],
        ['seatNumber', seat],
        ['email', email],
      ] as const) {
        await input(page, name).fill(value!);
      }
      await page.getByRole('button', { name: 'Send confirmation code' }).click();
      await input(page, 'code').fill(await codeFor(email));
      await page.getByRole('button', { name: 'Confirm and create account' }).click();
      await setFirstPassword(page);
    };

    // Case A: the record without email, name typed with spelling variants.
    const matched = await englishPage(browser);
    await signup(matched, `case.a.${Date.now()}@agr.asu.edu.eg`, NO_EMAIL.seat, [
      'محمد',
      'احمد',
      'على',
      'حسن',
    ]);
    await expect(matched).toHaveURL(/\/dashboard$/);
    await expect(matched.getByRole('heading', { level: 1 })).toContainText(NO_EMAIL.name);
    await matched.context().close();

    // Case B: no record — the account waits and sees nothing academic.
    const waiting = await englishPage(browser);
    const email = `case.b.${Date.now()}@agr.asu.edu.eg`;
    await signup(waiting, email, 'E2E-NEW-9', ['يوسف', 'خالد', 'محمود', 'عمر']);
    await expect(waiting).toHaveURL(/\/verification$/);
    await expect(waiting.getByText('Your details are waiting for review')).toBeVisible();
    await waiting.goto('/dashboard');
    await expect(waiting).toHaveURL(/\/verification$/);
    await waiting.goto('/profile');
    await expect(waiting).toHaveURL(/\/verification$/);

    // The reviewer creates the record into a group; the student is in.
    await admin.goto('/reviews');
    await admin.getByRole('link', { name: 'يوسف خالد محمود عمر' }).click();
    await expect(admin.getByText('No student record', { exact: true })).toBeVisible();
    await admin.getByLabel('Group (optional)').selectOption({ label: 'المجموعة أ' });
    await admin.getByRole('button', { name: 'Create record and verify' }).click();
    // The page now shows the decision instead of the forms.
    await expect(admin.locator('.status', { hasText: 'Approved' })).toBeVisible();

    await waiting.goto('/verification');
    await expect(waiting).toHaveURL(/\/dashboard$/);
    await expect(waiting.getByText('E2E-NEW-9')).toBeVisible();
    await expect(waiting.getByText('المجموعة أ')).toBeVisible();
    await waiting.context().close();
  });

  test('a protected profile correction applies only after approval', async ({ browser }) => {
    const student = await englishPage(browser);
    await signIn(student, IMPORTED.email, STUDENT_PASSWORD);
    await student.goto('/profile');
    // Permitted field: changes at once.
    await input(student, 'phone').fill('01198765432');
    await student.getByRole('button', { name: 'Save phone' }).click();
    await expect(student.getByText('Phone number saved.')).toBeVisible();
    // Protected field: a request.
    await input(student, 'familyName').fill('سعد');
    await student.locator('textarea[name="note"]').fill('Family name is misspelled');
    await student.getByRole('button', { name: 'Send request' }).click();
    await expect(student.getByText('Your correction request is waiting for review.')).toBeVisible();
    await expect(student.getByRole('cell', { name: 'Waiting' })).toBeVisible();

    await admin.goto('/reviews');
    await admin.getByRole('link', { name: IMPORTED.name }).click();
    await expect(admin.getByRole('cell', { name: 'سعد' })).toBeVisible();
    await admin.getByRole('button', { name: 'Approve and apply' }).click();
    // The page now shows the decision instead of the forms.
    await expect(admin.locator('.status', { hasText: 'Approved' })).toBeVisible();

    await student.reload();
    await expect(student.getByRole('cell', { name: 'Approved' })).toBeVisible();
    await expect(student.getByText('سارة محمود سالم سعد').first()).toBeVisible();
    await student.context().close();
  });

  test('moving a student to another group needs an explicit choice', async () => {
    await admin.goto('/groups');
    await admin.locator('summary').click();
    await input(admin, 'name').fill('المجموعة ب');
    await admin.getByRole('button', { name: 'Create a group' }).click();
    await expect(admin.getByRole('heading', { level: 1 })).toHaveText('المجموعة ب');

    await input(admin, 'q').fill(IMPORTED.seat);
    await admin.getByRole('button', { name: 'Search' }).click();
    await admin
      .getByLabel(/^Select /)
      .first()
      .check();
    await admin.getByRole('button', { name: 'Add selected students' }).click();
    await expect(admin.getByRole('main').getByRole('alert')).toContainText('in another group');

    await admin
      .getByLabel(/^Select /)
      .first()
      .check();
    await admin.getByLabel('Move selected students who are in another group').check();
    await admin.getByRole('button', { name: 'Add selected students' }).click();
    await expect(admin.getByText('0 added, 1 moved from another group')).toBeVisible();
    await expect(admin.getByRole('heading', { name: /Members \(1\)/ })).toBeVisible();
  });
});
