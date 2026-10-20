'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { apiFetch } from '@/lib/api';
import { accessToken } from '@/lib/auth/session';
import { field, type FormState, failure } from '@/lib/forms';

/** Only in-app paths: a stored link can never send the reader elsewhere. */
const safeLink = (link: string): string =>
  /^\/[A-Za-z0-9]/.test(link) && !link.startsWith('//') ? link : '/notifications';

/** Marks the notification read, then opens what it is about. */
export async function openNotificationAction(data: FormData): Promise<void> {
  const id = field(data, 'id');
  await apiFetch(`/notifications/${encodeURIComponent(id)}/read`, {
    method: 'POST',
    accessToken: await accessToken(),
  });
  revalidatePath('/', 'layout');
  redirect(safeLink(field(data, 'link')));
}

export async function markReadAction(_: FormState, data: FormData): Promise<FormState> {
  const result = await apiFetch(`/notifications/${encodeURIComponent(field(data, 'id'))}/read`, {
    method: 'POST',
    accessToken: await accessToken(),
  });
  if (!result.ok) return failure(result);
  revalidatePath('/', 'layout');
  return { status: 'success' };
}

export async function markAllReadAction(_: FormState): Promise<FormState> {
  const result = await apiFetch('/notifications/read-all', {
    method: 'POST',
    accessToken: await accessToken(),
  });
  if (!result.ok) return failure(result);
  revalidatePath('/', 'layout');
  return { status: 'success' };
}
