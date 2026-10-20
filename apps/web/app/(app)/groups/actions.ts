'use server';

import { type AssignMembersResponse, type Group } from '@ftms/core';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { apiFetch } from '@/lib/api';
import { accessToken } from '@/lib/auth/session';
import { echo, failure, field, type FormState, optional } from '@/lib/forms';

export async function createGroupAction(_: FormState, data: FormData): Promise<FormState> {
  const result = await apiFetch<Group>('/groups', {
    method: 'POST',
    accessToken: await accessToken(),
    body: { name: field(data, 'name'), description: optional(data, 'description') },
  });
  if (!result.ok) return failure(result, echo(data, ['name', 'description']));
  redirect(`/groups/${result.data.id}`);
}

export async function updateGroupAction(_: FormState, data: FormData): Promise<FormState> {
  const id = field(data, 'id');
  const result = await apiFetch<Group>(`/groups/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    accessToken: await accessToken(),
    body: { name: field(data, 'name'), description: field(data, 'description').trim() || null },
  });
  if (!result.ok) return failure(result, echo(data, ['name', 'description']));
  revalidatePath(`/groups/${id}`);
  return { status: 'success' };
}

export async function setGroupArchivedAction(_: FormState, data: FormData): Promise<FormState> {
  const id = field(data, 'id');
  const result = await apiFetch<Group>(`/groups/${encodeURIComponent(id)}/archived`, {
    method: 'PUT',
    accessToken: await accessToken(),
    body: { archived: field(data, 'archived') === 'true' },
  });
  if (!result.ok) return failure(result);
  revalidatePath(`/groups/${id}`);
  return { status: 'success' };
}

/** Adds the checked students; moving someone from another group needs the explicit box. */
export async function addMembersAction(_: FormState, data: FormData): Promise<FormState> {
  const id = field(data, 'id');
  const studentIds = data.getAll('studentIds').filter((v): v is string => typeof v === 'string');
  if (studentIds.length === 0) return { status: 'error', error: 'NO_STUDENTS_SELECTED' };
  const result = await apiFetch<AssignMembersResponse>(
    `/groups/${encodeURIComponent(id)}/members`,
    {
      method: 'POST',
      accessToken: await accessToken(),
      body: {
        studentIds,
        moveFromOtherGroup: field(data, 'moveFromOtherGroup') === 'true',
        reason: optional(data, 'reason'),
      },
    },
  );
  if (!result.ok) return failure(result, echo(data, ['reason']));
  revalidatePath(`/groups/${id}`);
  return {
    status: 'success',
    values: {
      added: String(result.data.added),
      moved: String(result.data.moved),
      already: String(result.data.alreadyMembers),
    },
  };
}

export async function removeMemberAction(_: FormState, data: FormData): Promise<FormState> {
  const id = field(data, 'id');
  const studentId = field(data, 'studentId');
  const result = await apiFetch<void>(
    `/groups/${encodeURIComponent(id)}/members/${encodeURIComponent(studentId)}`,
    { method: 'DELETE', accessToken: await accessToken(), body: {} },
  );
  if (!result.ok) return failure(result);
  revalidatePath(`/groups/${id}`);
  return { status: 'success' };
}
