import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  Logger,
} from '@nestjs/common';
import { type ApiErrorCode, type ApiErrorResponse } from '@ftms/core';
import type { Response } from 'express';
import { ApiException, Errors } from './api-exception';

const STATUS_CODES: Record<number, ApiErrorCode> = {
  400: 'VALIDATION_FAILED',
  401: 'AUTH_REQUIRED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  413: 'FILE_TOO_LARGE',
  429: 'AUTH_RATE_LIMITED',
};

/**
 * Every error leaves the API in the `ApiErrorResponse` shape. Unexpected errors
 * are logged with their stack and answered with a generic 500 — internals never
 * reach the client.
 */
@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('ApiExceptionFilter');

  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    const body = this.toBody(exception);
    if (body.retryAfterSeconds !== undefined) {
      res.setHeader('Retry-After', String(body.retryAfterSeconds));
    }
    res.status(body.statusCode).json(body);
  }

  private toBody(exception: unknown): ApiErrorResponse {
    if (exception instanceof ApiException) return exception.toBody();

    if (exception instanceof HttpException) {
      const statusCode = exception.getStatus();
      if (statusCode >= 500) this.logger.error(exception.message, exception.stack);
      return {
        statusCode,
        code: STATUS_CODES[statusCode] ?? 'INTERNAL_ERROR',
        message: statusCode >= 500 ? 'Internal server error' : exception.message,
      };
    }

    // Errors raised by Express's body parser before Nest sees the request
    // (malformed JSON, a body over the size limit, a wrong charset) carry a 4xx
    // status meant for the client; only the status is passed on.
    const status = clientErrorStatus(exception);
    if (status !== null) {
      return {
        statusCode: status,
        code: STATUS_CODES[status] ?? 'VALIDATION_FAILED',
        message: status === 413 ? 'Request body too large' : 'Malformed request',
      };
    }

    const error = exception instanceof Error ? exception : new Error(String(exception));
    this.logger.error(error.message, error.stack);

    // The database cannot be reached (down, paused, pool exhausted): a 503 the
    // client can present as "try again shortly", not a generic failure.
    if (isDatabaseUnavailable(exception)) return Errors.serviceUnavailable().toBody();

    return { statusCode: 500, code: 'INTERNAL_ERROR', message: 'Internal server error' };
  }
}

/**
 * Prisma's connection-level failures: P1xxx (unreachable, authentication,
 * timeouts), P2024 (connection pool timeout), P2037 (too many connections).
 * Matched by name so this file does not load the Prisma runtime.
 */
function isDatabaseUnavailable(exception: unknown): boolean {
  if (typeof exception !== 'object' || exception === null) return false;
  const { name, code } = exception as { name?: unknown; code?: unknown };
  if (name === 'PrismaClientInitializationError') return true;
  return (
    name === 'PrismaClientKnownRequestError' &&
    typeof code === 'string' &&
    (/^P10\d\d$/.test(code) || code === 'P2024' || code === 'P2037')
  );
}

/** The 4xx status of an `http-errors` error marked safe to expose, if any. */
function clientErrorStatus(exception: unknown): number | null {
  if (typeof exception !== 'object' || exception === null) return null;
  const e = exception as { status?: unknown; statusCode?: unknown; expose?: unknown };
  const status = typeof e.status === 'number' ? e.status : e.statusCode;
  return typeof status === 'number' && status >= 400 && status < 500 && e.expose === true
    ? status
    : null;
}
