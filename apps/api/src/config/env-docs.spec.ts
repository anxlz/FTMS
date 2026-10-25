import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EnvObjectSchema, PRODUCTION_REQUIRED } from './env';

/**
 * The validated settings, both `.env.example` files and docs/environment.md
 * name the same variables (§22: environment-variable documentation).
 */
const ROOT = join(__dirname, '..', '..', '..', '..');
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');
const apiExample = read('.env.example');
const webExample = read('apps/web/.env.example');
const docs = read('docs/environment.md');

/** `KEY=` lines, commented-out ones included. */
const exampleKeys = (text: string) =>
  [...text.matchAll(/^#?\s?([A-Z][A-Z0-9_]+)=/gm)].map((m) => m[1]!);
/** The documentation table row of a variable. */
const row = (key: string) => docs.split('\n').find((line) => line.startsWith(`| \`${key}\``));

const SCHEMA_KEYS = Object.keys(EnvObjectSchema.shape);
const WEB_KEYS = ['NEXT_PUBLIC_API_URL', 'API_URL', 'BFF_SHARED_SECRET'];
const ALWAYS = ['DATABASE_URL', 'JWT_ACCESS_SECRET', 'JWT_REFRESH_SECRET'];

describe('environment documentation', () => {
  it('lists every validated API variable in .env.example and in the docs', () => {
    const inExample = exampleKeys(apiExample);
    for (const key of SCHEMA_KEYS) {
      expect([key, inExample.includes(key)]).toEqual([key, true]);
      expect([key, row(key) !== undefined]).toEqual([key, true]);
    }
  });

  it('lists every web variable in apps/web/.env.example and in the docs', () => {
    const inExample = exampleKeys(webExample);
    for (const key of WEB_KEYS) {
      expect([key, inExample.includes(key)]).toEqual([key, true]);
      expect([key, row(key) !== undefined]).toEqual([key, true]);
    }
  });

  it('documents every variable either example file mentions', () => {
    for (const key of [...exampleKeys(apiExample), ...exampleKeys(webExample)]) {
      expect([key, row(key) !== undefined]).toEqual([key, true]);
    }
  });

  it('states the same requirement level as the validation', () => {
    for (const key of PRODUCTION_REQUIRED) {
      expect([key, row(key)?.split('|')[2]?.trim()]).toEqual([key, 'Production']);
    }
    for (const key of ALWAYS) {
      expect([key, row(key)?.split('|')[2]?.trim()]).toEqual([key, 'Always']);
    }
  });

  it('gives no example file a value for any secret', () => {
    for (const text of [apiExample, webExample]) {
      for (const m of text.matchAll(/^([A-Z0-9_]*(?:SECRET|PASS|TOKEN|KEY))=(.*)$/gm)) {
        expect([m[1], m[2]!.trim()]).toEqual([m[1], '']);
      }
    }
  });
});
