'use server';

import { type AttendanceRecord, type CheckInResult } from '@ftms/core';
import { apiFetch } from '@/lib/api';
import { accessToken } from '@/lib/auth/session';
import { failure } from '@/lib/forms';

export type CheckInOutcome =
  { ok: true; record: AttendanceRecord } | { ok: false; error: string; retryAfterMinutes?: number };

/**
 * Submits a signed-in check-in: the QR token and the device location. The API
 * judges everything — the time (server clock), the group and the location policy
 * (§7.2, §8.5, revised in Phase 8). There is no biometric step.
 */
export async function checkInAction(input: {
  token: string;
  location: { latitude: number; longitude: number; accuracy: number | null };
}): Promise<CheckInOutcome> {
  const result = await apiFetch<CheckInResult>('/attendance/check-in', {
    method: 'POST',
    accessToken: await accessToken(),
    body: input,
  });
  if (!result.ok) {
    return { ok: false, error: result.code, retryAfterMinutes: failure(result).retryAfterMinutes };
  }
  return { ok: true, record: result.data.record };
}
