import { Global, Logger, Module } from '@nestjs/common';
import { RedisService } from '../redis/redis.service';
import { MemoryRateLimiter, RateLimiter, UpstashRateLimiter } from './rate-limiter';

@Global()
@Module({
  providers: [
    {
      provide: RateLimiter,
      inject: [RedisService],
      useFactory: (redis: RedisService): RateLimiter => {
        if (redis.isConfigured) return new UpstashRateLimiter(redis.redis);
        new Logger('RateLimiter').warn(
          'Upstash Redis is not configured: using an in-memory rate limiter (development only).',
        );
        return new MemoryRateLimiter();
      },
    },
  ],
  exports: [RateLimiter],
})
export class RateLimitModule {}
