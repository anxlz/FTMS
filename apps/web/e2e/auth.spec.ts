import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { ADMIN_EMAIL, codeFor, input, STATE, preferEnglish } from './helpers';

const ADMIN_NEW_PASSWORD = 'nile delta harvest 2026';

const oneTimePassword = (): string =>
  (JSON.parse(readFileSync(path.join(STATE, 'super-admin.json'), 'utf8')) as { password: string })
    .password;

test.describe.serial('authentication in the browser (§4.3, §2)', () => {
  test('Super Admin: the generated password works once and must be replaced (Phase 1 DoD)', async ({
    page,
  }) => {
    await page.goto('/');
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    await expect(page.locator('html')).toHaveAttribute('lang', 'ar');

    await input(page, 'identifier').fill('ST22425244@AGR.asu.edu.eg');
    await input(page, 'password').fill(oneTimePassword());
    await page.getByRole('button', { name: 'دخول', exact: true }).click();
    await expect(page).toHaveURL(/\/set-password$/);

    // Nothing else is reachable until the password is replaced.
    await page.goto('/dashboard');
    await expect(page).toHaveURL(/\/set-password$/);
    await page.goto('/admin/users');
    await expect(page).toHaveURL(/\/set-password$/);

    await input(page, 'currentPassword').fill(oneTimePassword());
    await input(page, 'newPassword').fill(ADMIN_NEW_PASSWORD);
    await input(page, 'confirmPassword').fill('a different value');
    await page.getByRole('button', { name: 'حفظ كلمة المرور' }).click();
    await expect(page.getByRole('main').getByRole('alert')).toContainText('غير متطابقتين');

    await input(page, 'currentPassword').fill(oneTimePassword());
    await input(page, 'newPassword').fill(ADMIN_NEW_PASSWORD);
    await input(page, 'confirmPassword').fill(ADMIN_NEW_PASSWORD);
    await page.getByRole('button', { name: 'حفظ كلمة المرور' }).click();
    await expect(page).toHaveURL(/\/dashboard$/);
    await expect(
      page.getByRole('navigation').getByRole('link', { name: 'الحسابات' }),
    ).toBeVisible();

    // The one-time password is now dead.
    await page.getByRole('button', { name: 'تسجيل الخروج' }).click();
    await expect(page).toHaveURL(/\/login$/);
    await input(page, 'identifier').fill(ADMIN_EMAIL);
    await input(page, 'password').fill(oneTimePassword());
    await page.getByRole('button', { name: 'دخول', exact: true }).click();
    await expect(page.getByRole('main').getByRole('alert')).toContainText(
      'بيانات الدخول غير صحيحة',
    );
    // A failed attempt keeps what was typed (the password is cleared on purpose).
    await expect(input(page, 'identifier')).toHaveValue(ADMIN_EMAIL);
    await expect(input(page, 'password')).toHaveValue('');
  });

  test('the chosen language is saved to the account and follows it to a new browser', async ({
    page,
    browser,
  }) => {
    await page.goto('/login');
    await input(page, 'identifier').fill(ADMIN_EMAIL);
    await input(page, 'password').fill(ADMIN_NEW_PASSWORD);
    await page.getByRole('button', { name: 'دخول', exact: true }).click();
    await expect(page).toHaveURL(/\/dashboard$/);

    await page.getByRole('button', { name: 'English' }).click();
    await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Welcome');

    const fresh = await browser.newContext();
    const other = await fresh.newPage();
    await other.goto('/login');
    await expect(other.locator('html')).toHaveAttribute('lang', 'ar'); // no cookie yet → Arabic
    await input(other, 'identifier').fill(ADMIN_EMAIL);
    await input(other, 'password').fill(ADMIN_NEW_PASSWORD);
    await other.getByRole('button', { name: 'دخول', exact: true }).click();
    await expect(other).toHaveURL(/\/dashboard$/);
    await expect(other.locator('html')).toHaveAttribute('lang', 'en');
    await fresh.close();
  });

  const FACULTY = {
    email: `dr.e2e.${Date.now()}@agr.asu.edu.eg`,
    password: 'olive grove morning 41',
  };

  test('a faculty account created by the admin signs in first with an email code', async ({
    page,
    browser,
  }) => {
    await preferEnglish(page.context());
    await page.goto('/login');
    await input(page, 'identifier').fill(ADMIN_EMAIL);
    await input(page, 'password').fill(ADMIN_NEW_PASSWORD);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await page.getByRole('navigation').getByRole('link', { name: 'Accounts' }).click();
    await page.locator('summary').click();
    await input(page, 'email').fill(FACULTY.email);
    await input(page, 'fullName').fill('Dr. E2E Faculty');
    await page.getByRole('button', { name: 'Create account' }).click();
    await expect(page.getByText('Account created and invitation sent.')).toBeVisible();

    // A shared lab computer: an English cookie left behind by a previous user.
    const faculty = await browser.newContext();
    await preferEnglish(faculty);
    const fp = await faculty.newPage();
    await fp.goto('/login');
    // Without a password, email + password cannot get in.
    await input(fp, 'identifier').fill(FACULTY.email);
    await input(fp, 'password').fill('any password at all');
    await fp.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(fp.getByRole('main').getByRole('alert')).toContainText(
      'Incorrect sign-in details',
    );

    await fp.getByRole('tab', { name: 'Email code' }).click();
    await input(fp, 'email').fill(FACULTY.email);
    await fp.getByRole('button', { name: 'Send code' }).click();
    await input(fp, 'code').fill(await codeFor(FACULTY.email));
    await fp.getByRole('button', { name: 'Verify and sign in' }).click();

    // The account's own preference (Arabic, the default) wins over the leftover cookie.
    await expect(fp).toHaveURL(/\/set-password$/);
    await expect(fp.locator('html')).toHaveAttribute('dir', 'rtl');
    await expect(fp.getByRole('heading', { level: 1 })).toHaveText('عيّن كلمة مرورك');
    await expect(input(fp, 'currentPassword')).toHaveCount(0); // first password: nothing to confirm
    await input(fp, 'newPassword').fill(FACULTY.password);
    await input(fp, 'confirmPassword').fill(FACULTY.password);
    await fp.getByRole('button', { name: 'حفظ كلمة المرور' }).click();
    await expect(fp).toHaveURL(/\/dashboard$/);

    // Faculty have no account management: the link is hidden and the page refuses.
    await expect(fp.getByRole('navigation').getByRole('link', { name: 'الحسابات' })).toHaveCount(0);
    const response = await fp.goto('/admin/users');
    expect(response?.status()).toBe(404);
    await faculty.close();
  });

  test('a language picked on the sign-in page is saved to the account', async ({ browser }) => {
    const first = await browser.newContext();
    const page = await first.newPage();
    await page.goto('/login');
    await expect(page.locator('html')).toHaveAttribute('lang', 'ar');
    await page.getByRole('button', { name: 'English' }).click();
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await input(page, 'identifier').fill(FACULTY.email);
    await input(page, 'password').fill(FACULTY.password);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page).toHaveURL(/\/dashboard$/);
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await first.close();

    // Another browser, no cookies: the saved preference comes back with the account.
    const second = await browser.newContext();
    const again = await second.newPage();
    await again.goto('/login');
    await input(again, 'identifier').fill(FACULTY.email);
    await input(again, 'password').fill(FACULTY.password);
    await again.getByRole('button', { name: 'دخول', exact: true }).click();
    await expect(again).toHaveURL(/\/dashboard$/);
    await expect(again.locator('html')).toHaveAttribute('lang', 'en');
    await second.close();
  });
});
