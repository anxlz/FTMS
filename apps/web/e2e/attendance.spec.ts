import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { addDays, PROGRAM_TIME_ZONE, todayIn, utcToZoned, VisitQrCodesSchema } from '@ftms/core';
import { type BrowserContext, expect, type Page, test } from '@playwright/test';
import pg from 'pg';
import { ADMIN_EMAIL, chooseEnglish, codeFor, input, resetAdminPassword, signIn } from './helpers';

/**
 * Phase 4 in a real browser (Chromium with a virtual platform authenticator):
 * a student enables biometric sign-in, scans the visit's attendance link while
 * signed out, signs in, confirms with "biometrics" and the device location,
 * and is recorded present; faculty see the record with its location, correct
 * another student, and download the report. Runs after the scheduling spec
 * (see playwright.config.ts); creates the program itself when run alone.
 */

const API = 'http://localhost:4100';
const ADMIN_PASSWORD = 'harvest field lantern 59';
const STUDENT_PASSWORD = 'olive grove morning 31';
const run = Date.now().toString(36).toUpperCase();
const GROUP = `P4 Group ${run}`;
const STUDENT = { seat: `P4S-${run}`, email: `p4.s.${run.toLowerCase()}@agr.asu.edu.eg` };
const ABSENT = { seat: `P4X-${run}`, name: 'ياسمين طارق عبد الله' };
const VISIT_TITLE = `Orchard visit ${run}`;
const SITE = { latitude: 30.0444, longitude: 31.2357 };
const HERE = { latitude: 30.0451, longitude: 31.2362, accuracy: 15 };

