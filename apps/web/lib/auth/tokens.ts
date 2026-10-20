/**
 * Cookie names and pure helpers shared by the proxy (edge of every request) and
 * server code. Tokens live only in httpOnly cookies on the web origin.
 */
export const ACCESS_COOKIE = 'ftms_at';
export const REFRESH_COOKIE = 'ftms_rt';
/**
 * Set when a signed-out visitor explicitly picks a language. At the next sign-in
 * that choice is saved to the account; without it, the account's saved
 * preference wins (so a shared lab computer never imposes the previous user's
 * language on the next person's profile).
 */
export const LOCALE_CHOSEN_COOKIE = 'ftms_locale_chosen';

/** Refresh this long before the access token actually expires. */
export const REFRESH_MARGIN_SECONDS = 60;

export interface CookieOptions {
  httpOnly: true;
  secure: boolean;
  sameSite: 'lax';
  path: '/';
  expires: Date;
}

export const cookieOptions = (expiresAt: string): CookieOptions => ({
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'lax',
  path: '/',
  expires: new Date(expiresAt),
});

/**
 * Reads `exp` from a JWT without verifying it — only to decide *when* to refresh.
 * Authorization is always decided by the API, which verifies the signature.
 */
export function tokenExpiresAt(token: string): number | null {
  const payload = token.split('.')[1];
  if (!payload) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
      exp?: unknown;
    };
    return typeof claims.exp === 'number' ? claims.exp * 1000 : null;
  } catch {
    return null;
  }
}

export function needsRefresh(accessToken: string | undefined, now = Date.now()): boolean {
  if (!accessToken) return true;
  const exp = tokenExpiresAt(accessToken);
  return exp === null || exp - now <= REFRESH_MARGIN_SECONDS * 1000;
}
