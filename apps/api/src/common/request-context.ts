import { isIP } from 'node:net';
import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import { safeEqual } from './crypto';

/** Headers the web app (BFF) uses to pass the real browser IP to the API. */
export const CLIENT_IP_HEADER = 'x-ftms-client-ip';
export const PROXY_KEY_HEADER = 'x-ftms-proxy-key';

export interface RequestContext {
  ip: string | null;
  userAgent: string | null;
}

const header = (req: Request, name: string): string | undefined => {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
};

/**
 * The client IP used for rate limiting and audit records. A forwarded IP is only
 * trusted when the request proves it came from our own web server by carrying
 * the shared secret; otherwise the connection's address is used (on Vercel,
 * Express `trust proxy` makes that the platform-verified client address).
 */
export function resolveClientIp(req: Request, bffSecret: string | undefined): string | null {
  if (bffSecret) {
    const key = header(req, PROXY_KEY_HEADER);
    const forwarded = header(req, CLIENT_IP_HEADER)?.trim();
    if (key && forwarded && safeEqual(key, bffSecret) && isIP(forwarded) !== 0) return forwarded;
  }
  return req.ip ?? null;
}

export const Ctx = createParamDecorator((_: unknown, context: ExecutionContext): RequestContext => {
  const req = context.switchToHttp().getRequest<Request & { ftmsContext?: RequestContext }>();
  return req.ftmsContext ?? { ip: req.ip ?? null, userAgent: header(req, 'user-agent') ?? null };
});
