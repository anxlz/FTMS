import { z } from 'zod';
import { distanceMeters } from './classification';

/* ─────────────────────── check-in location policy (§7.2 as revised in Phase 8) ─────────────────────── */

/**
 * Every check-in — signed in or guest — sends the device's current location.
 * Biometrics are never part of attendance (they are a sign-in convenience only).
 * The program may further require the reading to be:
 * - within `radiusMeters` of the visit's coordinates (when the visit has them), and
 * - no less precise than `maxAccuracyMeters` (the accuracy the device reports).
 * `null` means no limit. The API applies the policy; clients only explain it.
 */
export const CheckInPolicySchema = z.object({
  radiusMeters: z.number().int().min(10).max(100_000).nullable(),
  maxAccuracyMeters: z.number().int().min(5).max(10_000).nullable(),
});
export type CheckInPolicy = z.infer<typeof CheckInPolicySchema>;

export interface LocationReadingInput {
  latitude: number;
  longitude: number;
  accuracy?: number | null;
}

export type LocationCheck =
  | { ok: true; distanceMeters: number | null }
  | {
      ok: false;
      error: 'LOCATION_INACCURATE' | 'LOCATION_OUTSIDE_AREA';
      distanceMeters: number | null;
    };

/**
 * Applies the location policy to one reading. The area is enforced only when
 * the program sets a radius **and** the visit has coordinates; the accuracy
 * limit applies to every reading (a reading without a reported accuracy fails
 * an accuracy limit).
 */
export function checkLocation(
  reading: LocationReadingInput,
  visit: { latitude: number | null; longitude: number | null },
  policy: CheckInPolicy,
): LocationCheck {
  const distance =
    visit.latitude !== null && visit.longitude !== null
      ? distanceMeters(reading, { latitude: visit.latitude, longitude: visit.longitude })
      : null;
  if (policy.maxAccuracyMeters !== null) {
    const accuracy = reading.accuracy ?? null;
    if (accuracy === null || accuracy > policy.maxAccuracyMeters) {
      return { ok: false, error: 'LOCATION_INACCURATE', distanceMeters: distance };
    }
  }
  if (policy.radiusMeters !== null && distance !== null && distance > policy.radiusMeters) {
    return { ok: false, error: 'LOCATION_OUTSIDE_AREA', distanceMeters: distance };
  }
  return { ok: true, distanceMeters: distance };
}

/** Whether the area limit can be enforced for a visit (a radius is set and the visit has coordinates). */
export const areaEnforced = (
  visit: { latitude: number | null; longitude: number | null },
  policy: CheckInPolicy,
): boolean => policy.radiusMeters !== null && visit.latitude !== null && visit.longitude !== null;
