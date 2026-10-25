import { type VisitTiming } from '../scheduling/contracts';

export const ATTENDANCE_STATUSES = ['PRESENT', 'LATE', 'ABSENT'] as const;
export type AttendanceStatus = (typeof ATTENDANCE_STATUSES)[number];

/**
 * How a record came to be: a signed-in QR check-in, a faculty correction, the
 * absence job, or a guest submission whose typed seat number matched (Phase 8;
 * identity not verified).
 */
export const ATTENDANCE_SOURCES = ['QR', 'MANUAL', 'AUTOMATIC', 'GUEST'] as const;
export type AttendanceSource = (typeof ATTENDANCE_SOURCES)[number];

const MINUTE = 60_000;

/**
 * The minute-rounding convention (§8.2), applied everywhere — check-in, the
 * absence job, the visit phase and the UI:
 *
 *   m = ⌊(check-in time − scheduled start) / 1 minute⌋
 *
 * i.e. whole minutes elapsed since the start, seconds discarded (negative before
 * the start). With the defaults (opens 15, grace 15, closes 60) and a 10:00 visit:
 *
 *   09:44:59 → m = −16 → refused (not open yet)
 *   09:45:00 → m = −15 → PRESENT
 *   10:15:59 → m =  15 → PRESENT (the last on-time minute)
 *   10:16:00 → m =  16 → LATE, 1 minute late
 *   11:00:59 → m =  60 → LATE, 45 minutes late
 *   11:01:00 → m =  61 → refused (closed); without a check-in → ABSENT
 *
 * "One minute after the grace period ends" (m = grace + 1) is therefore late,
 * never present. The server's clock decides, never the browser's (§16.2).
 */
export const elapsedMinutes = (startsAt: Date, at: Date): number =>
  Math.floor((at.getTime() - startsAt.getTime()) / MINUTE);

export type CheckInOutcome =
  | { result: 'PRESENT'; minutesLate: 0 }
  | { result: 'LATE'; minutesLate: number }
  | { result: 'NOT_OPEN' }
  | { result: 'CLOSED' };

export function classifyCheckIn(startsAt: Date, timing: VisitTiming, at: Date): CheckInOutcome {
  const m = elapsedMinutes(startsAt, at);
  if (m < -timing.checkInOpensMinutes) return { result: 'NOT_OPEN' };
  if (m > timing.checkInClosesMinutes) return { result: 'CLOSED' };
  if (m <= timing.graceMinutes) return { result: 'PRESENT', minutesLate: 0 };
  return { result: 'LATE', minutesLate: m - timing.graceMinutes };
}

/**
 * The window as instants: check-in is accepted from `opensAt` (inclusive) until
 * `closesAt` (exclusive); it is on time until `onTimeUntil` (exclusive).
 */
export function checkInWindow(startsAt: Date, timing: VisitTiming) {
  const start = startsAt.getTime();
  return {
    opensAt: new Date(start - timing.checkInOpensMinutes * MINUTE),
    onTimeUntil: new Date(start + (timing.graceMinutes + 1) * MINUTE),
    closesAt: new Date(start + (timing.checkInClosesMinutes + 1) * MINUTE),
  };
}

export interface AttendanceTotals {
  /** PRESENT + LATE. */
  attended: number;
  present: number;
  late: number;
  absent: number;
  /** max(0, allowed − absences) (§9.2). */
  remainingAbsences: number;
}

/** Totals over finalized records of visits that took place (never cancelled ones). */
export function attendanceTotals(
  statuses: readonly AttendanceStatus[],
  allowedAbsences: number,
): AttendanceTotals {
  const count = (s: AttendanceStatus) => statuses.filter((x) => x === s).length;
  const present = count('PRESENT');
  const late = count('LATE');
  const absent = count('ABSENT');
  return {
    attended: present + late,
    present,
    late,
    absent,
    remainingAbsences: Math.max(0, allowedAbsences - absent),
  };
}

/** Great-circle distance in metres between a reading and the visit's coordinates. */
export function distanceMeters(
  a: { latitude: number; longitude: number },
  b: { latitude: number; longitude: number },
): number {
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.latitude - a.latitude);
  const dLon = rad(b.longitude - a.longitude);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.latitude)) * Math.cos(rad(b.latitude)) * Math.sin(dLon / 2) ** 2;
  return Math.round(2 * 6_371_000 * Math.asin(Math.min(1, Math.sqrt(h))));
}
