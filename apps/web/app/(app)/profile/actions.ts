'use server';

import { revalidatePath } from 'next/cache';
import { apiFetch } from '@/lib/api';
import { accessToken } from '@/lib/auth/session';
import { echo, failure, field, type FormState } from '@/lib/forms';

const PROTECTED = ['seatNumber', 'firstName', 'fatherName', 'grandfatherName', 'familyName'];

/** Permitted self-service field (§4.4). */
export async function updatePhoneAction(_: FormState, data: FormData): Promise<FormState> {
  const result = await apiFetch('/me/student', {
    method: 'PATCH',
    accessToken: await accessToken(),
    body: { phone: field(data, 'phone').trim() || null },
  });
  if (!result.ok) return failure(result, echo(data, ['phone']));
  revalidatePath('/profile');
  return { status: 'success' };
}

/**
 * Protected fields: only the fields the student changed are sent, as a request
 * for faculty approval (§4.4). Unchanged fields keep their current value.
 */
export async function submitProfileChangeAction(_: FormState, data: FormData): Promise<FormState> {
  const body: Record<string, string> = { note: field(data, 'note') };
  for (const name of PROTECTED) {
    const value = field(data, name).trim();
    if (value !== field(data, `current.${name}`).trim() && value !== '') body[name] = value;
  }
  const result = await apiFetch('/me/profile-changes', {
    method: 'POST',
    accessToken: await accessToken(),
    body,
  });
  if (!result.ok) return failure(result, echo(data, [...PROTECTED, 'note']));
  revalidatePath('/profile');
  return { status: 'success' };
}

export async function cancelProfileChangeAction(_: FormState, data: FormData): Promise<FormState> {
  const id = field(data, 'id');
  const result = await apiFetch(`/me/profile-changes/${encodeURIComponent(id)}/cancel`, {
    method: 'POST',
    accessToken: await accessToken(),
  });
  if (!result.ok) return failure(result);
  revalidatePath('/profile');
  return { status: 'success' };
}
