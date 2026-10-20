'use server';

import { type SubmitVerificationResponse } from '@ftms/core';
import { redirect } from 'next/navigation';
import { apiFetch } from '@/lib/api';
import { accessToken } from '@/lib/auth/session';
import { echo, failure, field, type FormState } from '@/lib/forms';

const FIELDS = ['seatNumber', 'firstName', 'fatherName', 'grandfatherName', 'familyName'];

/** (Re)submits identity details; an exact match with an imported record links at once. */
export async function submitVerificationAction(_: FormState, data: FormData): Promise<FormState> {
  const body = Object.fromEntries(FIELDS.map((name) => [name, field(data, name)]));
  const result = await apiFetch<SubmitVerificationResponse>('/me/verification', {
    method: 'POST',
    accessToken: await accessToken(),
    body,
  });
  if (!result.ok) return failure(result, echo(data, FIELDS));
  if (result.data.linked) redirect('/dashboard');
  return { status: 'success' };
}
