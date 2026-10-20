import { ApiException } from '../common/api-exception';

/** Expected failures of the student-records area, with stable codes (see @ftms/core). */
export const StudentErrors = {
  seatTaken: () =>
    new ApiException(409, 'SEAT_NUMBER_ALREADY_EXISTS', 'Seat number already in use', {
      details: { seatNumber: ['SEAT_NUMBER_ALREADY_EXISTS'] },
    }),
  emailTaken: (field = 'universityEmail') =>
    new ApiException(409, 'EMAIL_ALREADY_EXISTS', 'Email already in use', {
      details: { [field]: ['EMAIL_ALREADY_EXISTS'] },
    }),
  notUniversityEmail: (field = 'universityEmail') =>
    new ApiException(400, 'EMAIL_NOT_UNIVERSITY', 'Use a university email address', {
      details: { [field]: ['EMAIL_NOT_UNIVERSITY'] },
    }),
  emailLocked: () =>
    new ApiException(
      409,
      'EMAIL_LOCKED_BY_ACCOUNT',
      "The record is linked to an account; its email is the account's verified email",
      { details: { universityEmail: ['EMAIL_LOCKED_BY_ACCOUNT'] } },
    ),
  linkedToAccount: () =>
    new ApiException(409, 'STUDENT_LINKED_TO_ACCOUNT', 'The record is linked to an account'),
  alreadyLinked: () =>
    new ApiException(409, 'STUDENT_ALREADY_LINKED', 'The record is already linked to an account'),
  inOtherGroup: (studentIds: string[]) =>
    new ApiException(409, 'STUDENT_IN_OTHER_GROUP', 'Student is already in another group', {
      details: { studentIds },
    }),
  groupNameTaken: () =>
    new ApiException(409, 'GROUP_NAME_EXISTS', 'A group with this name already exists', {
      details: { name: ['GROUP_NAME_EXISTS'] },
    }),
  groupArchived: () =>
    new ApiException(409, 'GROUP_ARCHIVED', 'The group is archived and accepts no members'),
  groupNotEmpty: () =>
    new ApiException(409, 'GROUP_NOT_EMPTY', 'Remove every member before archiving the group'),
  noChanges: () => new ApiException(409, 'NO_CHANGES', 'Nothing would change'),
  profileChangePending: () =>
    new ApiException(
      409,
      'PROFILE_CHANGE_PENDING',
      'A profile change request is already waiting for review',
    ),
  alreadyDecided: () =>
    new ApiException(409, 'REQUEST_ALREADY_DECIDED', 'This request has already been decided'),
  accountAlreadyVerified: () =>
    new ApiException(409, 'ACCOUNT_ALREADY_VERIFIED', 'This account is already verified'),
  verificationPending: () =>
    new ApiException(409, 'VERIFICATION_PENDING', 'A verification request is already under review'),
  fileInvalid: (reason: string) =>
    new ApiException(400, 'FILE_INVALID', `The file could not be read: ${reason}`),
  fileTooLarge: () => new ApiException(413, 'FILE_TOO_LARGE', 'The file is too large'),
  headersMissing: (missing: string[]) =>
    new ApiException(400, 'IMPORT_HEADERS_MISSING', 'Required columns are missing', {
      details: { columns: missing },
    }),
  importEmpty: () => new ApiException(400, 'IMPORT_EMPTY', 'The spreadsheet has no student rows'),
  importTooManyRows: (max: number) =>
    new ApiException(400, 'IMPORT_TOO_MANY_ROWS', `At most ${max} rows per import`),
  importNotOpen: () =>
    new ApiException(
      409,
      'IMPORT_NOT_OPEN',
      'This import was already committed, discarded or has expired',
    ),
  importNotOwner: () =>
    new ApiException(
      403,
      'IMPORT_NOT_OWNER',
      'Only the person who uploaded the file can commit it',
    ),
  importStale: () =>
    new ApiException(
      409,
      'IMPORT_PREVIEW_STALE',
      'Student data changed since the preview; review the new preview',
    ),
  importHasErrors: () =>
    new ApiException(
      409,
      'IMPORT_HAS_ERRORS',
      'Some rows have errors; confirm that they will be skipped',
    ),
};
