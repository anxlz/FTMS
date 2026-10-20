'use server';

import {
  type AcceptedResponse,
  type AuthResponse,
  isLocale,
  LOCALE_COOKIE,
  type SignupResponse,
} from '@ftms/core';
import { revalidatePath } from 'next/cache';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { apiFetch } from '../api';
import { echo, failure, field, type FormState, passwordsMismatch } from '../forms';
import { accessToken, clearSession, homeFor, LOCALE_COOKIE_OPTIONS, storeSession } from './session';
import { LOCALE_CHOSEN_COOKIE } from './tokens';

/** Email or seat number + password (§4.3). */
export async function loginAction(_: FormState, data: FormData): Promise<FormState> {
  const result = await apiFetch<AuthResponse>('/auth/login', {
    method: 'POST',
    body: { identifier: field(data, 'identifier'), password: field(data, 'password') },
  });
  if (!result.ok) return failure(result, echo(data, ['identifier']));
  await storeSession(result.data);
  redirect(homeFor(result.data.user));
}

/** First login, step 1: email a one-time code. */
export async function requestCodeAction(_: FormState, data: FormData): Promise<FormState> {
  const email = field(data, 'email');
  const result = await apiFetch<AcceptedResponse>('/auth/code/request', {
    method: 'POST',
    body: { email },
  });
  if (!result.ok) return failure(result, { email });
  return { status: 'success', step: 'code', email: email.trim().toLowerCase() };
}

/** First login, step 2: verify the code, then go set a password. */
export async function verifyCodeAction(_: FormState, data: FormData): Promise<FormState> {
  const email = field(data, 'email');
  const result = await apiFetch<AuthResponse>('/auth/code/verify', {
    method: 'POST',
    body: { email, code: field(data, 'code') },
  });
  if (!result.ok) return { ...failure(result), step: 'code', email };
  await storeSession(result.data);
  redirect(homeFor(result.data.user));
}

const SIGNUP_FIELDS = [
  'email',
  'seatNumber',
  'firstName',
  'fatherName',
  'grandfatherName',
  'familyName',
] as const;

const signupBody = (data: FormData) =>
  Object.fromEntries(SIGNUP_FIELDS.map((name) => [name, field(data, name)]));

/** Student signup (§4.2), step 1: details, then a code to the university email. */
export async function signupRequestAction(_: FormState, data: FormData): Promise<FormState> {
  const body = signupBody(data);
  const result = await apiFetch<AcceptedResponse>('/auth/signup/request', {
    method: 'POST',
    body,
  });
  if (!result.ok) return failure(result, body);
  return { status: 'success', step: 'code', email: body.email!.trim().toLowerCase(), values: body };
}

/** Signup, step 2: the code. Linked accounts and pending ones both set a password next. */
export async function signupVerifyAction(_: FormState, data: FormData): Promise<FormState> {
  const body = signupBody(data);
  const result = await apiFetch<SignupResponse>('/auth/signup/verify', {
    method: 'POST',
    body: { ...body, code: field(data, 'code') },
  });
  if (!result.ok) return { ...failure(result, body), step: 'code', email: body.email };
  await storeSession(result.data);
  redirect(homeFor(result.data.user));
}

export async function forgotPasswordAction(_: FormState, data: FormData): Promise<FormState> {
  const email = field(data, 'email');
  const result = await apiFetch<AcceptedResponse>('/auth/password/forgot', {
    method: 'POST',
    body: { email },
  });
  if (!result.ok) return failure(result, { email });
  return { status: 'success', step: 'code', email: email.trim().toLowerCase() };
}

export async function resetPasswordAction(_: FormState, data: FormData): Promise<FormState> {
  const email = field(data, 'email');
  if (field(data, 'newPassword') !== field(data, 'confirmPassword')) {
    return { ...passwordsMismatch(), step: 'code', email };
  }
  const result = await apiFetch<void>('/auth/password/reset', {
    method: 'POST',
    body: { email, code: field(data, 'code'), newPassword: field(data, 'newPassword') },
  });
  if (!result.ok) return { ...failure(result), step: 'code', email };
  return { status: 'success', step: 'done' };
}

/**
 * Sets the first password, replaces a temporary one, or changes it from the
 * profile. `next` decides where to go afterwards (only internal paths).
 */
export async function changePasswordAction(_: FormState, data: FormData): Promise<FormState> {
  if (field(data, 'newPassword') !== field(data, 'confirmPassword')) return passwordsMismatch();
  const current = field(data, 'currentPassword');
  const result = await apiFetch<void>('/auth/password/change', {
    method: 'POST',
    accessToken: await accessToken(),
    body: {
      newPassword: field(data, 'newPassword'),
      ...(current ? { currentPassword: current } : {}),
    },
  });
  if (!result.ok) {
    if (result.code === 'AUTH_REQUIRED') redirect('/login');
    return failure(result);
  }
  const next = field(data, 'next');
  if (next === '/dashboard') redirect('/dashboard');
  return { status: 'success' };
}

export async function logoutAction(): Promise<void> {
  const token = await accessToken();
  if (token) await apiFetch<void>('/auth/logout', { method: 'POST', accessToken: token });
  await clearSession();
  redirect('/login');
}

/**
 * Language switcher. Signed in: saved to the account. Signed out: remembered for
 * this browser and, if the visitor then signs in, saved to their account.
 */
export async function setLocaleAction(data: FormData): Promise<void> {
  const locale = field(data, 'locale');
  if (!isLocale(locale)) return;
  const store = await cookies();
  store.set(LOCALE_COOKIE, locale, LOCALE_COOKIE_OPTIONS);
  const token = await accessToken();
  if (token) {
    await apiFetch('/auth/me/preferences', {
      method: 'PATCH',
      accessToken: token,
      body: { preferredLocale: locale },
    });
  } else {
    store.set(LOCALE_CHOSEN_COOKIE, '1', { path: '/', sameSite: 'lax', httpOnly: true });
  }
  revalidatePath('/', 'layout');
}
