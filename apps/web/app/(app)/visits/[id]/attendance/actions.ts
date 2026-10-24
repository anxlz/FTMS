'use server';

import { toWesternDigits, type VisitAttendanceRow } from '@ftms/core';
import { revalidatePath } from 'next/cache';
import { apiFetch } from '@/lib/api';
import { accessToken } from '@/lib/auth/session';
import { echo, failure, field, type FormState, optional } from '@/lib/forms';

/**
 * §8.4: set a student's status (and minutes late) for a visit. The API records
 * who, when and why, and keeps the previous state in the audit log.
 */
export async function correctAttendanceAction(_: FormState, data: FormData): Promise<FormState> {
  const visitId = field(data, 'visitId');
  const studentId = field(data, 'studentId');
  const status = field(data, 'status');
  const minutes = toWesternDigits(field(data, 'minutesLate')).trim();
  const result = await apiFetch<VisitAttendanceRow>(
    `/visits/${encodeURIComponent(visitId)}/attendance/${encodeURIComponent(studentId)}`,
    {
      method: 'PUT',
      accessToken: await accessToken(),
      body: {
        status,
        ...(status === 'LATE' ? { minutesLate: minutes === '' ? undefined : Number(minutes) } : {}),
        reason: optional(data, 'reason'),
      },
    },
  );
  if (!result.ok) return failure(result, echo(data, ['status', 'minutesLate', 'reason']));
  revalidatePath(`/visits/${visitId}/attendance`);
  return { status: 'success' };
}
