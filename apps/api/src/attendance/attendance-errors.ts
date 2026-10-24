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
  biometricRequired: () =>
    new ApiException(
      400,
      'BIOMETRIC_REQUIRED',
      'Confirm this check-in with biometrics on your registered device',
    ),
  biometricNotEnrolled: () =>
    new ApiException(
      409,
      'BIOMETRIC_NOT_ENROLLED',
      'Enable biometric sign-in on your device before checking in',
    ),
  geolocationRequired: () =>
    new ApiException(400, 'GEOLOCATION_REQUIRED', 'Share your current location to check in', {
      details: { location: ['GEOLOCATION_REQUIRED'] },
    }),
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
