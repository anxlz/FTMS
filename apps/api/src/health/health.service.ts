import { Injectable, Logger } from '@nestjs/common';
import {
  aggregateReadiness,
  API_SERVICE_NAME,
  type DependencyCheck,
  type LivenessResponse,
  type ReadinessResponse,
} from '@ftms/core';
import { withTimeout } from '../common/errors';
import { AppConfigService } from '../config/app-config.service';
import { MailService } from '../mail/mail.service';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { StorageService } from '../storage/storage.service';
import { apiVersion } from '../version';

/** Each dependency probe must answer within this budget. */
export const PROBE_TIMEOUT_MS = 3_000;

@Injectable()
export class HealthService {
  private readonly logger = new Logger(HealthService.name);

  constructor(
    private readonly config: AppConfigService,
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly storage: StorageService,
    private readonly mail: MailService,
  ) {}

  liveness(): LivenessResponse {
    return {
      status: 'ok',
      service: API_SERVICE_NAME,
      version: apiVersion(),
      timestamp: new Date().toISOString(),
      uptimeSeconds: Math.round(process.uptime() * 10) / 10,
    };
  }

  async readiness(): Promise<ReadinessResponse> {
    const [database, redis, storage, mail] = await Promise.all([
      this.probe('database', () => this.prisma.ping()),
      this.redis.isConfigured
        ? this.probe('redis', () => this.redis.ping())
        : notConfigured('UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN not set'),
      this.storage.isConfigured
        ? this.probe('storage', () => this.checkBuckets())
        : notConfigured('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set'),
      this.mail.mode === 'smtp'
        ? this.probe('mail', () => this.mail.verifyCached())
        : notConfigured('SMTP_PASS not set — emails are logged, not sent'),
    ]);
    const checks = { database, redis, storage, mail };

    return {
      status: aggregateReadiness(checks, { production: this.config.isProduction }),
      service: API_SERVICE_NAME,
      timestamp: new Date().toISOString(),
      checks,
    };
  }

  private async checkBuckets(): Promise<void> {
    const { missing, public: exposed } = await this.storage.verifyBuckets();
    const problems = [
      missing.length > 0
        ? `missing buckets: ${missing.join(', ')} (run pnpm storage:provision)`
        : '',
      exposed.length > 0 ? `PUBLIC buckets (must be private): ${exposed.join(', ')}` : '',
    ].filter(Boolean);
    if (problems.length > 0) throw new Error(problems.join('; '));
  }

  private async probe(name: string, run: () => Promise<void>): Promise<DependencyCheck> {
    const started = performance.now();
    const elapsed = () => Math.round(performance.now() - started);
    try {
      await withTimeout(run(), PROBE_TIMEOUT_MS, `${name} probe`);
      return { status: 'up', latencyMs: elapsed() };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`${name} readiness probe failed: ${message}`);
      // Failure details stay in server logs in production; they can reveal infrastructure.
      return {
        status: 'down',
        latencyMs: elapsed(),
        ...(this.config.isProduction ? {} : { detail: message }),
      };
    }
  }
}

function notConfigured(detail: string): DependencyCheck {
  return { status: 'not_configured', detail };
}
