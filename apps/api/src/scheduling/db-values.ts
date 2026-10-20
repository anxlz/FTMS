import { type LocalDate, type LocalTime, type VisitTiming } from '@ftms/core';

/**
 * Conversions between wall-clock values and Prisma's representation of
 * Postgres `date` / `time` columns (a Date at UTC midnight / on 1970-01-01 UTC).
 */
export const toDbDate = (date: LocalDate): Date => new Date(`${date}T00:00:00.000Z`);
export const fromDbDate = (date: Date): LocalDate => date.toISOString().slice(0, 10);
export const toDbTime = (time: LocalTime): Date => new Date(`1970-01-01T${time}:00.000Z`);
export const fromDbTime = (time: Date): LocalTime => time.toISOString().slice(11, 16);

export interface TimingColumns {
  checkInOpensMinutes: number;
  graceMinutes: number;
  checkInClosesMinutes: number;
}

export const timingOf = (row: TimingColumns): VisitTiming => ({
  checkInOpensMinutes: row.checkInOpensMinutes,
  graceMinutes: row.graceMinutes,
  checkInClosesMinutes: row.checkInClosesMinutes,
});

export const sameTiming = (a: VisitTiming, b: VisitTiming): boolean =>
  a.checkInOpensMinutes === b.checkInOpensMinutes &&
  a.graceMinutes === b.graceMinutes &&
  a.checkInClosesMinutes === b.checkInClosesMinutes;

export const sameSet = (a: Iterable<string>, b: Iterable<string>): boolean => {
  const left = new Set(a);
  const right = new Set(b);
  return left.size === right.size && [...left].every((v) => right.has(v));
};

export const byName = <T extends { name: string }>(items: T[]): T[] =>
  [...items].sort((x, y) => x.name.localeCompare(y.name, 'ar'));
