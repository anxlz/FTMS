import { type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { type NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';

/** Settings shared by every entry point (local server, Vercel function, tests). */
export function configureApp(app: INestApplication): void {
  const express = app.getHttpAdapter().getInstance() as {
    disable(setting: string): void;
    set(setting: string, value: unknown): void;
  };
  express.disable('x-powered-by');
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
