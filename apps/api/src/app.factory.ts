import { type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { type NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';

/**
 * Response headers for a JSON API that no browser page should embed or render
 * (§17): no sniffing, no framing, nothing loads from a response, no referrer,
 * and nothing is cached unless a handler says otherwise (file downloads set
 * their own). The browser never calls the API directly — the web server does.
 */
export function securityHeaders(
  _req: unknown,
  res: { setHeader(name: string, value: string): void },
  next: () => void,
): void {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-site');
  res.setHeader('Cache-Control', 'no-store');
  if (process.env.NODE_ENV === 'production') {
    res.setHeader('Strict-Transport-Security', 'max-age=63072000; includeSubDomains');
  }
  next();
}

/** Settings shared by every entry point (local server, Vercel function, tests). */
export function configureApp(app: INestApplication): void {
  const express = app.getHttpAdapter().getInstance() as {
    disable(setting: string): void;
    set(setting: string, value: unknown): void;
  };
  express.disable('x-powered-by');
  app.use(securityHeaders);
  // On Vercel the platform overwrites X-Forwarded-For with the real client
  // address, so it can be trusted there (and only there) for `req.ip`.
  if (process.env.VERCEL === '1') express.set('trust proxy', true);
  app.enableShutdownHooks();
}

/** Builds a fully configured (not yet listening) API application. */
export async function createApp(): Promise<NestExpressApplication> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  configureApp(app);
  return app;
}
