import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  Logger,
} from '@nestjs/common';
import { type ApiErrorCode, type ApiErrorResponse } from '@ftms/core';
import type { Response } from 'express';
import { ApiException } from './api-exception';

const STATUS_CODES: Record<number, ApiErrorCode> = {
  400: 'VALIDATION_FAILED',
  401: 'AUTH_REQUIRED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
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

    const error = exception instanceof Error ? exception : new Error(String(exception));
    this.logger.error(error.message, error.stack);
    return { statusCode: 500, code: 'INTERNAL_ERROR', message: 'Internal server error' };
  }
}
