import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { NextConfig } from 'next';
import createNextIntlPlugin from 'next-intl/plugin';
import { HSTS_HEADER, STATIC_SECURITY_HEADERS } from './lib/security-headers';

const monorepoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const withNextIntl = createNextIntlPlugin('./i18n/request.ts');

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // Pin the workspace root so Turbopack resolves `@ftms/*` packages from the monorepo.
  turbopack: { root: monorepoRoot },
  outputFileTracingRoot: monorepoRoot,
  // Security headers on every response, static assets included (§17). The CSP
  // carries a per-request nonce and is set by the proxy (`proxy.ts`).
  headers: () =>
    Promise.resolve([
      {
        source: '/:path*',
        headers: [
          ...STATIC_SECURITY_HEADERS,
          ...(process.env.NODE_ENV === 'production' ? [HSTS_HEADER] : []),
        ],
      },
    ]),
  experimental: {
    // Student spreadsheets go through a server action (§4.1). The API accepts up to
    // 4 MB (Vercel limits function bodies to 4.5 MB); allow the multipart overhead.
    serverActions: { bodySizeLimit: '5mb' },
  },
};

export default withNextIntl(nextConfig);
