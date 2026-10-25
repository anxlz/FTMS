import { z } from 'zod';

/**
 * Machine-readable error codes returned by the API. Clients (web, future mobile)
 * translate codes into localized messages; they never parse `message`.
 */
export const API_ERROR_CODES = [
  'VALIDATION_FAILED',
  'AUTH_REQUIRED',
  'AUTH_INVALID_CREDENTIALS',
  'AUTH_ACCOUNT_SUSPENDED',
  'AUTH_ACCOUNT_PENDING',
  'AUTH_RATE_LIMITED',
  'AUTH_CODE_INVALID',
  'AUTH_SESSION_INVALID',
  'AUTH_PASSWORD_CHANGE_REQUIRED',
  'AUTH_CURRENT_PASSWORD_INCORRECT',
  'PASSWORD_POLICY',
  'FORBIDDEN',
  'NOT_FOUND',
  'EMAIL_ALREADY_EXISTS',
  'SEAT_NUMBER_ALREADY_EXISTS',
  'LAST_SUPER_ADMIN',
  'SELF_ACTION_FORBIDDEN',
  'ROLE_CHANGE_NOT_ALLOWED',
  'PERMISSION_NOT_GRANTABLE',
  // Phase 2 — student records, groups, imports, account linking, profile changes
  'EMAIL_NOT_UNIVERSITY',
  'EMAIL_LOCKED_BY_ACCOUNT',
  'STUDENT_LINKED_TO_ACCOUNT',
  'STUDENT_ALREADY_LINKED',
  'STUDENT_IN_OTHER_GROUP',
  'GROUP_NAME_EXISTS',
  'GROUP_ARCHIVED',
  'GROUP_NOT_EMPTY',
  'FILE_INVALID',
  'FILE_TOO_LARGE',
  'IMPORT_HEADERS_MISSING',
  'IMPORT_EMPTY',
  'IMPORT_TOO_MANY_ROWS',
  'IMPORT_NOT_OPEN',
  'IMPORT_NOT_OWNER',
  'IMPORT_PREVIEW_STALE',
  'IMPORT_HAS_ERRORS',
  'NO_CHANGES',
  'PROFILE_CHANGE_PENDING',
  'REQUEST_ALREADY_DECIDED',
  'ACCOUNT_ALREADY_VERIFIED',
  'VERIFICATION_PENDING',
  // Phase 3 — programs, schedules, visits, files, notifications
  'PROGRAM_NOT_CONFIGURED',
  'SCHEDULE_ENDED',
  'EXCEPTION_EXISTS',
  'VISIT_CANCELLED',
  'VISIT_NOT_CANCELLED',
  'VISIT_ALREADY_HELD',
  'FILE_TYPE_NOT_ALLOWED',
  'PROGRAM_EXISTS',
  'DATE_OUTSIDE_PROGRAM',
  'VISIT_IN_PAST',
  'TOO_MANY_FILES',
  'STORAGE_UNAVAILABLE',
  // Phase 4 — attendance, biometrics, exports (biometric check-in codes removed in Phase 8)
  'QR_INVALID',
  'NOT_IN_VISIT_GROUP',
  'CHECK_IN_NOT_OPEN',
  'CHECK_IN_CLOSED',
  'ATTENDANCE_ALREADY_RECORDED',
  'BIOMETRIC_FAILED',
  'BIOMETRIC_REAUTH_REQUIRED',
  'BIOMETRIC_CREDENTIAL_EXISTS',
  'GEOLOCATION_REQUIRED',
  'VISIT_NOT_STARTED',
  'EXPORT_TOO_LARGE',
  'STUDENT_HAS_ATTENDANCE',
  // Phase 5 — support tickets, group swaps
  'TICKET_CLOSED',
  'TICKET_MANAGED_BY_SWAP',
  'SWAP_NO_GROUP',
  'SWAP_SAME_GROUP',
  'SWAP_SELF',
  'SWAP_COUNTERPART_NOT_FOUND',
  'SWAP_CONFLICT',
  'SWAP_NOT_ALLOWED',
  'SWAP_STALE',
  // Phase 7 — a dependency (e.g. Redis for rate limits) cannot be reached
  'SERVICE_UNAVAILABLE',
  // Phase 8 — check-in location policy
  'LOCATION_INACCURATE',
  'LOCATION_OUTSIDE_AREA',
  'INTERNAL_ERROR',
] as const;

export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

export const ApiErrorResponseSchema = z.object({
  statusCode: z.number().int(),
  code: z.enum(API_ERROR_CODES),
  message: z.string(),
  /** Field → list of validation codes (VALIDATION_FAILED) or policy violations. */
  details: z.record(z.string(), z.array(z.string())).optional(),
  /** Seconds until a rate-limited request may be retried. */
  retryAfterSeconds: z.number().int().nonnegative().optional(),
});
export type ApiErrorResponse = z.infer<typeof ApiErrorResponseSchema>;
