'use server';

import { type StudentDetail } from '@ftms/core';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { apiFetch } from '@/lib/api';
import { accessToken } from '@/lib/auth/session';
import { echo, failure, field, type FormState, optional } from '@/lib/forms';

const NAME_FIELDS = ['firstName', 'fatherName', 'grandfatherName', 'familyName'];
const RECORD_FIELDS = [
  'seatNumber',
  ...NAME_FIELDS,
  'universityEmail',
  'phone',
  'groupId',
  'reason',
];

const nameOf = (data: FormData) => ({
  firstName: field(data, 'firstName'),
  fatherName: optional(data, 'fatherName') ?? null,
  grandfatherName: optional(data, 'grandfatherName') ?? null,
  familyName: optional(data, 'familyName') ?? null,
});

export async function createStudentAction(_: FormState, data: FormData): Promise<FormState> {
  const result = await apiFetch<StudentDetail>('/students', {
    method: 'POST',
    accessToken: await accessToken(),
    body: {
      seatNumber: field(data, 'seatNumber'),
      name: nameOf(data),
      universityEmail: optional(data, 'universityEmail'),
      phone: optional(data, 'phone'),
      groupId: optional(data, 'groupId'),
    },
  });
  if (!result.ok) return failure(result, echo(data, RECORD_FIELDS));
  redirect(`/students/${result.data.id}`);
}

/** Edits the authoritative fields; empty optional fields are cleared explicitly. */
export async function updateStudentAction(_: FormState, data: FormData): Promise<FormState> {
  const id = field(data, 'id');
  const locked = field(data, 'emailLocked') === 'true';
  // The name is sent only when one of its parts was edited.
  const nameEdited = NAME_FIELDS.some(
    (name) => field(data, name).trim() !== field(data, `original.${name}`).trim(),
  );
  const result = await apiFetch<StudentDetail>(`/students/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    accessToken: await accessToken(),
    body: {
      seatNumber: field(data, 'seatNumber'),
      ...(nameEdited ? { name: nameOf(data) } : {}),
      ...(locked ? {} : { universityEmail: field(data, 'universityEmail').trim() || null }),
      phone: field(data, 'phone').trim() || null,
      reason: optional(data, 'reason'),
    },
  });
  if (!result.ok) {
    if (result.code === 'NO_CHANGES') return { status: 'success' };
    return failure(result, echo(data, RECORD_FIELDS));
  }
  revalidatePath(`/students/${id}`);
  return { status: 'success' };
}

export async function setStudentGroupAction(_: FormState, data: FormData): Promise<FormState> {
  const id = field(data, 'id');
  const result = await apiFetch<StudentDetail>(`/students/${encodeURIComponent(id)}/group`, {
    method: 'PUT',
    accessToken: await accessToken(),
    body: { groupId: optional(data, 'groupId') ?? null, reason: optional(data, 'reason') },
  });
  if (!result.ok) return failure(result, echo(data, ['groupId', 'reason']));
  revalidatePath(`/students/${id}`);
  return { status: 'success' };
}

export async function deleteStudentAction(_: FormState, data: FormData): Promise<FormState> {
  const id = field(data, 'id');
  const result = await apiFetch<void>(`/students/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    accessToken: await accessToken(),
    body: { reason: field(data, 'reason') },
  });
  if (!result.ok) return failure(result, echo(data, ['reason']));
  redirect('/students');
}

export async function unlinkAccountAction(_: FormState, data: FormData): Promise<FormState> {
  const id = field(data, 'id');
  const result = await apiFetch<StudentDetail>(
    `/students/${encodeURIComponent(id)}/unlink-account`,
    { method: 'POST', accessToken: await accessToken(), body: { reason: field(data, 'reason') } },
  );
  if (!result.ok) return failure(result, echo(data, ['reason']));
  revalidatePath(`/students/${id}`);
  return { status: 'success' };
}
