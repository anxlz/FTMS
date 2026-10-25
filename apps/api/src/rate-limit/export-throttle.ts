import { Injectable } from '@nestjs/common';
import { Errors } from '../common/api-exception';
import { RateLimiter, rateLimitKey } from './rate-limiter';

/** Downloads per account in one window, across every kind of report (§17). */
export const EXPORT_LIMIT = { limit: 30, windowSeconds: 15 * 60 } as const;

/**
 * Restriction of administrative exports (§17): besides each report's own
 * permissions, an account may produce only so many files in a window — a
 * report holds many students' data, and large PDFs are expensive to render.
 */
@Injectable()
export class ExportThrottle {
  constructor(private readonly limiter: RateLimiter) {}

  async check(userId: string): Promise<void> {
    const state = await this.limiter.hit(
      rateLimitKey('exports-user', userId),
      EXPORT_LIMIT.windowSeconds,
    );
    if (state.count > EXPORT_LIMIT.limit) {
      throw Errors.rateLimited(state.resetInSeconds || EXPORT_LIMIT.windowSeconds);
    }
  }
}
