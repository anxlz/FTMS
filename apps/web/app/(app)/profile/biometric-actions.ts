'use server';

import {
  type BiometricCredential,
  type DeviceKeyChallenge,
  type WebAuthnOptionsResponse,
} from '@ftms/core';
import { revalidatePath } from 'next/cache';
import { apiFetch } from '@/lib/api';
import { type CeremonyStart, type DeviceChallengeStart } from '@/lib/auth/actions';
import { accessToken } from '@/lib/auth/session';
import { failure, field, type FormState, optional } from '@/lib/forms';

/** Enrollment, step 1 (§4.5): only after a password or email-code sign-in. */
export async function registrationOptionsAction(): Promise<CeremonyStart> {
  const result = await apiFetch<WebAuthnOptionsResponse>('/auth/biometric/credentials/options', {
    method: 'POST',
    accessToken: await accessToken(),
  });
  if (!result.ok) return { ok: false, error: result.code };
  return { ok: true, challengeId: result.data.challengeId, options: result.data.options };
}

/** Step 2: the device's new public key, under a name the student recognizes. */
export async function registerDeviceAction(input: {
  challengeId: string;
  name: string;
  response: unknown;
}): Promise<FormState> {
  const result = await apiFetch<BiometricCredential>('/auth/biometric/credentials', {
    method: 'POST',
    accessToken: await accessToken(),
    body: input,
  });
  if (!result.ok) return failure(result, { name: input.name });
  revalidatePath('/profile');
  return { status: 'success' };
}

/** Takes effect at once: the device can no longer sign in, and the sessions it opened end. */
export async function revokeDeviceAction(_: FormState, data: FormData): Promise<FormState> {
  const id = field(data, 'id');
  const result = await apiFetch<void>(`/auth/biometric/credentials/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    accessToken: await accessToken(),
    body: { reason: optional(data, 'reason') },
  });
  if (!result.ok) return failure(result);
  revalidatePath('/profile');
  return { status: 'success' };
}

/* ── Android app: biometric sign-in with a Keystore key (Phase 8) ── */

/** Turning it on, step 1: a challenge the new key must sign. After a password or code sign-in only. */
export async function deviceRegistrationOptionsAction(): Promise<DeviceChallengeStart> {
  const result = await apiFetch<DeviceKeyChallenge>('/auth/biometric/device/options', {
    method: 'POST',
    accessToken: await accessToken(),
  });
  if (!result.ok) return { ok: false, error: result.code };
  return { ok: true, challengeId: result.data.challengeId, challenge: result.data.challenge };
}

export type DeviceKeyRegistration =
  { ok: true; credentialId: string } | { ok: false; error: string };

/** Step 2: the public key and its signature over the challenge. */
export async function registerDeviceKeyAction(input: {
  challengeId: string;
  publicKey: string;
  signature: string;
  name: string;
}): Promise<DeviceKeyRegistration> {
  const result = await apiFetch<BiometricCredential>('/auth/biometric/device', {
    method: 'POST',
    accessToken: await accessToken(),
    body: input,
  });
  if (!result.ok) return { ok: false, error: result.code };
  revalidatePath('/profile');
  return { ok: true, credentialId: result.data.credentialId };
}

export type Revocation = { ok: true } | { ok: false; error: string; network: boolean };

/**
 * Turning it off: the server revokes the credential at once (and ends the sessions
 * it opened). "Already gone" counts as done; a network failure is reported as such.
 */
export async function revokeCredentialAction(id: string): Promise<Revocation> {
  const result = await apiFetch<void>(`/auth/biometric/credentials/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    accessToken: await accessToken(),
    body: { reason: 'Turned off on this device' },
  });
  revalidatePath('/profile');
  if (result.ok || result.code === 'NOT_FOUND') return { ok: true };
  return { ok: false, error: result.code, network: result.code === 'NETWORK' };
}
