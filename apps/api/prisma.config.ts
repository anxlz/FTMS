import { existsSync } from 'node:fs';
import path from 'node:path';
import { defineConfig } from 'prisma/config';

// Prisma 7 no longer loads `.env` automatically. Load the app-local file first,
// then the repo-root file. Variables already present in the shell (CI, Vercel)
// always win — `process.loadEnvFile` never overwrites an existing value.
for (const file of [path.join(__dirname, '.env'), path.join(__dirname, '..', '..', '.env')]) {
  if (existsSync(file)) process.loadEnvFile(file);
}

export default defineConfig({
  schema: path.join('prisma', 'schema.prisma'),
  migrations: {
    path: path.join('prisma', 'migrations'),
  },
  datasource: {
    // Migrations must use a direct or session-mode connection (Supabase port 5432).
    // The transaction pooler (port 6543) used by the serverless runtime does not
    // support the advisory locks and prepared statements `prisma migrate` needs.
    // Left undefined when neither is set so `prisma generate` still works offline.
    url: process.env.DIRECT_URL || process.env.DATABASE_URL || undefined,
  },
});
