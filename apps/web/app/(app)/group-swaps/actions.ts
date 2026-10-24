'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { apiFetch } from '@/lib/api';
import { accessToken } from '@/lib/auth/session';
import { echo, failure, field, type FormState, optional } from '@/lib/forms';

type Step = 'accept' | 'decline' | 'withdraw' | 'approve' | 'reject';

const NOTICE: Record<Step, string> = {
  accept: 'accepted',
  decline: 'declined',
  withdraw: 'withdrawn',
  approve: 'approved',
  reject: 'rejected',
};

/**
 * One step of the request (§14.3–§14.5). If a student's group changed in the
 * meantime the API closes the request instead (SWAP_STALE); the page then
 * shows it closed, with why.
 */
async function step(name: Step, data: FormData, body: Record<string, unknown>): Promise<FormState> {
  const id = field(data, 'id');
  const result = await apiFetch(`/group-swaps/${encodeURIComponent(id)}/${name}`, {
    method: 'POST',
    accessToken: await accessToken(),
    body,
  });
  revalidatePath(`/group-swaps/${id}`);
  revalidatePath('/group-swaps');
  revalidatePath('/tickets');
  if (!result.ok) {
    if (result.code === 'SWAP_STALE') redirect(`/group-swaps/${id}?notice=stale`);
    return failure(result, echo(data, ['reason']));
  }
  redirect(`/group-swaps/${id}?notice=${NOTICE[name]}`);
}

export async function acceptSwapAction(_: FormState, data: FormData): Promise<FormState> {
  return step('accept', data, {});
}

export async function declineSwapAction(_: FormState, data: FormData): Promise<FormState> {
  return step('decline', data, { reason: optional(data, 'reason') });
}

export async function withdrawSwapAction(_: FormState, data: FormData): Promise<FormState> {
  return step('withdraw', data, { reason: optional(data, 'reason') });
}

export async function approveSwapAction(_: FormState, data: FormData): Promise<FormState> {
  return step('approve', data, {});
}

/** The reason is mandatory and shown to both students (§14.5). */
export async function rejectSwapAction(_: FormState, data: FormData): Promise<FormState> {
  return step('reject', data, { reason: field(data, 'reason') });
}
