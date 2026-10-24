import { describe, expect, it } from 'vitest';
import { zonedToUtc } from '../scheduling/time';
import {
  attendanceTotals,
  checkInWindow,
  classifyCheckIn,
  distanceMeters,
  elapsedMinutes,
} from './classification';
import {
  CheckInRequestSchema,
  CorrectAttendanceRequestSchema,
  ExportQuerySchema,
} from './contracts';

const DEFAULTS = { checkInOpensMinutes: 15, graceMinutes: 15, checkInClosesMinutes: 60 };
const CAIRO = 'Africa/Cairo';
/** A 10:00 visit in Cairo, and a clock reading on its day. */
const start = zonedToUtc('2026-11-01', '10:00', CAIRO);
const at = (time: string) => {
  const [h, m, s = '0'] = time.split(':');
  return new Date(zonedToUtc('2026-11-01', `${h}:${m}`, CAIRO).getTime() + Number(s) * 1000);
};

describe('attendance classification (§8.2, §20.2)', () => {
  it.each([
    ['09:44', { result: 'NOT_OPEN' }],
    ['09:44:59', { result: 'NOT_OPEN' }],
    ['09:45', { result: 'PRESENT', minutesLate: 0 }],
    ['10:00', { result: 'PRESENT', minutesLate: 0 }],
    ['10:15', { result: 'PRESENT', minutesLate: 0 }],
    ['10:15:59', { result: 'PRESENT', minutesLate: 0 }],
    ['10:16', { result: 'LATE', minutesLate: 1 }],
    ['10:30:30', { result: 'LATE', minutesLate: 15 }],
    ['11:00', { result: 'LATE', minutesLate: 45 }],
    ['11:00:59', { result: 'LATE', minutesLate: 45 }],
    ['11:01', { result: 'CLOSED' }],
    ['13:00', { result: 'CLOSED' }],
  ])('a check-in at %s on a 10:00 visit → %o', (time, outcome) => {
    expect(classifyCheckIn(start, DEFAULTS, at(time))).toEqual(outcome);
  });

  it('counts whole minutes elapsed, discarding seconds', () => {
    expect(elapsedMinutes(start, at('10:00:59'))).toBe(0);
    expect(elapsedMinutes(start, at('09:59:59'))).toBe(-1);
  });

  it('follows the visit’s own timing when it is overridden', () => {
    const custom = { checkInOpensMinutes: 5, graceMinutes: 0, checkInClosesMinutes: 30 };
    expect(classifyCheckIn(start, custom, at('09:54'))).toEqual({ result: 'NOT_OPEN' });
    expect(classifyCheckIn(start, custom, at('10:00:30'))).toEqual({
      result: 'PRESENT',
      minutesLate: 0,
    });
    expect(classifyCheckIn(start, custom, at('10:01'))).toEqual({ result: 'LATE', minutesLate: 1 });
    expect(classifyCheckIn(start, custom, at('10:31'))).toEqual({ result: 'CLOSED' });
  });

  it('expresses the window as instants, on the same convention', () => {
    const w = checkInWindow(start, DEFAULTS);
    expect(w.opensAt).toEqual(at('09:45'));
    expect(w.onTimeUntil).toEqual(at('10:16'));
    expect(w.closesAt).toEqual(at('11:01'));
  });

  it('uses the instant of the scheduled Cairo time across daylight saving', () => {
    // 10:00 in summer is 07:00Z; in winter 08:00Z. The same wall-clock rule applies.
    const summer = zonedToUtc('2026-07-01', '10:00', CAIRO);
    expect(summer.toISOString()).toBe('2026-07-01T07:00:00.000Z');
    expect(classifyCheckIn(summer, DEFAULTS, new Date('2026-07-01T07:16:00Z'))).toEqual({
      result: 'LATE',
      minutesLate: 1,
    });
    expect(classifyCheckIn(start, DEFAULTS, new Date('2026-11-01T08:15:00Z'))).toEqual({
      result: 'PRESENT',
      minutesLate: 0,
    });
  });
});

describe('attendance totals (§9.2)', () => {
  it('computes remaining absences from the configured allowance, never below zero', () => {
    expect(attendanceTotals(['PRESENT', 'LATE', 'ABSENT'], 2)).toEqual({
      attended: 2,
      present: 1,
      late: 1,
      absent: 1,
      remainingAbsences: 1,
    });
    expect(attendanceTotals(['ABSENT', 'ABSENT', 'ABSENT'], 2).remainingAbsences).toBe(0);
    expect(attendanceTotals(['ABSENT'], 5).remainingAbsences).toBe(4);
  });

  it('measures the distance to the visit as supporting context', () => {
    expect(distanceMeters({ latitude: 30, longitude: 31 }, { latitude: 30, longitude: 31 })).toBe(
      0,
    );
    const d = distanceMeters(
      { latitude: 30.0444, longitude: 31.2357 },
      { latitude: 30.1131, longitude: 31.2463 },
    );
    expect(d).toBeGreaterThan(7_000);
    expect(d).toBeLessThan(8_000);
  });
});

describe('attendance requests', () => {
  it('requires minutes for a late correction, and only then', () => {
    expect(CorrectAttendanceRequestSchema.safeParse({ status: 'LATE' }).success).toBe(false);
    expect(
      CorrectAttendanceRequestSchema.safeParse({ status: 'LATE', minutesLate: 12 }).success,
    ).toBe(true);
    expect(
      CorrectAttendanceRequestSchema.safeParse({ status: 'PRESENT', minutesLate: 3 }).success,
    ).toBe(false);
    expect(CorrectAttendanceRequestSchema.parse({ status: 'ABSENT', reason: '  ' }).reason).toBe(
      undefined,
    );
  });

  it('validates check-in payloads', () => {
    expect(CheckInRequestSchema.safeParse({ token: 'short' }).success).toBe(false);
    expect(
      CheckInRequestSchema.safeParse({
        token: 'AZaz09_-AZaz09_-AZaz09',
        location: { latitude: 91, longitude: 0 },
      }).success,
    ).toBe(false);
    expect(
      CheckInRequestSchema.safeParse({
        token: 'AZaz09_-AZaz09_-AZaz09',
        location: { latitude: 30.1, longitude: 31.2, accuracy: 12 },
      }).success,
    ).toBe(true);
  });

  it('defaults exports to Arabic and checks the date range', () => {
    expect(ExportQuerySchema.parse({ format: 'csv' }).locale).toBe('ar');
    expect(
      ExportQuerySchema.safeParse({ format: 'pdf', from: '2026-11-02', to: '2026-11-01' }).success,
    ).toBe(false);
  });
});
