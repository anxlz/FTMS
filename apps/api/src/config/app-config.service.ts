import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { type Env } from './env';

/** Typed, read-only access to the validated environment. */
@Injectable()
export class AppConfigService {
  constructor(private readonly config: ConfigService<Env, true>) {}

  get<K extends keyof Env>(key: K): Env[K] {
    return this.config.get(key, { infer: true });
  }

  get isProduction(): boolean {
    return this.get('NODE_ENV') === 'production';
  }
}
