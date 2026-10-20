import { Injectable } from '@nestjs/common';
import { Redis } from '@upstash/redis';
import { ServiceNotConfiguredError } from '../common/errors';
import { AppConfigService } from '../config/app-config.service';

/**
 * Upstash Redis over its REST API — connectionless, so it works from serverless
 * functions without pooling. Used from Phase 1 for OTP/login rate limiting,
 * permission lookups and dashboard aggregate caching.
 */
@Injectable()
export class RedisService {
  private readonly client: Redis | null;

  constructor(config: AppConfigService) {
    const url = config.get('UPSTASH_REDIS_REST_URL');
    const token = config.get('UPSTASH_REDIS_REST_TOKEN');
    this.client =
      url && token
        ? new Redis({
            url,
            token,
            enableTelemetry: false,
            retry: { retries: 2, backoff: (attempt) => 50 * 2 ** attempt },
          })
        : null;
  }

  get isConfigured(): boolean {
    return this.client !== null;
  }

  /** The Upstash client. Throws `ServiceNotConfiguredError` when credentials are absent. */
  get redis(): Redis {
    if (!this.client) throw new ServiceNotConfiguredError('Upstash Redis');
    return this.client;
  }

  /** Sends PING; resolves only on the expected `PONG` reply. */
  async ping(): Promise<void> {
    const reply = await this.redis.ping();
    if (reply !== 'PONG') throw new Error(`Unexpected PING reply: ${String(reply)}`);
  }
}
