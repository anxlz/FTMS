import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { LivenessResponseSchema, ReadinessResponseSchema } from '@ftms/core';
import request from 'supertest';
import { type App } from 'supertest/types';
import * as appFactory from '../src/app.factory';
import { configureApp } from '../src/app.factory';
import { AppModule } from '../src/app.module';
import { AppConfigService } from '../src/config/app-config.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { testConfig } from '../src/testing/test-config';
import vercelHandler, { closeWarmApp } from '../src/vercel';

async function boot(configOverride?: AppConfigService): Promise<INestApplication<App>> {
  let builder = Test.createTestingModule({ imports: [AppModule] });
  if (configOverride) builder = builder.overrideProvider(AppConfigService).useValue(configOverride);
  const app = (await builder.compile()).createNestApplication<INestApplication<App>>({
    logger: false,
  });
  configureApp(app);
  await app.init();
  return app;
}

describe('API against a real Postgres', () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    app = await boot();
  });
  afterAll(async () => {
    await app.close();
  });

  it('GET /health → 200 liveness payload, uncached, no framework fingerprint', async () => {
    const res = await request(app.getHttpServer()).get('/health').expect(200);
    expect(LivenessResponseSchema.parse(res.body)).toEqual(res.body);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('GET /health/ready → database up via Prisma; unconfigured services reported honestly', async () => {
    const res = await request(app.getHttpServer()).get('/health/ready').expect(200);
    const body = ReadinessResponseSchema.parse(res.body);
    expect(body.checks.database.status).toBe('up');
    expect(body.checks.redis.status).toBe('not_configured');
    expect(body.checks.storage.status).toBe('not_configured');
    expect(body.checks.mail.status).toBe('not_configured');
    expect(body.status).toBe('degraded');
  });

  it('the initial Prisma migration has been applied to this database', async () => {
    const prisma = app.get(PrismaService);
    const rows = await prisma.$queryRaw<{ migration_name: string; finished_at: Date | null }[]>`
      SELECT migration_name, finished_at FROM _prisma_migrations ORDER BY started_at`;
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0]?.migration_name).toMatch(/^\d{14}_init$/);
    expect(rows.every((r) => r.finished_at !== null)).toBe(true);
  });

  it('unknown routes → 404', async () => {
    await request(app.getHttpServer()).get('/definitely-not-a-route').expect(404);
  });
});

describe('Vercel function handler', () => {
  const createApp = jest.spyOn(appFactory, 'createApp');
  afterAll(() => closeWarmApp());

  it('serves /health through the serverless entry point', async () => {
    const res = await request(vercelHandler).get('/health').expect(200);
    expect(LivenessResponseSchema.parse(res.body).service).toBe('ftms-api');
  });

  it('boots Nest once per warm instance and reuses it across invocations', async () => {
    await request(vercelHandler).get('/health').expect(200);
    await request(vercelHandler).get('/health/ready').expect(200);
    expect(createApp).toHaveBeenCalledTimes(1);
  });
});

describe('API with an unreachable database', () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    // Port 1 on loopback refuses connections immediately.
    app = await boot(testConfig({ DATABASE_URL: 'postgresql://nobody:nothing@127.0.0.1:1/none' }));
  });
  afterAll(async () => {
    await app.close();
  });

  it('still boots and answers liveness', async () => {
    await request(app.getHttpServer()).get('/health').expect(200);
  });

  it('reports not_ready with HTTP 503 and the database down', async () => {
    const res = await request(app.getHttpServer()).get('/health/ready').expect(503);
    const body = ReadinessResponseSchema.parse(res.body);
    expect(body.status).toBe('not_ready');
    expect(body.checks.database.status).toBe('down');
  });
});
