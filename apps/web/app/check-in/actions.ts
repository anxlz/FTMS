'use server';

import {
  type AttendanceRecord,
  type CheckInResult,
  type WebAuthnOptionsResponse,
} from '@ftms/core';
import { apiFetch } from '@/lib/api';
import { type CeremonyStart } from '@/lib/auth/actions';
import { accessToken } from '@/lib/auth/session';
import { failure } from '@/lib/forms';

export type CheckInOutcome =
  { ok: true; record: AttendanceRecord } | { ok: false; error: string; retryAfterMinutes?: number };

/** A biometric challenge bound to this student and this visit (§7.2). */
export async function checkInOptionsAction(token: string): Promise<CeremonyStart> {
  const result = await apiFetch<WebAuthnOptionsResponse>('/attendance/check-in/options', {
    method: 'POST',
    accessToken: await accessToken(),
    body: { token },
  });
  if (!result.ok) {
    return { ok: false, error: result.code, retryAfterMinutes: failure(result).retryAfterMinutes };
  }
  return { ok: true, challengeId: result.data.challengeId, options: result.data.options };
}

/**
 * Submits the check-in. The API judges everything — the time (server clock),
 * the group, the biometric assertion and the location policy (§7.2, §8.5).
 */
export async function checkInAction(input: {
  token: string;
  biometric?: { challengeId: string; response: unknown };
  location?: { latitude: number; longitude: number; accuracy: number | null };
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
