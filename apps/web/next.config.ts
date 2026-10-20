import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { NextConfig } from 'next';

const monorepoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // Pin the workspace root so Turbopack resolves `@ftms/*` packages from the monorepo.
  turbopack: { root: monorepoRoot },
  outputFileTracingRoot: monorepoRoot,
};

export default nextConfig;
