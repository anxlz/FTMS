import 'reflect-metadata';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { type INestApplication } from '@nestjs/common';
import { createApp } from './app.factory';

type RequestListener = (req: IncomingMessage, res: ServerResponse) => void;

interface WarmApp {
  app: INestApplication;
  listener: RequestListener;
}

let warm: Promise<WarmApp> | undefined;

/**
 * Creates the Nest application once per warm function instance and reuses it for
 * later invocations. A failed boot is not cached, so the next request retries
 * instead of the instance staying broken until it is recycled.
 */
function getWarmApp(): Promise<WarmApp> {
  warm ??= createApp()
    .then(async (app) => {
      await app.init();
      return { app, listener: app.getHttpAdapter().getInstance() as RequestListener };
    })
    .catch((error: unknown) => {
      warm = undefined;
      throw error;
    });
  return warm;
}

/**
 * Vercel Node.js function handler: `@nestjs/platform-express` wrapped for Vercel's
 * Node runtime (§2). `apps/api/api/index.js` re-exports this from `dist/`.
 */
export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const { listener } = await getWarmApp();
  listener(req, res);
}

/** Closes the cached application (database pool included). Used by tests. */
export async function closeWarmApp(): Promise<void> {
  const current = warm;
  warm = undefined;
  if (current) await (await current).app.close();
}
