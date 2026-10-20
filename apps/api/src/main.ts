import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { createApp } from './app.factory';
import { AppConfigService } from './config/app-config.service';

/** Long-running server for local development and `pnpm start`. Vercel uses `vercel.ts`. */
async function bootstrap(): Promise<void> {
  const app = await createApp();
  const port = app.get(AppConfigService).get('PORT');
  await app.listen(port);
  Logger.log(`FTMS API listening on http://localhost:${port}`, 'Bootstrap');
}

void bootstrap();
