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
