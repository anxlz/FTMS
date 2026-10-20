'use server';

import {
  toWesternDigits,
  VISIT_FILE_MAX_BYTES,
  type VisitDetail,
  type VisitMutationResult,
} from '@ftms/core';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { apiFetch, apiUpload } from '@/lib/api';
import { accessToken } from '@/lib/auth/session';
import { echo, failure, field, type FormState, optional } from '@/lib/forms';

const VISIT_FIELDS = [
  'title',
  'description',
  'date',
  'startTime',
  'endTime',
  'locationName',
  'latitude',
  'longitude',
  'mapUrl',
  'checkInOpensMinutes',
  'graceMinutes',
  'checkInClosesMinutes',
  'timingMode',
  'reason',
];

/** Numbers typed with Arabic-Indic digits are accepted (§18.1). Blank → null. */
const numberOrNull = (data: FormData, name: string): number | null => {
  const raw = toWesternDigits(field(data, name)).trim();
  return raw === '' ? null : Number(raw);
};

const timingFrom = (data: FormData) => ({
  checkInOpensMinutes: numberOrNull(data, 'checkInOpensMinutes'),
  graceMinutes: numberOrNull(data, 'graceMinutes'),
  checkInClosesMinutes: numberOrNull(data, 'checkInClosesMinutes'),
});

const strings = (data: FormData, name: string): string[] =>
  data.getAll(name).filter((v): v is string => typeof v === 'string');

/**
 * The request body from the visit form. Inputs disabled because check-in has
 * opened are not submitted, so they are left out and never change.
 */
function visitBody(data: FormData, mode: 'create' | 'edit'): Record<string, unknown> {
  const clear = mode === 'create' ? undefined : null;
  const body: Record<string, unknown> = {
    title: field(data, 'title'),
    description: optional(data, 'description') ?? clear,
    location: {
      name: optional(data, 'locationName') ?? null,
      latitude: numberOrNull(data, 'latitude'),
      longitude: numberOrNull(data, 'longitude'),
      mapUrl: optional(data, 'mapUrl') ?? null,
    },
  };
  if (data.has('date')) body.date = field(data, 'date');
  if (data.has('startTime')) body.startTime = field(data, 'startTime');
  if (data.has('endTime')) body.endTime = optional(data, 'endTime') ?? clear;
  if (data.has('groupsEditable')) body.groupIds = strings(data, 'groupIds');
  // New visits take the program defaults unless custom values are chosen (§8.1).
  const timing = field(data, 'timingMode');
  if (timing === 'custom') body.timing = timingFrom(data);
  if (timing === 'defaults' && mode === 'edit') body.timing = 'useDefaults';
  if (mode === 'edit') body.reason = optional(data, 'reason');
  return body;
}

const echoVisit = (data: FormData) => ({
  ...echo(data, VISIT_FIELDS),
  groupIds: strings(data, 'groupIds').join(','),
});

export async function createVisitAction(_: FormState, data: FormData): Promise<FormState> {
  const result = await apiFetch<VisitMutationResult>('/visits', {
    method: 'POST',
    accessToken: await accessToken(),
    body: visitBody(data, 'create'),
  });
  if (!result.ok) return failure(result, echoVisit(data));
  redirect(`/visits/${result.data.visit.id}?notice=created&notified=${result.data.notified}`);
}

export async function updateVisitAction(_: FormState, data: FormData): Promise<FormState> {
  const id = field(data, 'id');
  const result = await apiFetch<VisitMutationResult>(`/visits/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    accessToken: await accessToken(),
    body: visitBody(data, 'edit'),
  });
  if (!result.ok) return failure(result, echoVisit(data));
  revalidatePath(`/visits/${id}`);
  redirect(`/visits/${id}?notice=updated&notified=${result.data.notified}`);
}

export async function cancelVisitAction(_: FormState, data: FormData): Promise<FormState> {
  const id = field(data, 'id');
  const result = await apiFetch<VisitMutationResult>(`/visits/${encodeURIComponent(id)}/cancel`, {
    method: 'POST',
    accessToken: await accessToken(),
    body: { reason: field(data, 'reason') },
  });
  if (!result.ok) return failure(result, echo(data, ['reason']));
  revalidatePath(`/visits/${id}`);
  redirect(`/visits/${id}?notice=cancelled&notified=${result.data.notified}`);
}

export async function restoreVisitAction(_: FormState, data: FormData): Promise<FormState> {
  const id = field(data, 'id');
  const result = await apiFetch<VisitMutationResult>(`/visits/${encodeURIComponent(id)}/restore`, {
    method: 'POST',
    accessToken: await accessToken(),
    body: { reason: optional(data, 'reason') },
  });
  if (!result.ok) return failure(result);
  revalidatePath(`/visits/${id}`);
  redirect(`/visits/${id}?notice=restored&notified=${result.data.notified}`);
}

export async function uploadVisitFileAction(_: FormState, data: FormData): Promise<FormState> {
  const id = field(data, 'id');
  const file = data.get('file');
  if (!(file instanceof File) || file.size === 0) {
    return { status: 'error', error: 'FILE_INVALID', fieldErrors: { file: ['FILE_REQUIRED'] } };
  }
  if (file.size > VISIT_FILE_MAX_BYTES) {
    return { status: 'error', error: 'FILE_TOO_LARGE', fieldErrors: { file: ['FILE_TOO_LARGE'] } };
  }
  const form = new FormData();
  form.append('kind', field(data, 'kind'));
  form.append('file', file, file.name);
  const result = await apiUpload<VisitDetail>(
    `/visits/${encodeURIComponent(id)}/files`,
    form,
    await accessToken(),
  );
  if (!result.ok) return failure(result);
  revalidatePath(`/visits/${id}`);
  return { status: 'success' };
}

export async function removeVisitFileAction(_: FormState, data: FormData): Promise<FormState> {
  const id = field(data, 'id');
  const fileId = field(data, 'fileId');
  const result = await apiFetch<VisitDetail>(
    `/visits/${encodeURIComponent(id)}/files/${encodeURIComponent(fileId)}`,
    { method: 'DELETE', accessToken: await accessToken() },
  );
  if (!result.ok) return failure(result);
  revalidatePath(`/visits/${id}`);
  return { status: 'success' };
}
