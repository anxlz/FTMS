import { type AppConfigService } from '../config/app-config.service';
import { type Env, parseEnv } from '../config/env';

export const TEST_DATABASE_URL = 'postgresql://ftms:ftms@127.0.0.1:5432/ftms_test';

/** Fixed, clearly fake secrets for tests only. */
export const TEST_SECRETS = {
  JWT_ACCESS_SECRET: 'test-access-secret-0123456789abcdef0123456789',
  JWT_REFRESH_SECRET: 'test-refresh-secret-0123456789abcdef012345678',
  BFF_SHARED_SECRET: 'test-bff-shared-secret-0123456789abcdef012345',
} as const;

/**
 * Builds a real, validated configuration (through the production `parseEnv`) and
 * exposes it through the `AppConfigService` surface, for unit tests.
 */
export function testConfig(overrides: Record<string, string | undefined> = {}): AppConfigService {
  const env: Env = parseEnv({
    NODE_ENV: 'test',
    DATABASE_URL: TEST_DATABASE_URL,
    ...TEST_SECRETS,
    ...overrides,
  });
  return {
    get: <K extends keyof Env>(key: K): Env[K] => env[key],
    get isProduction() {
      return env.NODE_ENV === 'production';
    },
  } as AppConfigService;
}
