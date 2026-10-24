import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, devices } from '@playwright/test';

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * Browser end-to-end tests: the real Next.js server talking to the real NestJS API
 * and a real Postgres (DATABASE_URL, migrations applied). Run after `pnpm build`:
 *
 *   DATABASE_URL=postgresql://… pnpm --filter @ftms/web test:e2e
 */
const API_PORT = 4100;
const WEB_PORT = 3100;
const STATE_DIR = path.join(here, '.e2e');

/** Clearly fake secrets for this local test stack only. */
const SECRETS = {
  JWT_ACCESS_SECRET: 'e2e-access-secret-0123456789abcdef0123456789',
  JWT_REFRESH_SECRET: 'e2e-refresh-secret-0123456789abcdef012345678',
  BFF_SHARED_SECRET: 'e2e-bff-shared-secret-0123456789abcdef012345',
};

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  globalSetup: './e2e/global-setup.ts',
  use: {
    baseURL: `http://localhost:${WEB_PORT}`,
    trace: 'retain-on-failure',
    ...devices['Desktop Chrome'],
    // Lets a machine without Playwright's own browser download use a local Chromium.
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
      ? { launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } }
      : {}),
  },
  // The attendance spec builds on the program the scheduling spec configures.
  projects: [
    { name: 'core', testIgnore: /attendance\.spec\.ts$/ },
    { name: 'attendance', testMatch: /attendance\.spec\.ts$/, dependencies: ['core'] },
  ],
  webServer: [
    {
      // The API logs emails instead of sending them (no SMTP_PASS); tests read codes from this log.
      command: `mkdir -p "${STATE_DIR}" && node ../api/dist/main.js > "${path.join(STATE_DIR, 'api.log')}" 2>&1`,
      url: `http://localhost:${API_PORT}/health`,
      reuseExistingServer: false,
      timeout: 60_000,
      env: {
        NODE_ENV: 'development',
        PORT: String(API_PORT),
        DATABASE_URL: process.env.DATABASE_URL ?? '',
        WEB_APP_URL: `http://localhost:${WEB_PORT}`,
        ...SECRETS,
      },
    },
    {
      command: `pnpm exec next start --port ${WEB_PORT}`,
      url: `http://localhost:${WEB_PORT}/login`,
      reuseExistingServer: false,
      timeout: 60_000,
      env: {
        API_URL: `http://localhost:${API_PORT}`,
        BFF_SHARED_SECRET: SECRETS.BFF_SHARED_SECRET,
      },
    },
  ],
});
