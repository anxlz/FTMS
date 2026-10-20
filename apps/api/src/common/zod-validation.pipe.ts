import { type PipeTransform } from '@nestjs/common';
import { type z } from 'zod';
import { ApiException } from './api-exception';

/**
 * Validates and normalizes a request part with a shared `@ftms/core` schema, so
 * the API and its clients agree on exactly one definition of every payload.
 */
export class ZodValidationPipe<T extends z.ZodType> implements PipeTransform<unknown, z.infer<T>> {
  constructor(private readonly schema: T) {}

  transform(value: unknown): z.infer<T> {
    const result = this.schema.safeParse(value ?? {});
    if (result.success) return result.data;

    const details: Record<string, string[]> = {};
    for (const issue of result.error.issues) {
      const field = issue.path.length > 0 ? issue.path.join('.') : '_';
      (details[field] ??= []).push(issue.message);
    }
    throw new ApiException(400, 'VALIDATION_FAILED', 'Request validation failed', { details });
  }
}
