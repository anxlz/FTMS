'use server';

import { type GuestCheckInResult } from '@ftms/core';
import { apiFetch } from '@/lib/api';
import { failure } from '@/lib/forms';

export type GuestOutcome =
  | { ok: true; receipt: GuestCheckInResult['receipt'] }
  | {
      ok: false;
      error: string;
      fieldErrors?: Record<string, string[]>;
      retryAfterMinutes?: number;
      /** The request may not have reached the server: retrying is safe (same submission key). */
      network: boolean;
    };

/**
 * Sends a guest submission (Phase 8). No session is used or created. The server
 * judges the time, the window, the form and the location policy; the typed name
 * and seat number are stored as typed and are not verified.
 */
export async function guestCheckInAction(input: {
  token: string;
  submissionKey: string;
  fullName: string;
  seatNumber: string;
  location?: { latitude: number; longitude: number; accuracy: number | null };
}): Promise<GuestOutcome> {
  const result = await apiFetch<GuestCheckInResult>('/attendance/guest/check-in', {
    method: 'POST',
    body: input,
  });
  if (result.ok) return { ok: true, receipt: result.data.receipt };
  const state = failure(result);
  return {
    ok: false,
    error: result.code,
    fieldErrors: state.fieldErrors,
    retryAfterMinutes: state.retryAfterMinutes,
    network: result.code === 'NETWORK',
  };
}
