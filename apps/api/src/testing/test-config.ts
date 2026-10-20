import { type AppConfigService } from '../config/app-config.service';
import { type Env, parseEnv } from '../config/env';

export const TEST_DATABASE_URL = 'postgresql://ftms:ftms@127.0.0.1:5432/ftms_test';

/**
 * Builds a real, validated configuration (through the production `parseEnv`) and
 * exposes it through the `AppConfigService` surface, for unit tests.
 */
export function testConfig(overrides: Record<string, string | undefined> = {}): AppConfigService {
  const env: Env = parseEnv({ NODE_ENV: 'test', DATABASE_URL: TEST_DATABASE_URL, ...overrides });
  return {
    get: <K extends keyof Env>(key: K): Env[K] => env[key],
    get isProduction() {
      return env.NODE_ENV === 'production';
    },
  } as AppConfigService;
}
