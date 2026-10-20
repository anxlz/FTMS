import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { AppConfigService } from '../config/app-config.service';
import { PrismaClient } from '../generated/prisma/client';

/**
 * Small per-instance pool: on Vercel every warm function instance holds its own
 * pool, and Supabase's transaction pooler multiplexes them onto Postgres.
 */
const POOL_MAX_CONNECTIONS = 5;

/**
 * The application's single Prisma client. Connections are opened lazily on the
 * first query, so a database outage never prevents the API from booting — it
 * surfaces as `database: down` on `/health/ready` instead.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleDestroy {
  constructor(config: AppConfigService) {
    super({
      adapter: new PrismaPg({
        connectionString: config.get('DATABASE_URL'),
        max: POOL_MAX_CONNECTIONS,
        connectionTimeoutMillis: 5_000,
      }),
    });
  }

  /** Round-trips a trivial query; throws if the database is unreachable. */
  async ping(): Promise<void> {
    await this.$queryRaw`SELECT 1`;
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
