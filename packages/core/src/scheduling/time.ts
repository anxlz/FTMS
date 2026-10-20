import { z } from 'zod';

/**
 * Calendar dates and wall-clock times of the training program (§16.2). Visits
 * are scheduled as a local date + local time in the program's time zone
 * (Africa/Cairo); the instant in UTC is derived from them, so daylight-saving
 * changes never shift a visit's announced time. All functions are pure.
 */

/** `YYYY-MM-DD` (a calendar date, no time zone). */
export type LocalDate = string;
/** `HH:MM` (24-hour wall-clock time). */
export type LocalTime = string;

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function parseLocalDate(
  date: LocalDate,
): { year: number; month: number; day: number } | null {
  const m = DATE_PATTERN.exec(date);
  if (!m) return null;
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (
    probe.getUTCFullYear() !== year ||
    probe.getUTCMonth() !== month - 1 ||
    probe.getUTCDate() !== day
  ) {
    return null;
  }
  return { year, month, day };
}

export function parseLocalTime(time: LocalTime): { hour: number; minute: number } | null {
  const m = TIME_PATTERN.exec(time);
  return m ? { hour: Number(m[1]), minute: Number(m[2]) } : null;
}

export const LocalDateSchema = z
  .string()
  .trim()
  .refine((v) => parseLocalDate(v) !== null, { error: 'DATE_INVALID' });

export const LocalTimeSchema = z
  .string()
  .trim()
  .transform((v) => (/^\d:\d{2}$/.test(v) ? `0${v}` : v.slice(0, 5)))
  .refine((v) => parseLocalTime(v) !== null, { error: 'TIME_INVALID' });

/** Minutes since midnight. */
export const minutesOf = (time: LocalTime): number => {
  const t = parseLocalTime(time);
  if (!t) throw new RangeError(`Invalid time ${time}`);
  return t.hour * 60 + t.minute;
};

const dayNumber = (date: LocalDate): number => {
  const d = parseLocalDate(date);
  if (!d) throw new RangeError(`Invalid date ${date}`);
  return Date.UTC(d.year, d.month - 1, d.day) / 86_400_000;
};

const fromDayNumber = (n: number): LocalDate => new Date(n * 86_400_000).toISOString().slice(0, 10);

export const addDays = (date: LocalDate, days: number): LocalDate =>
  fromDayNumber(dayNumber(date) + days);

/** Days from `a` to `b` (positive when `b` is later). */
export const daysBetween = (a: LocalDate, b: LocalDate): number => dayNumber(b) - dayNumber(a);

/** 0 = Sunday … 6 = Saturday (as `Date#getUTCDay`). */
export const weekdayOf = (date: LocalDate): number =>
  new Date(dayNumber(date) * 86_400_000).getUTCDay();

/** The first day of the training week in Egypt (§18.1 calendars). */
export const WEEK_STARTS_ON = 6; // Saturday

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(timeZone, f);
  }
  return f;
}

/** Wall-clock fields of an instant in `timeZone`. */
function wallClock(instant: number, timeZone: string) {
  const parts = Object.fromEntries(
    formatterFor(timeZone)
      .formatToParts(new Date(instant))
      .map((p) => [p.type, p.value]),
  ) as Record<string, string>;
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
}

/** UTC offset of `timeZone` at `instant`, in minutes (Cairo: +120 or +180). */
export function offsetMinutes(instant: number, timeZone: string): number {
  const w = wallClock(instant, timeZone);
  const asUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
  return Math.round((asUtc - Math.floor(instant / 1000) * 1000) / 60_000);
}

/**
 * The UTC instant of a local date + time in `timeZone`. A time that does not
 * exist (skipped by a daylight-saving jump) moves forward by the jump, as
 * clocks do; an ambiguous one (a repeated hour) takes the later instant
 * (standard time). Both rules match PostgreSQL's `timestamp AT TIME ZONE`,
 * which derives the stored instants (`training_visits_instants` trigger).
 */
export function zonedToUtc(date: LocalDate, time: LocalTime, timeZone: string): Date {
  const d = parseLocalDate(date);
  const t = parseLocalTime(time);
  if (!d || !t) throw new RangeError(`Invalid local date/time ${date} ${time}`);
  const local = Date.UTC(d.year, d.month - 1, d.day, t.hour, t.minute);
  // Offsets in force half a day before and after: any transition that day lies between them.
  const before = local - offsetMinutes(local - 43_200_000, timeZone) * 60_000;
  const after = local - offsetMinutes(local + 43_200_000, timeZone) * 60_000;
  const shows = (instant: number) => {
    const w = wallClock(instant, timeZone);
    return (
      w.year === d.year &&
      w.month === d.month &&
      w.day === d.day &&
      w.hour === t.hour &&
      w.minute === t.minute
    );
  };
  const valid = [before, after].filter(shows);
  if (valid.length > 0) return new Date(Math.max(...valid));
  return new Date(before); // in a gap: the earlier offset lands just after the jump
}

/** Local date and time of an instant in `timeZone`. */
export function utcToZoned(instant: Date, timeZone: string): { date: LocalDate; time: LocalTime } {
  const w = wallClock(instant.getTime(), timeZone);
  const pad = (n: number) => String(n).padStart(2, '0');
  return {
    date: `${w.year}-${pad(w.month)}-${pad(w.day)}`,
    time: `${pad(w.hour)}:${pad(w.minute)}`,
  };
}

/** Today's date in `timeZone`. */
export const todayIn = (timeZone: string, now: Date = new Date()): LocalDate =>
  utcToZoned(now, timeZone).date;
