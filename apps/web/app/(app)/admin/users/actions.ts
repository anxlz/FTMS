'use server';

import { PERMISSION_KEYS } from '@ftms/core';
import { revalidatePath } from 'next/cache';
import { apiFetch } from '@/lib/api';
import { accessToken } from '@/lib/auth/session';
import { echo, failure, field, type FormState } from '@/lib/forms';

const optional = (value: string) => (value.trim() ? value.trim() : undefined);

export async function createUserAction(_: FormState, data: FormData): Promise<FormState> {
  const role = field(data, 'role');
  const body =
    role === 'STUDENT'
      ? {
          role,
          email: field(data, 'email'),
          fullName: field(data, 'fullName'),
          seatNumber: field(data, 'seatNumber'),
        }
      : {
          role,
          email: field(data, 'email'),
          fullName: field(data, 'fullName'),
          academicTitle: optional(field(data, 'academicTitle')),
          department: optional(field(data, 'department')),
        };
  const result = await apiFetch('/admin/users', {
    method: 'POST',
    body,
    accessToken: await accessToken(),
  });
  if (!result.ok) {
    return failure(
      result,
      echo(data, ['role', 'email', 'fullName', 'seatNumber', 'academicTitle', 'department']),
    );
  }
  revalidatePath('/admin/users');
  return { status: 'success' };
}

export async function setStatusAction(_: FormState, data: FormData): Promise<FormState> {
  const id = field(data, 'id');
  const result = await apiFetch(`/admin/users/${encodeURIComponent(id)}/status`, {
    method: 'PATCH',
    accessToken: await accessToken(),
    body: { status: field(data, 'status'), reason: field(data, 'reason') },
  });
  if (!result.ok) return failure(result, echo(data, ['reason']));
  revalidatePath(`/admin/users/${id}`);
  return { status: 'success' };
}

export async function setRoleAction(_: FormState, data: FormData): Promise<FormState> {
  const id = field(data, 'id');
  const result = await apiFetch(`/admin/users/${encodeURIComponent(id)}/role`, {
    method: 'PATCH',
    accessToken: await accessToken(),
    body: { role: field(data, 'role'), reason: field(data, 'reason') },
  });
  if (!result.ok) return failure(result, echo(data, ['role', 'reason']));
  revalidatePath(`/admin/users/${id}`);
  return { status: 'success' };
}

/** Each permission row submits `grant:<key>` = inherit | ALLOW | DENY. */
export async function setGrantsAction(_: FormState, data: FormData): Promise<FormState> {
  const id = field(data, 'id');
  const grants = PERMISSION_KEYS.flatMap((permission) => {
    const effect = field(data, `grant:${permission}`);
    return effect === 'ALLOW' || effect === 'DENY' ? [{ permission, effect }] : [];
  });
  const result = await apiFetch(`/admin/users/${encodeURIComponent(id)}/permissions`, {
    method: 'PUT',
    accessToken: await accessToken(),
    body: { grants, reason: field(data, 'reason') },
  });
  if (!result.ok) {
    return failure(result, echo(data, ['reason', ...PERMISSION_KEYS.map((key) => `grant:${key}`)]));
  }
  revalidatePath(`/admin/users/${id}`);
  return { status: 'success' };
}
