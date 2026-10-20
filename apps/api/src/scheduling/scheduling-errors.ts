import { ApiException } from '../common/api-exception';

/** Expected failures of scheduling and visits, with stable codes (see @ftms/core). */
export const SchedulingErrors = {
  programNotConfigured: () =>
    new ApiException(
      409,
      'PROGRAM_NOT_CONFIGURED',
      'The training program has not been configured yet',
    ),
  programExists: () =>
    new ApiException(409, 'PROGRAM_EXISTS', 'A training program is already configured'),
  outsideProgram: (field: string) =>
    new ApiException(400, 'DATE_OUTSIDE_PROGRAM', 'The date is outside the training program', {
      details: { [field]: ['DATE_OUTSIDE_PROGRAM'] },
    }),
  inPast: (field = 'date') =>
    new ApiException(400, 'VISIT_IN_PAST', 'That date and time have already passed', {
      details: { [field]: ['VISIT_IN_PAST'] },
    }),
  invalid: (field: string, code: string) =>
    new ApiException(400, 'VALIDATION_FAILED', 'Request validation failed', {
      details: { [field]: [code] },
    }),
  trainingWide: () =>
    new ApiException(
      403,
      'FORBIDDEN',
      'A schedule for every group is the training-wide schedule; only its managers can change it',
    ),
  scheduleEnded: () => new ApiException(409, 'SCHEDULE_ENDED', 'This schedule has ended'),
  exceptionExists: () =>
    new ApiException(409, 'EXCEPTION_EXISTS', 'That day is already marked as a day off', {
      details: { date: ['EXCEPTION_EXISTS'] },
    }),
  visitCancelled: () =>
    new ApiException(409, 'VISIT_CANCELLED', 'The visit is cancelled; restore it first'),
  visitNotCancelled: () =>
    new ApiException(409, 'VISIT_NOT_CANCELLED', 'The visit is not cancelled'),
  visitHeld: () =>
    new ApiException(
      409,
      'VISIT_ALREADY_HELD',
      'Check-in for this visit has already opened; its date, time, groups and timing are fixed',
    ),
  visitOver: () =>
    new ApiException(409, 'VISIT_ALREADY_HELD', 'This visit is over and can no longer change'),
  fileTypeNotAllowed: () =>
    new ApiException(400, 'FILE_TYPE_NOT_ALLOWED', 'This type of file is not accepted here', {
      details: { file: ['FILE_TYPE_NOT_ALLOWED'] },
    }),
  tooManyFiles: (max: number) =>
    new ApiException(409, 'TOO_MANY_FILES', `A visit holds at most ${max} documents`),
  storageUnavailable: () =>
    new ApiException(503, 'STORAGE_UNAVAILABLE', 'File storage is not available'),
};
