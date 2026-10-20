import 'server-only';
import {
  type AuthResponse,
  isLocale,
  type Locale,
  LOCALE_COOKIE,
  type MeResponse,
  MeResponseSchema,
} from '@ftms/core';
import { cookies } from 'next/headers';
import { notFound, redirect } from 'next/navigation';
import { cache } from 'react';
import { apiFetch } from '../api';
import { ACCESS_COOKIE, cookieOptions, LOCALE_CHOSEN_COOKIE, REFRESH_COOKIE } from './tokens';

/**
 * Stores a fresh token pair and settles the UI language: a choice the visitor
 * made on the sign-in pages is saved to the account; otherwise the account's
 * saved preference is applied.
 */
export async function storeSession(auth: AuthResponse): Promise<void> {
  const store = await cookies();
  store.set(ACCESS_COOKIE, auth.accessToken, cookieOptions(auth.accessTokenExpiresAt));
  store.set(REFRESH_COOKIE, auth.refreshToken, cookieOptions(auth.refreshTokenExpiresAt));

  const chosen =
    store.get(LOCALE_CHOSEN_COOKIE)?.value === '1' ? store.get(LOCALE_COOKIE)?.value : undefined;
  let locale: Locale = auth.user.preferredLocale;
  if (isLocale(chosen) && chosen !== auth.user.preferredLocale) {
    const saved = await apiFetch('/auth/me/preferences', {
      method: 'PATCH',
      accessToken: auth.accessToken,
      body: { preferredLocale: chosen },
    });
    if (saved.ok) locale = chosen;
  }
  store.delete(LOCALE_CHOSEN_COOKIE);
  store.set(LOCALE_COOKIE, locale, LOCALE_COOKIE_OPTIONS);
}

export const LOCALE_COOKIE_OPTIONS = {
  path: '/',
  sameSite: 'lax',
  maxAge: 60 * 60 * 24 * 365,
} as const;

export async function clearSession(): Promise<void> {
  const store = await cookies();
  store.delete(ACCESS_COOKIE);
  store.delete(REFRESH_COOKIE);
  store.delete(LOCALE_CHOSEN_COOKIE);
}

export async function accessToken(): Promise<string | null> {
  return (await cookies()).get(ACCESS_COOKIE)?.value ?? null;
}

/** The signed-in account, or null. Memoized for the duration of one request. */
export const currentUser = cache(async (): Promise<MeResponse | null> => {
  const token = await accessToken();
  if (!token) return null;
  const res = await apiFetch<unknown>('/auth/me', { accessToken: token });
  if (!res.ok) return null;
  const parsed = MeResponseSchema.safeParse(res.data);
  return parsed.success ? parsed.data : null;
});

/**
 * For pages inside the app shell: signed in, past any required password step,
 * and verified (a student waiting for review only sees /verification, §4.2).
 */
export async function requireUser(): Promise<MeResponse> {
  const user = await currentUser();
  if (!user) redirect('/login');
  if (user.passwordSetupRequired) redirect('/set-password');
  if (user.status === 'PENDING_VERIFICATION') redirect('/verification');
  return user;
}

/** Where a freshly signed-in account goes next. */
export const homeFor = (user: Pick<MeResponse, 'passwordSetupRequired' | 'status'>): string =>
  user.passwordSetupRequired
    ? '/set-password'
    : user.status === 'PENDING_VERIFICATION'
      ? '/verification'
      : '/dashboard';

/** Pages that call `requireUser` and need a permission answer 404 without it. */
export async function requirePermission(...anyOf: MeResponse['permissions']): Promise<MeResponse> {
  const user = await requireUser();
  if (!anyOf.some((p) => user.permissions.includes(p))) notFound();
  return user;
}
