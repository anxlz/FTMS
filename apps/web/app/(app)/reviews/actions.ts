'use server';

import { revalidatePath } from 'next/cache';
import { apiFetch } from '@/lib/api';
import { accessToken } from '@/lib/auth/session';
import { echo, failure, field, type FormState, optional } from '@/lib/forms';

async function decide(
  path: string,
  body: Record<string, unknown>,
  data: FormData,
  page: string,
): Promise<FormState> {
  const result = await apiFetch(path, { method: 'POST', accessToken: await accessToken(), body });
  revalidatePath(page);
  if (!result.ok) return failure(result, echo(data, ['comment', 'reason']));
  return { status: 'success' };
}

export async function approveProfileChangeAction(_: FormState, data: FormData): Promise<FormState> {
  const id = encodeURIComponent(field(data, 'id'));
  return decide(
    `/profile-changes/${id}/approve`,
    { comment: optional(data, 'comment') },
    data,
    `/reviews/profile-changes/${id}`,
  );
}

export async function rejectProfileChangeAction(_: FormState, data: FormData): Promise<FormState> {
  const id = encodeURIComponent(field(data, 'id'));
  return decide(
    `/profile-changes/${id}/reject`,
    { reason: field(data, 'reason') },
    data,
    `/reviews/profile-changes/${id}`,
  );
}

/** Link to a chosen record (`studentId`) or create one from the submitted details. */
export async function approveVerificationAction(_: FormState, data: FormData): Promise<FormState> {
  const id = encodeURIComponent(field(data, 'id'));
  const studentId = optional(data, 'studentId');
  const body = studentId
    ? { mode: 'LINK', studentId, comment: optional(data, 'comment') }
    : { mode: 'CREATE', groupId: optional(data, 'groupId'), comment: optional(data, 'comment') };
  return decide(`/student-verifications/${id}/approve`, body, data, `/reviews/verifications/${id}`);
}

export async function rejectVerificationAction(_: FormState, data: FormData): Promise<FormState> {
  const id = encodeURIComponent(field(data, 'id'));
  return decide(
    `/student-verifications/${id}/reject`,
    { reason: field(data, 'reason') },
    data,
    `/reviews/verifications/${id}`,
  );
}
