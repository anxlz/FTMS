import { type AttendanceStatus } from '@ftms/core';
import { ApiException } from '../common/api-exception';

/** Expected failures of check-in and attendance management (see @ftms/core codes). */
export const AttendanceErrors = {
  qrInvalid: () =>
    new ApiException(404, 'QR_INVALID', 'This QR code is not a valid attendance code'),
  notInGroup: () => new ApiException(403, 'NOT_IN_VISIT_GROUP', 'This visit is not for your group'),
  studentNotInGroup: () =>
    new ApiException(
      409,
      'NOT_IN_VISIT_GROUP',
      'The student is not in any of this visit’s groups and has no record for it',
    ),
  notOpen: (opensAt: Date) =>
    new ApiException(409, 'CHECK_IN_NOT_OPEN', `Check-in opens at ${opensAt.toISOString()}`),
  closed: () => new ApiException(409, 'CHECK_IN_CLOSED', 'Check-in for this visit has closed'),
  already: (status: AttendanceStatus) =>
    new ApiException(409, 'ATTENDANCE_ALREADY_RECORDED', 'Attendance is already recorded', {
      details: { status: [status] },
    }),
  geolocationRequired: () =>
    new ApiException(400, 'GEOLOCATION_REQUIRED', 'Share your current location to check in', {
      details: { location: ['GEOLOCATION_REQUIRED'] },
    }),
  /** The reading's reported accuracy is worse than the program allows. */
  locationInaccurate: (maxAccuracyMeters: number) =>
    new ApiException(
      422,
      'LOCATION_INACCURATE',
      `The location reading is not precise enough (at most ${maxAccuracyMeters} m is accepted)`,
      { details: { location: ['LOCATION_INACCURATE'] } },
    ),
  /** The reading is farther from the visit than the program allows. */
  locationOutsideArea: (radiusMeters: number) =>
    new ApiException(
      422,
      'LOCATION_OUTSIDE_AREA',
      `The location is outside the permitted area (${radiusMeters} m around the visit)`,
      { details: { location: ['LOCATION_OUTSIDE_AREA'] } },
    ),
  visitNotStarted: () =>
    new ApiException(
      409,
      'VISIT_NOT_STARTED',
      'Attendance can be recorded once check-in for the visit has opened',
    ),
  exportTooLarge: (max: number) =>
    new ApiException(
      422,
      'EXPORT_TOO_LARGE',
      `The report has more than ${max} rows; narrow it with filters`,
    ),
};
