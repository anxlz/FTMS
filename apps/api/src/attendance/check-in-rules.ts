import {
  areaEnforced,
  type CheckInPolicy,
  type CheckInState,
  checkInWindow,
  checkLocation,
  classifyCheckIn,
  type GeolocationReading,
  type LocationRequirement,
} from '@ftms/core';
import { type Prisma, type TrainingProgram, type TrainingVisit } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { fromDbDate, fromDbTime, timingOf } from '../scheduling/db-values';
import { SchedulingErrors } from '../scheduling/scheduling-errors';
import { AttendanceErrors } from './attendance-errors';
import { type AttendanceTokens } from './attendance-tokens';

/**
 * The rules both check-in paths share (signed in and guest, Phase 8): the QR
 * token names one visit; the visit takes place; the server's clock is inside the
 * visit's window; the location reading satisfies the program's policy. Nothing
 * here depends on biometrics.
 */

type Db = Prisma.TransactionClient | PrismaService;

export const policyOf = (program: TrainingProgram): CheckInPolicy => ({
  radiusMeters: program.locationRadiusMeters,
  maxAccuracyMeters: program.locationMaxAccuracyMeters,
});

export const locationRequirement = (
  visit: TrainingVisit,
  program: TrainingProgram,
): LocationRequirement => {
  const policy = policyOf(program);
  return { ...policy, areaEnforced: areaEnforced(visit, policy) };
};

/** The visit a QR token names, or QR_INVALID (forged, altered or unknown). */
export async function visitForToken(
  db: Db,
  tokens: AttendanceTokens,
  token: string,
): Promise<{ visit: TrainingVisit; program: TrainingProgram }> {
  const visitId = tokens.verify(token);
  if (!visitId) throw AttendanceErrors.qrInvalid();
  const visit = await db.trainingVisit.findUnique({ where: { id: visitId } });
  if (!visit) throw AttendanceErrors.qrInvalid();
  const program = await db.trainingProgram.findUniqueOrThrow({ where: { id: visit.programId } });
  return { visit, program };
}

export function windowState(visit: TrainingVisit, now: Date): CheckInState {
  const outcome = classifyCheckIn(visit.startsAt, timingOf(visit), now);
  return outcome.result === 'NOT_OPEN'
    ? 'NOT_OPEN'
    : outcome.result === 'CLOSED'
      ? 'CLOSED'
      : 'OPEN';
}

export function visitSummary(visit: TrainingVisit, now: Date) {
  const window = checkInWindow(visit.startsAt, timingOf(visit));
  return {
    visit: {
      id: visit.id,
      title: visit.title,
      date: fromDbDate(visit.date),
      startTime: fromDbTime(visit.startTime),
      endTime: visit.endTime ? fromDbTime(visit.endTime) : null,
      locationName: visit.locationName,
      status: visit.status,
    },
    window: {
      state: windowState(visit, now),
      opensAt: window.opensAt.toISOString(),
      onTimeUntil: window.onTimeUntil.toISOString(),
      closesAt: window.closesAt.toISOString(),
    },
  };
}

/** Not cancelled, and the server's clock inside the window: Present or Late (§8.2). */
export function assertOpen(visit: TrainingVisit, now: Date) {
  if (visit.status === 'CANCELLED') throw SchedulingErrors.visitCancelled();
  const outcome = classifyCheckIn(visit.startsAt, timingOf(visit), now);
  if (outcome.result === 'NOT_OPEN') {
    throw AttendanceErrors.notOpen(checkInWindow(visit.startsAt, timingOf(visit)).opensAt);
  }
  if (outcome.result === 'CLOSED') throw AttendanceErrors.closed();
  return outcome;
}

/**
 * A reading is always required; the program's policy is applied to it. Returns
 * the reading and its distance to the visit (null when the visit has no coordinates).
 */
export function assertLocation(
  reading: GeolocationReading | undefined,
  visit: TrainingVisit,
  program: TrainingProgram,
): { reading: GeolocationReading; distance: number | null } {
  if (!reading) throw AttendanceErrors.geolocationRequired();
  const policy = policyOf(program);
  const result = checkLocation(reading, visit, policy);
  if (!result.ok) {
    throw result.error === 'LOCATION_INACCURATE'
      ? AttendanceErrors.locationInaccurate(policy.maxAccuracyMeters ?? 0)
      : AttendanceErrors.locationOutsideArea(policy.radiusMeters ?? 0);
  }
  return { reading, distance: result.distanceMeters };
}
