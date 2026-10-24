import { type AttendanceRecord as AttendanceRecordDto } from '@ftms/core';
import { type AttendanceRecord, type Prisma } from '../generated/prisma/client';

export const RECORD_INCLUDE = {
  correctedBy: { select: { displayName: true } },
} as const satisfies Prisma.AttendanceRecordInclude;

export type RecordWithCorrector = Prisma.AttendanceRecordGetPayload<{
  include: typeof RECORD_INCLUDE;
}>;

/**
 * A record for the API. `showCorrector` is false for students: they see a
 * correction's reason, not who made it.
 */
export function toRecord(
  record: AttendanceRecord & { correctedBy?: { displayName: string } | null },
  showCorrector: boolean,
): AttendanceRecordDto {
  return {
    id: record.id,
    visitId: record.visitId,
    status: record.status,
    minutesLate: record.minutesLate,
    checkedInAt: record.checkedInAt?.toISOString() ?? null,
    source: record.source,
    biometricVerified: record.biometricVerified,
    location:
      record.latitude !== null && record.longitude !== null
        ? {
            latitude: record.latitude,
            longitude: record.longitude,
            accuracyMeters: record.accuracyMeters,
            distanceMeters: record.distanceMeters,
          }
        : null,
    correction: record.correctedAt
      ? {
          at: record.correctedAt.toISOString(),
          by: showCorrector ? (record.correctedBy?.displayName ?? null) : null,
          reason: record.correctionReason,
        }
      : null,
    updatedAt: record.updatedAt.toISOString(),
  };
}

/** The audited state of a record (no location detail, no credential). */
export const recordSnapshot = (r: AttendanceRecord) => ({
  status: r.status,
  minutesLate: r.minutesLate,
  source: r.source,
  checkedInAt: r.checkedInAt?.toISOString() ?? null,
  biometricVerified: r.biometricVerified,
});
