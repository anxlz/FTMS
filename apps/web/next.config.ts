import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { NextConfig } from 'next';
import createNextIntlPlugin from 'next-intl/plugin';

const monorepoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const withNextIntl = createNextIntlPlugin('./i18n/request.ts');

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // Pin the workspace root so Turbopack resolves `@ftms/*` packages from the monorepo.
  turbopack: { root: monorepoRoot },
  outputFileTracingRoot: monorepoRoot,
  experimental: {
    // Student spreadsheets go through a server action (§4.1). The API accepts up to
    // 4 MB (Vercel limits function bodies to 4.5 MB); allow the multipart overhead.
    serverActions: { bodySizeLimit: '5mb' },
  },
};

export default withNextIntl(nextConfig);
