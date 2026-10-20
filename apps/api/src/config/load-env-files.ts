import { existsSync } from 'node:fs';
import path from 'node:path';

/**
 * Loads `apps/api/.env` and then the repo-root `.env` into `process.env` for local
 * development. Values already present in the environment (shell, CI, Vercel)
 * always take precedence: `process.loadEnvFile` never overwrites them.
 *
 * Paths are resolved from this file's location so the result does not depend on
 * the current working directory (`pnpm --filter`, turbo, or a direct `node` call).
 */
export function loadEnvFiles(): string[] {
  const apiRoot = path.resolve(__dirname, '..', '..');
  const candidates = [path.join(apiRoot, '.env'), path.join(apiRoot, '..', '..', '.env')];
  const loaded: string[] = [];
  for (const file of candidates) {
    if (existsSync(file)) {
      process.loadEnvFile(file);
      loaded.push(file);
    }
  }
  return loaded;
}
