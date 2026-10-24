'use server';

import {
  type ExceptionChangeResult,
  type Program,
  type ScheduleChangeResult,
  toWesternDigits,
} from '@ftms/core';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { apiFetch } from '@/lib/api';
import { accessToken } from '@/lib/auth/session';
import { echo, failure, field, type FormState, optional } from '@/lib/forms';

const num = (data: FormData, name: string): number | null => {
  const raw = toWesternDigits(field(data, name)).trim();
  return raw === '' ? null : Number(raw);
};

const timingFrom = (data: FormData) => ({
  checkInOpensMinutes: num(data, 'checkInOpensMinutes'),
  graceMinutes: num(data, 'graceMinutes'),
  checkInClosesMinutes: num(data, 'checkInClosesMinutes'),
});

const strings = (data: FormData, name: string): string[] =>
  data.getAll(name).filter((v): v is string => typeof v === 'string');

const policyFrom = (data: FormData) => ({
  biometricFallback: field(data, 'biometricFallback'),
  geolocation: field(data, 'geolocation'),
});

const PROGRAM_FIELDS = [
  'name',
  'startDate',
  'durationWeeks',
  'allowedAbsences',
  'checkInOpensMinutes',
  'graceMinutes',
  'checkInClosesMinutes',
  'biometricFallback',
  'geolocation',
  'reason',
];

/* ─────────────────────────── program (§11) ─────────────────────────── */

export async function createProgramAction(_: FormState, data: FormData): Promise<FormState> {
  const result = await apiFetch<Program>('/program', {
    method: 'POST',
    accessToken: await accessToken(),
    body: {
      name: field(data, 'name'),
      startDate: field(data, 'startDate'),
      durationWeeks: num(data, 'durationWeeks'),
      allowedAbsences: num(data, 'allowedAbsences'),
      timing: timingFrom(data),
      checkInPolicy: policyFrom(data),
    },
  });
  if (!result.ok) return failure(result, echo(data, PROGRAM_FIELDS));
  revalidatePath('/schedule');
  revalidatePath('/settings');
  return { status: 'success' };
}

/** Name and dates (`schedule.manage`). */
export async function updateProgramPlanAction(_: FormState, data: FormData): Promise<FormState> {
  const result = await apiFetch<Program>('/program', {
    method: 'PATCH',
    accessToken: await accessToken(),
    body: {
      name: field(data, 'name'),
      startDate: field(data, 'startDate'),
      durationWeeks: num(data, 'durationWeeks'),
      reason: optional(data, 'reason'),
    },
  });
  if (!result.ok) return failure(result, echo(data, PROGRAM_FIELDS));
  revalidatePath('/schedule');
  return { status: 'success' };
}

/**
 * Attendance defaults (`attendance.settings.defaults`); existing visits keep
 * their timing (§8.1). The check-in policy applies to every check-in from now on.
 */
export async function updateAttendanceDefaultsAction(
  _: FormState,
  data: FormData,
): Promise<FormState> {
  const result = await apiFetch<Program>('/program', {
    method: 'PATCH',
    accessToken: await accessToken(),
    body: {
      allowedAbsences: num(data, 'allowedAbsences'),
      timing: timingFrom(data),
      checkInPolicy: policyFrom(data),
      reason: optional(data, 'reason'),
    },
  });
  if (!result.ok) return failure(result, echo(data, PROGRAM_FIELDS));
  revalidatePath('/schedule');
  revalidatePath('/settings');
  return { status: 'success' };
}

/* ─────────────────────────── schedules (§6.1) ─────────────────────────── */

const SCHEDULE_FIELDS = [
  'title',
  'startTime',
  'endTime',
  'startsOn',
  'endsOn',
  'locationName',
  'reason',
];

const echoSchedule = (data: FormData) => ({
  ...echo(data, SCHEDULE_FIELDS),
  weekdays: strings(data, 'weekdays').join(','),
  groupIds: strings(data, 'groupIds').join(','),
});

const counts = (r: ScheduleChangeResult) => ({
  created: String(r.created),
  updated: String(r.updated),
  removed: String(r.removed),
  cancelled: String(r.cancelled),
});

export async function createScheduleAction(_: FormState, data: FormData): Promise<FormState> {
  const result = await apiFetch<ScheduleChangeResult>('/schedules', {
    method: 'POST',
    accessToken: await accessToken(),
    body: {
      title: field(data, 'title'),
      weekdays: strings(data, 'weekdays').map(Number),
      startTime: field(data, 'startTime'),
      endTime: optional(data, 'endTime'),
      startsOn: optional(data, 'startsOn'),
      endsOn: optional(data, 'endsOn'),
      locationName: optional(data, 'locationName'),
      groupIds: strings(data, 'groupIds'),
    },
  });
  if (!result.ok) return failure(result, echoSchedule(data));
  revalidatePath('/schedule');
  return { status: 'success', values: counts(result.data) };
}

export async function updateScheduleAction(_: FormState, data: FormData): Promise<FormState> {
  const id = field(data, 'id');
  const result = await apiFetch<ScheduleChangeResult>(`/schedules/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    accessToken: await accessToken(),
    body: {
      title: field(data, 'title'),
      weekdays: strings(data, 'weekdays').map(Number),
      startTime: field(data, 'startTime'),
      endTime: optional(data, 'endTime') ?? null,
      endsOn: field(data, 'endsOn'),
      locationName: optional(data, 'locationName') ?? null,
      groupIds: strings(data, 'groupIds'),
      reason: optional(data, 'reason'),
    },
  });
  if (!result.ok) return failure(result, echoSchedule(data));
  revalidatePath('/schedule');
  revalidatePath(`/schedule/${id}`);
  return { status: 'success', values: counts(result.data) };
}

export async function endScheduleAction(_: FormState, data: FormData): Promise<FormState> {
  const id = field(data, 'id');
  const result = await apiFetch<ScheduleChangeResult>(`/schedules/${encodeURIComponent(id)}/end`, {
    method: 'POST',
    accessToken: await accessToken(),
    body: { reason: field(data, 'reason') },
  });
  if (!result.ok) return failure(result, echo(data, ['reason']));
  revalidatePath('/schedule');
  redirect(`/schedule?ended=${result.data.cancelled}`);
}

/* ─────────────────────────── days off (§6.1) ─────────────────────────── */

export async function createExceptionAction(_: FormState, data: FormData): Promise<FormState> {
  const result = await apiFetch<ExceptionChangeResult>('/schedule-exceptions', {
    method: 'POST',
    accessToken: await accessToken(),
    body: {
      date: field(data, 'date'),
      scheduleId: optional(data, 'scheduleId'),
      reason: field(data, 'reason'),
    },
  });
  if (!result.ok) return failure(result, echo(data, ['date', 'scheduleId', 'reason']));
  revalidatePath('/schedule');
  return {
    status: 'success',
    values: { affected: String(result.data.affected), notified: String(result.data.notified) },
  };
}

export async function removeExceptionAction(_: FormState, data: FormData): Promise<FormState> {
  const result = await apiFetch<ExceptionChangeResult>(
    `/schedule-exceptions/${encodeURIComponent(field(data, 'id'))}`,
    { method: 'DELETE', accessToken: await accessToken() },
  );
  if (!result.ok) return failure(result);
  revalidatePath('/schedule');
  return { status: 'success', values: { affected: String(result.data.affected) } };
}
