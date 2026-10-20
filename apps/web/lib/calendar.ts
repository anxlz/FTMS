import { addDays, type LocalDate, parseLocalDate, WEEK_STARTS_ON, weekdayOf } from '@ftms/core';

/** `YYYY-MM` */
export type Month = string;

const MONTH = /^(\d{4})-(\d{2})$/;

/** The month in `value`, or the month of `today` when it is missing or malformed. */
export function parseMonth(value: string | undefined, today: LocalDate): Month {
  const m = value ? MONTH.exec(value) : null;
  if (m && Number(m[2]) >= 1 && Number(m[2]) <= 12) return value!;
  return today.slice(0, 7);
}

export const firstDayOf = (month: Month): LocalDate => `${month}-01`;

export function lastDayOf(month: Month): LocalDate {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const next = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
  return addDays(next, -1);
}

export function shiftMonth(month: Month, by: number): Month {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const index = y * 12 + (m - 1) + by;
  return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, '0')}`;
}

/**
 * Weeks covering the month, each from Saturday to Friday (§18.1: the Egyptian
 * week). Days outside the month are included so every row is complete.
 */
export function monthGrid(month: Month): LocalDate[][] {
  const first = firstDayOf(month);
  const last = lastDayOf(month);
  let day = addDays(first, -((weekdayOf(first) - WEEK_STARTS_ON + 7) % 7));
  const weeks: LocalDate[][] = [];
  while (day <= last) {
    const week: LocalDate[] = [];
    for (let i = 0; i < 7; i += 1) {
      week.push(day);
      day = addDays(day, 1);
    }
    weeks.push(week);
  }
  return weeks;
}

/** Weekday indexes (0 = Sunday) in display order, starting on Saturday. */
export const WEEK_ORDER: readonly number[] = Array.from(
  { length: 7 },
  (_, i) => (WEEK_STARTS_ON + i) % 7,
);

/** A Date at noon UTC on `date`: formats as that same day in Africa/Cairo. */
export const dayValue = (date: LocalDate): Date => new Date(`${date}T12:00:00Z`);

/** A reference date falling on `weekday` (0 = Sunday), for localized weekday names. */
export const dateOfWeekday = (weekday: number): LocalDate => addDays('2026-01-04', weekday);

export const isLocalDate = (value: string | undefined): value is LocalDate =>
  value !== undefined && parseLocalDate(value) !== null;
