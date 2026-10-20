import { Prisma } from '../generated/prisma/client';

export interface DbViolation {
  kind: 'unique' | 'check';
  /** Unique: the index or constraint name. */
  index?: string;
  /** Check (incl. trigger RAISE ... check_violation): the database message. */
  message?: string;
}

interface AdapterCause {
  originalCode?: string;
  originalMessage?: string;
  message?: string;
  constraint?: { index?: string; fields?: string[] };
}

const causeOf = (error: unknown): AdapterCause | undefined => {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    const adapter = (error.meta as { driverAdapterError?: { cause?: AdapterCause } } | undefined)
      ?.driverAdapterError;
    return adapter?.cause;
  }
  // Deferred constraint triggers fail at COMMIT, outside a Prisma query: the
  // driver adapter error surfaces unwrapped.
  if (error instanceof Error && error.name === 'DriverAdapterError') {
    return (error as Error & { cause?: AdapterCause }).cause ?? { message: error.message };
  }
  return undefined;
};

/**
 * Recognizes unique and check violations raised by Postgres (constraints,
 * partial unique indexes, integrity triggers) so services can answer with a
 * precise 409 instead of a 500. Services check the same rules up front; this is
 * for the races those checks cannot exclude.
 */
export function dbViolation(error: unknown): DbViolation | null {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
    const cause = causeOf(error);
    const target = (error.meta as { target?: unknown } | undefined)?.target;
    return {
      kind: 'unique',
      index: cause?.constraint?.index ?? (typeof target === 'string' ? target : undefined),
    };
  }
  const cause = causeOf(error);
  const sqlState = cause?.originalCode;
  if (sqlState === '23505') return { kind: 'unique', index: cause?.constraint?.index };
  if (sqlState === '23514' || (error instanceof Error && error.name === 'DriverAdapterError')) {
    return { kind: 'check', message: cause?.originalMessage ?? cause?.message };
  }
  return null;
}

export const isUniqueViolation = (error: unknown, index: string): boolean => {
  const violation = dbViolation(error);
  return violation?.kind === 'unique' && violation.index === index;
};
