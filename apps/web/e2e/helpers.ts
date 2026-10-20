import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { type BrowserContext, expect, type Page } from '@playwright/test';

const here = path.dirname(fileURLToPath(import.meta.url));
export const STATE = path.join(here, '..', '.e2e');
export const ADMIN_EMAIL = 'st22425244@agr.asu.edu.eg';

export const input = (page: Page, name: string) => page.locator(`input[name="${name}"]`);

/** Latest 6-digit code the API "sent" to `email` (development mail log). */
export async function codeFor(email: string): Promise<string> {
  for (let i = 0; i < 40; i += 1) {
    const log = readFileSync(path.join(STATE, 'api.log'), 'utf8');
    const at = log.lastIndexOf(`Logged email body for ${email}`);
    const code = at >= 0 ? /\b(\d{6})\b/.exec(log.slice(at))?.[1] : undefined;
    if (code) return code;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`No code was mailed to ${email}`);
}

export async function preferEnglish(context: BrowserContext) {
  await context.addCookies([{ name: 'NEXT_LOCALE', value: 'en', url: 'http://localhost:3100' }]);
}

/**
 * Picks English on a sign-in page (start from a context without a language
 * cookie). A choice made there is saved to the account at sign-in; a cookie
 * alone is not — the account's own preference wins.
 */
export async function chooseEnglish(page: Page) {
  if ((await page.locator('html').getAttribute('lang')) === 'en') return;
  await page.getByRole('button', { name: 'English' }).click();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
}

/**
 * Issues a new one-time Super Admin password with the real seed script
 * (`--reset-password`), so a spec does not depend on what another spec did.
 */
export function resetAdminPassword(): string {
  const output = execFileSync('node', ['dist/scripts/seed-super-admin.js', '--reset-password'], {
    cwd: path.join(here, '..', '..', 'api'),
    env: process.env,
    encoding: 'utf8',
  });
  const password = /^One-time password: (\S+)$/m.exec(output)?.[1];
  if (!password) throw new Error('Seed script did not print a password');
  return password;
}

/** Signs in with email/seat + password; handles the forced password change. */
export async function signIn(
  page: Page,
  identifier: string,
  password: string,
  newPassword?: string,
) {
  await page.goto('/login');
  await chooseEnglish(page);
  await input(page, 'identifier').fill(identifier);
  await input(page, 'password').fill(password);
  await page.locator('main form button[type="submit"]').first().click();
  if (newPassword) {
    await expect(page).toHaveURL(/\/set-password$/);
    await input(page, 'currentPassword').fill(password);
    await input(page, 'newPassword').fill(newPassword);
    await input(page, 'confirmPassword').fill(newPassword);
    await page.locator('main form button[type="submit"]').first().click();
  }
  await expect(page).toHaveURL(/\/(dashboard|verification)$/);
}