function uuidv7(): string {
  const hex = Date.now().toString(16).padStart(12, '0') + randomBytes(10).toString('hex');
  const variant = ((parseInt(hex[15]!, 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7${hex.slice(13, 16)}-${variant}${hex.slice(16, 19)}-${hex.slice(19, 31)}`;
}

let visitId = '';

/** A group with the student who will sign in and one who never checks in; a visit that started 2 minutes ago. */
async function seed(): Promise<void> {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    const today = todayIn(PROGRAM_TIME_ZONE);
    let program = (
      await client.query<{ id: string }>('SELECT id FROM training_programs WHERE is_current')
    ).rows[0]?.id;
    if (!program) {
      program = uuidv7();
      await client.query(
        `INSERT INTO training_programs (id, name, start_date, duration_weeks, check_in_opens_minutes,
           grace_minutes, check_in_closes_minutes, allowed_absences, updated_at)
         VALUES ($1, 'Field training', $2, 20, 15, 15, 60, 2, now())`,
        [program, addDays(today, -7)],
      );
    }
    const group = uuidv7();
    await client.query(
      'INSERT INTO training_groups (id, name, updated_at) VALUES ($1, $2, now())',
      [group, GROUP],
    );
    for (const [seat, name, email] of [
      [STUDENT.seat, 'نور حسام الدين مصطفى', STUDENT.email],
      [ABSENT.seat, ABSENT.name, null],
    ] as const) {
      const id = uuidv7();
      await client.query(
        `INSERT INTO student_profiles (id, seat_number, full_name, university_email, updated_at)
         VALUES ($1, $2, $3, $4, now())`,
        [id, seat, name, email],
      );
      await client.query(
        `INSERT INTO group_memberships (id, student_id, group_id, source) VALUES ($1, $2, $3, 'IMPORT')`,
        [uuidv7(), id, group],
      );
    }
    // Started two minutes ago (Cairo wall clock); the database derives the UTC instant.
    const start = utcToZoned(new Date(Date.now() - 2 * 60_000), PROGRAM_TIME_ZONE);
    visitId = uuidv7();
    // One transaction: a visit must concern at least one group (checked at commit).
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO training_visits (id, program_id, title, date, start_time, starts_at, latitude, longitude,
         check_in_opens_minutes, grace_minutes, check_in_closes_minutes, updated_at)
       VALUES ($1, $2, $3, $4, $5, now(), $6, $7, 15, 15, 60, now())`,
      [visitId, program, VISIT_TITLE, start.date, start.time, SITE.latitude, SITE.longitude],
    );
    await client.query('INSERT INTO visit_groups (visit_id, group_id) VALUES ($1, $2)', [
      visitId,
      group,
    ]);
    await client.query('COMMIT');
  } finally {
    await client.end();
  }
}

/** The printed attendance link, as the API issues it to staff. */
async function attendanceLink(): Promise<string> {
  const auth = await fetch(`${API}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ identifier: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
  });
  const { accessToken } = (await auth.json()) as { accessToken: string };
  const res = await fetch(`${API}/visits/${visitId}/qr`, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  return VisitQrCodesSchema.parse(await res.json()).attendance.url;
}

/** Chromium's virtual platform authenticator: user-verifying, resident keys. */
async function addPlatformAuthenticator(context: BrowserContext, page: Page): Promise<void> {
  const cdp = await context.newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
}

const signOut = async (page: Page) => {
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/login$/);
};

test.describe.serial('attendance with biometrics and location (Phase 4)', () => {
  let admin: Page;
  let student: Page;
  let link: string;

  test.beforeAll(async ({ browser }) => {
    await seed();
    const oneTime = resetAdminPassword();
    const adminContext = await browser.newContext();
    admin = await adminContext.newPage();
    admin.on('dialog', (dialog) => void dialog.accept());
    await signIn(admin, ADMIN_EMAIL, oneTime, ADMIN_PASSWORD);
    link = await attendanceLink();

    const studentContext = await browser.newContext({
      permissions: ['geolocation'],
      geolocation: HERE,
    });
    student = await studentContext.newPage();
    student.on('dialog', (dialog) => void dialog.accept());
    await addPlatformAuthenticator(studentContext, student);

    // First sign-in by emailed code, then a password (§4.3).
    await student.goto('/login');
    await chooseEnglish(student);
    await student.getByRole('tab', { name: 'Email code' }).click();
    await input(student, 'email').fill(STUDENT.email);
    await student.getByRole('button', { name: 'Send code' }).click();
    await input(student, 'code').fill(await codeFor(STUDENT.email));
    await student.getByRole('button', { name: 'Verify and sign in' }).click();
    await expect(student).toHaveURL(/\/set-password$/);
    await input(student, 'newPassword').fill(STUDENT_PASSWORD);
    await input(student, 'confirmPassword').fill(STUDENT_PASSWORD);
    await student.locator('main form button[type="submit"]').first().click();
    await expect(student).toHaveURL(/\/dashboard$/);
  });

  test('staff print a stable attendance code and a details code', async () => {
    expect(link).toMatch(/^http:\/\/localhost:3100\/check-in\/[A-Za-z0-9_-]{43}$/);
    expect(await attendanceLink()).toBe(link);
    await admin.goto(`/visits/${visitId}/qr`);
    await expect(admin.getByRole('heading', { name: 'Visit QR codes' })).toBeVisible();
    await expect(
      admin.getByRole('img', { name: `Attendance QR code for ${VISIT_TITLE}` }),
    ).toBeVisible();
    await expect(
      admin.getByRole('img', { name: `Visit details QR code for ${VISIT_TITLE}` }),
    ).toBeVisible();
    await expect(admin.getByRole('button', { name: 'Print' })).toBeVisible();
  });

  test('a student enables biometric sign-in on the device after a password sign-in', async () => {
    await student.goto('/profile');
    await expect(student.getByRole('heading', { name: 'Biometric sign-in' })).toBeVisible();
    await expect(
      student.getByText('Biometric sign-in is not enabled on any device.'),
    ).toBeVisible();
    await input(student, 'name').fill('Test phone');
    await student.getByRole('button', { name: 'Enable biometric sign-in' }).click();
    await expect(student.getByText('Biometric sign-in is enabled on this device.')).toBeVisible();
    await expect(student.locator('.device-list li', { hasText: 'Test phone' })).toBeVisible();
  });

  test('biometric sign-in works without a password', async () => {
    await signOut(student);
    await student.getByRole('button', { name: 'Sign in with fingerprint or face' }).click();
    await expect(student).toHaveURL(/\/dashboard$/);
    // A biometric session cannot enroll further devices.
    await student.goto('/profile');
    await expect(student.getByText(/You signed in with biometrics/)).toBeVisible();
  });

  test('a scanned link leads through sign-in to the check-in, confirmed with biometrics and location', async () => {
    await signOut(student);
    await student.goto(link);
    await expect(student).toHaveURL(/\/login\?next=%2Fcheck-in%2F/);
    await expect(student.getByText(/Sign in to record your attendance/)).toBeVisible();
    await input(student, 'identifier').fill(STUDENT.seat);
    await input(student, 'password').fill(STUDENT_PASSWORD);
    await student.locator('main form button[type="submit"]').first().click();
    await expect(student).toHaveURL(link);

    await expect(student.getByRole('heading', { name: VISIT_TITLE })).toBeVisible();
    await expect(student.getByText(/You will confirm with your fingerprint or face/)).toBeVisible();
    await student.getByRole('button', { name: 'Confirm with biometrics and check in' }).click();
    const result = student.locator('.check-in-result');
    await expect(result).toContainText('Attendance recorded');
    await expect(result).toContainText('Present');
    await expect(result).toContainText('Confirmed with biometrics.');
    await expect(result).toContainText('Location shared.');

    // A second scan shows the existing record; nothing new is created.
    await student.goto(link);
    await expect(student.locator('.check-in-result')).toContainText(
      'Your attendance is already recorded',
    );
    await expect(
      student.getByRole('button', { name: 'Confirm with biometrics and check in' }),
    ).toHaveCount(0);
  });

  test('faculty see the record with its location, and correct a student who did not check in', async () => {
    await admin.goto(`/visits/${visitId}/attendance`);
    await expect(admin.getByRole('heading', { name: VISIT_TITLE })).toBeVisible();
    const row = admin.locator('tbody tr', { hasText: STUDENT.seat });
    await expect(row).toContainText('Present');
    await expect(row).toContainText('QR check-in');
    await expect(row).toContainText('Biometric confirmed');
    await expect(row.getByRole('link', { name: '30.04510, 31.23620' })).toBeVisible();
    await expect(row).toContainText('±15 m');
    await expect(row).toContainText('m from the site');

    const other = admin.locator('tbody tr', { hasText: ABSENT.seat });
    await expect(other).toContainText('Not recorded');
    await other.getByText('Record attendance').click();
    await other.locator('select[name="status"]').selectOption('LATE');
    await other.locator('input[name="minutesLate"]').fill('5');
    await other.locator('textarea[name="reason"]').fill('Arrived with the second bus');
    await other.getByRole('button', { name: 'Save correction' }).click();
    const corrected = admin.locator('tbody tr', { hasText: ABSENT.seat });
    await expect(corrected).toContainText('Late (5 minutes)');
    await expect(corrected).toContainText('Faculty correction');
    await expect(corrected).toContainText('Arrived with the second bus');

    // Filters run on the server.
    await admin.locator('select[name="status"]').first().selectOption('LATE');
    await admin.getByRole('button', { name: 'Filter' }).click();
    await expect(admin.locator('tbody tr')).toHaveCount(1);
  });

  test('the report downloads as CSV with the same records', async () => {
    await admin.goto(`/visits/${visitId}/attendance`);
    await admin.locator('#export-format').selectOption('csv');
    await admin.locator('#export-locale').selectOption('en');
    const [download] = await Promise.all([
      admin.waitForEvent('download'),
      admin.getByRole('button', { name: 'Download' }).click(),
    ]);
    expect(download.suggestedFilename()).toMatch(/^ftms-attendance-\d{12}\.csv$/);
    const text = readFileSync(await download.path(), 'utf8');
    expect(text.charCodeAt(0)).toBe(0xfeff);
    expect(text).toContain(`${STUDENT.seat},Present`);
    expect(text).toContain(`${ABSENT.seat},Late`);
    expect(text).toContain(ABSENT.name);
  });

  test('the student sees the record on the attendance page and the dashboard', async () => {
    await student.goto('/attendance');
    await expect(student.getByRole('heading', { name: 'My attendance' })).toBeVisible();
    const row = student.locator('tbody tr', { hasText: VISIT_TITLE });
    await expect(row).toContainText('Present');
    await expect(row).toContainText('QR check-in');
    await student.goto('/dashboard');
    await expect(student.getByRole('heading', { name: 'My attendance' })).toBeVisible();
  });
});
