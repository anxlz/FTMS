import { type AuthResponse, AuthResponseSchema } from '@ftms/core';
import { type NextRequest, NextResponse } from 'next/server';
import { ACCESS_COOKIE, cookieOptions, needsRefresh, REFRESH_COOKIE } from './lib/auth/tokens';

/**
 * Runs before every page render: when the short-lived access token is missing or
 * about to expire and a refresh token exists, rotates the pair with the API so the
 * page renders with a valid session. Pages themselves decide who may see them.
 */
export async function proxy(request: NextRequest): Promise<NextResponse> {
  const refreshToken = request.cookies.get(REFRESH_COOKIE)?.value;
  if (!refreshToken || !needsRefresh(request.cookies.get(ACCESS_COOKIE)?.value)) {
    return NextResponse.next();
  }

  const refreshed = await refresh(refreshToken, request);
  if (!refreshed) {
    // The session is gone (expired, revoked, or reused): drop both cookies.
    const response = NextResponse.next();
    response.cookies.delete(ACCESS_COOKIE);
    response.cookies.delete(REFRESH_COOKIE);
    return response;
  }

  // Let this request's server components see the new access token…
  request.cookies.set(ACCESS_COOKIE, refreshed.accessToken);
  request.cookies.set(REFRESH_COOKIE, refreshed.refreshToken);
  const response = NextResponse.next({ request: { headers: request.headers } });
  // …and the browser keep it.
  response.cookies.set(
    ACCESS_COOKIE,
    refreshed.accessToken,
    cookieOptions(refreshed.accessTokenExpiresAt),
  );
  response.cookies.set(
    REFRESH_COOKIE,
    refreshed.refreshToken,
    cookieOptions(refreshed.refreshTokenExpiresAt),
  );
  return response;
}

async function refresh(refreshToken: string, request: NextRequest): Promise<AuthResponse | null> {
  const base = (process.env['API_URL'] ?? process.env['NEXT_PUBLIC_API_URL'])
    ?.trim()
    .replace(/\/+$/, '');
  if (!base) return null;
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  const secret = process.env.BFF_SHARED_SECRET;
  if (ip && secret) {
    headers['x-ftms-client-ip'] = ip;
    headers['x-ftms-proxy-key'] = secret;
  }
  try {
    const res = await fetch(`${base}/auth/refresh`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ refreshToken }),
      cache: 'no-store',
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) return null;
    const parsed = AuthResponseSchema.safeParse(await res.json());
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export const config = {
  // Pages only: skip Next internals, metadata files and static assets.
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|icon.png|apple-icon.png|manifest.webmanifest|icons/|brand/|robots.txt).*)',
  ],
};
