import { HttpException } from '@nestjs/common';
import { type ApiErrorCode, type ApiErrorResponse, type PasswordPolicyViolation } from '@ftms/core';

/**
 * The only exception feature code should throw for expected failures. It carries a
 * stable `code` that clients translate; `message` is for developers and logs.
 */
export class ApiException extends HttpException {
  constructor(
    readonly statusCode: number,
    readonly code: ApiErrorCode,
    message: string,
    readonly extras: Pick<ApiErrorResponse, 'details' | 'retryAfterSeconds'> = {},
  ) {
    super({ statusCode, code, message, ...extras } satisfies ApiErrorResponse, statusCode);
  }

  toBody(): ApiErrorResponse {
    return this.getResponse() as ApiErrorResponse;
  }
}

export const Errors = {
  authRequired: () => new ApiException(401, 'AUTH_REQUIRED', 'Authentication required'),
  invalidCredentials: () =>
    new ApiException(401, 'AUTH_INVALID_CREDENTIALS', 'Invalid credentials'),
  accountSuspended: () =>
    new ApiException(403, 'AUTH_ACCOUNT_SUSPENDED', 'This account is suspended'),
  accountPending: () =>
    new ApiException(403, 'AUTH_ACCOUNT_PENDING', 'This account is awaiting verification'),
  rateLimited: (retryAfterSeconds: number) =>
    new ApiException(429, 'AUTH_RATE_LIMITED', 'Too many attempts, try again later', {
      retryAfterSeconds,
    }),
  codeInvalid: () =>
    new ApiException(400, 'AUTH_CODE_INVALID', 'The code is invalid or has expired'),
  sessionInvalid: () =>
    new ApiException(401, 'AUTH_SESSION_INVALID', 'The session is no longer valid'),
  passwordChangeRequired: () =>
    new ApiException(403, 'AUTH_PASSWORD_CHANGE_REQUIRED', 'Set a new password first'),
  currentPasswordIncorrect: () =>
    new ApiException(400, 'AUTH_CURRENT_PASSWORD_INCORRECT', 'The current password is incorrect'),
  passwordPolicy: (violations: PasswordPolicyViolation[]) =>
    new ApiException(400, 'PASSWORD_POLICY', 'The password does not meet the policy', {
      details: { newPassword: violations },
    }),
  forbidden: () => new ApiException(403, 'FORBIDDEN', 'You do not have access to this action'),
  notFound: (what = 'Resource') => new ApiException(404, 'NOT_FOUND', `${what} not found`),
};
