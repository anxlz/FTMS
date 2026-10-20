import { Injectable, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { AppConfigService } from '../config/app-config.service';
import { type RequestContext, resolveClientIp } from './request-context';

/** Resolves the client IP and user agent once per request (see `resolveClientIp`). */
@Injectable()
export class RequestContextMiddleware implements NestMiddleware {
  constructor(private readonly config: AppConfigService) {}

  use(req: Request & { ftmsContext?: RequestContext }, _res: Response, next: NextFunction): void {
    const ua = req.headers['user-agent'];
    req.ftmsContext = {
      ip: resolveClientIp(req, this.config.get('BFF_SHARED_SECRET')),
      userAgent: typeof ua === 'string' ? ua.slice(0, 512) : null,
    };
    next();
  }
}
