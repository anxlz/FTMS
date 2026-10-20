import { type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { type NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';

/** Settings shared by every entry point (local server, Vercel function, tests). */
export function configureApp(app: INestApplication): void {
  const express = app.getHttpAdapter().getInstance() as { disable(setting: string): void };
  express.disable('x-powered-by');
  app.enableShutdownHooks();
}

/** Builds a fully configured (not yet listening) API application. */
export async function createApp(): Promise<NestExpressApplication> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  configureApp(app);
  return app;
}
