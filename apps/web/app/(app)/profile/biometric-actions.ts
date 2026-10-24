'use server';

import { type BiometricCredential, type WebAuthnOptionsResponse } from '@ftms/core';
import { revalidatePath } from 'next/cache';
import { apiFetch } from '@/lib/api';
import { type CeremonyStart } from '@/lib/auth/actions';
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

/** Takes effect at once: the device can no longer sign in or confirm check-ins. */
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
