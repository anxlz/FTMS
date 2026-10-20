import { Logger } from '@nestjs/common';
import { LivenessResponseSchema, ReadinessResponseSchema } from '@ftms/core';
import { type MailService } from '../mail/mail.service';
import { type PrismaService } from '../prisma/prisma.service';
import { type RedisService } from '../redis/redis.service';
import { type StorageService } from '../storage/storage.service';
import { testConfig } from '../testing/test-config';
import { HealthService, PROBE_TIMEOUT_MS } from './health.service';

interface Deps {
  dbPing?: () => Promise<void>;
  redis?: { isConfigured: boolean; ping?: () => Promise<void> };
  storage?: {
    isConfigured: boolean;
    verifyBuckets?: () => Promise<{ missing: string[]; public: string[] }>;
  };
  mail?: { mode: 'smtp' | 'log'; verifyCached?: () => Promise<void> };
  production?: boolean;
}

const ok = () => Promise.resolve();

function build(deps: Deps = {}) {
  const config = deps.production
    ? testConfig({
        NODE_ENV: 'production',
        SUPABASE_URL: 'https://abcd.supabase.co',
        SUPABASE_SERVICE_ROLE_KEY: 'service-role-key-0123456789',
        UPSTASH_REDIS_REST_URL: 'https://eu1-example.upstash.io',
        UPSTASH_REDIS_REST_TOKEN: 'upstash-token-0123456789',
        SMTP_PASS: 'placeholder',
        JWT_ACCESS_SECRET: 'a'.repeat(32),
        JWT_REFRESH_SECRET: 'b'.repeat(32),
        QR_HMAC_SECRET: 'c'.repeat(32),
        BFF_SHARED_SECRET: 'd'.repeat(32),
        WEB_APP_URL: 'https://ftms.example.edu.eg',
      })
    : testConfig();
  return new HealthService(
    config,
    { ping: deps.dbPing ?? ok } as unknown as PrismaService,
    (deps.redis ?? { isConfigured: true, ping: ok }) as unknown as RedisService,
    (deps.storage ?? {
      isConfigured: true,
      verifyBuckets: () => Promise.resolve({ missing: [], public: [] }),
    }) as unknown as StorageService,
    (deps.mail ?? { mode: 'smtp', verifyCached: ok }) as unknown as MailService,
  );
}

describe('HealthService', () => {
  beforeEach(() => jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined));
  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it('returns a liveness payload matching the shared contract', () => {
    const payload = build().liveness();
    expect(LivenessResponseSchema.parse(payload)).toEqual(payload);
  });

  it('is ready when every dependency answers', async () => {
    const result = await build().readiness();
    expect(ReadinessResponseSchema.parse(result)).toEqual(result);
    expect(result.status).toBe('ready');
    expect(Object.values(result.checks).every((c) => c.status === 'up')).toBe(true);
  });

  it('is degraded in development when optional services are not configured', async () => {
    const result = await build({
      redis: { isConfigured: false },
      storage: { isConfigured: false },
      mail: { mode: 'log' },
    }).readiness();

    expect(result.status).toBe('degraded');
    expect(result.checks.database.status).toBe('up');
    expect(result.checks.redis).toEqual({
      status: 'not_configured',
      detail: 'UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN not set',
    });
    expect(result.checks.mail.status).toBe('not_configured');
  });

  it('marks the database down with its error in development', async () => {
    const result = await build({
      dbPing: () => Promise.reject(new Error('connect ECONNREFUSED 127.0.0.1:5432')),
    }).readiness();
    expect(result.status).toBe('not_ready');
    expect(result.checks.database).toMatchObject({
      status: 'down',
      detail: 'connect ECONNREFUSED 127.0.0.1:5432',
    });
  });

  it('hides failure details in production', async () => {
    const result = await build({
      production: true,
      dbPing: () => Promise.reject(new Error('password authentication failed for user "postgres"')),
    }).readiness();
    expect(result.checks.database.status).toBe('down');
    expect(result.checks.database.detail).toBeUndefined();
  });

  it('reports missing and public buckets as storage down', async () => {
    const result = await build({
      storage: {
        isConfigured: true,
        verifyBuckets: () =>
          Promise.resolve({ missing: ['visit-media'], public: ['student-imports'] }),
      },
    }).readiness();
    expect(result.checks.storage.status).toBe('down');
    expect(result.checks.storage.detail).toContain('missing buckets: visit-media');
    expect(result.checks.storage.detail).toContain(
      'PUBLIC buckets (must be private): student-imports',
    );
  });

  it('times out a hanging probe instead of hanging the request', async () => {
    jest.useFakeTimers();
    const pending = build({
      redis: { isConfigured: true, ping: () => new Promise<void>(() => undefined) },
    }).readiness();

    await jest.advanceTimersByTimeAsync(PROBE_TIMEOUT_MS + 1);
    const result = await pending;
    expect(result.checks.redis).toMatchObject({
      status: 'down',
      detail: `redis probe timed out after ${PROBE_TIMEOUT_MS} ms`,
    });
    expect(result.status).toBe('not_ready');
  });
});
