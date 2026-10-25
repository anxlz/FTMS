import { Logger } from '@nestjs/common';
import { type Redis } from '@upstash/redis';
import { Errors } from '../common/api-exception';
import { sha256Hex } from '../common/crypto';

export interface RateLimitState {
  /** Hits counted in the current window (after this call, for `hit`). */
  count: number;
  /** Seconds until the window resets (0 when there is no window). */
  resetInSeconds: number;
}

/**
 * Fixed-window counters keyed by an opaque subject. Callers decide what counts
 * as a hit (e.g. only failed logins) and what the limit is.
 */
export abstract class RateLimiter {
  /** Increments the counter, opening a new window of `windowSeconds` if none is active. */
  abstract hit(key: string, windowSeconds: number): Promise<RateLimitState>;
  /** Reads the counter without changing it. */
  abstract peek(key: string): Promise<RateLimitState>;
  abstract reset(key: string): Promise<void>;
}

/**
 * Builds a counter key. Subjects (emails, seat numbers, IPs) are hashed so no
 * personal data is stored in Redis.
 */
export const rateLimitKey = (bucket: string, subject: string): string =>
  `ftms:rl:${bucket}:${sha256Hex(subject.toLowerCase())}`;

/**
 * Production limiter on Upstash Redis — shared by every serverless instance.
 * It fails closed: if Redis cannot be reached, the limited action is refused
 * with 503 SERVICE_UNAVAILABLE (never let through unlimited, never a bare 500).
 */
export class UpstashRateLimiter extends RateLimiter {
  private readonly logger = new Logger('RateLimiter');

  constructor(private readonly redis: Redis) {
    super();
  }

  private async guard<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      this.logger.error(`Redis unavailable: ${error instanceof Error ? error.message : 'unknown'}`);
      throw Errors.serviceUnavailable();
    }
  }

  hit(key: string, windowSeconds: number): Promise<RateLimitState> {
    return this.guard(async () => {
      // One atomic MULTI/EXEC round trip: open the window if absent, count, read TTL.
      const tx = this.redis.multi();
      tx.set(key, 0, { nx: true, ex: windowSeconds });
      tx.incr(key);
      tx.ttl(key);
      const [, count, ttl] = await tx.exec<[unknown, number, number]>();
      return { count: Number(count), resetInSeconds: Math.max(0, Number(ttl)) };
    });
  }

  peek(key: string): Promise<RateLimitState> {
    return this.guard(async () => {
      const pipe = this.redis.pipeline();
      pipe.get(key);
      pipe.ttl(key);
      const [count, ttl] = await pipe.exec<[number | string | null, number]>();
      return { count: Number(count ?? 0), resetInSeconds: Math.max(0, Number(ttl)) };
    });
  }

  reset(key: string): Promise<void> {
    return this.guard(async () => {
      await this.redis.del(key);
    });
  }
}

/**
 * Per-process limiter for local development and tests when Upstash is not
 * configured. Not shared between serverless instances — production refuses to
 * start without Upstash credentials, so it is never used there.
 */
export class MemoryRateLimiter extends RateLimiter {
  private readonly windows = new Map<string, { count: number; resetAt: number }>();

  constructor(private readonly now: () => number = Date.now) {
    super();
  }

  private live(key: string) {
    const entry = this.windows.get(key);
    if (entry && entry.resetAt <= this.now()) {
      this.windows.delete(key);
      return undefined;
    }
    return entry;
  }

  private state(entry: { count: number; resetAt: number } | undefined): RateLimitState {
    if (!entry) return { count: 0, resetInSeconds: 0 };
    return { count: entry.count, resetInSeconds: Math.ceil((entry.resetAt - this.now()) / 1000) };
  }

  hit(key: string, windowSeconds: number): Promise<RateLimitState> {
    const entry = this.live(key) ?? { count: 0, resetAt: this.now() + windowSeconds * 1000 };
    entry.count += 1;
    this.windows.set(key, entry);
    return Promise.resolve(this.state(entry));
  }

  peek(key: string): Promise<RateLimitState> {
    return Promise.resolve(this.state(this.live(key)));
  }

  reset(key: string): Promise<void> {
    this.windows.delete(key);
    return Promise.resolve();
  }

  /** Forgets every counter (test isolation). */
  clear(): void {
    this.windows.clear();
  }
}
