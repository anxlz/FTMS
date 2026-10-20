import { describe, expect, it } from 'vitest';
import {
  CalendarQuerySchema,
  CreateScheduleRequestSchema,
  CreateVisitRequestSchema,
  programEndDate,
  UpdateVisitRequestSchema,
  visitPhase,
  VisitTimingSchema,
  weeklyOccurrences,
} from './contracts';
import {
  addDays,
  daysBetween,
  LocalDateSchema,
  LocalTimeSchema,
  offsetMinutes,
  todayIn,
  utcToZoned,
  weekdayOf,
  zonedToUtc,
} from './time';

const CAIRO = 'Africa/Cairo';

describe('dates and times (§16.2)', () => {
  it('validates calendar dates and wall-clock times', () => {
    expect(LocalDateSchema.safeParse('2026-02-28').success).toBe(true);
    expect(LocalDateSchema.safeParse('2026-02-29').success).toBe(false);
    expect(LocalDateSchema.safeParse('2026-2-1').success).toBe(false);
    expect(LocalTimeSchema.parse('9:30')).toBe('09:30');
    expect(LocalTimeSchema.parse('09:30:00')).toBe('09:30');
    expect(LocalTimeSchema.safeParse('24:00').success).toBe(false);
  });

  it('does date arithmetic on calendar dates', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(daysBetween('2026-10-01', '2026-10-20')).toBe(19);
    expect(weekdayOf('2026-10-20')).toBe(2); // a Tuesday
    expect(programEndDate('2026-10-03', 12)).toBe('2026-12-25');
  });

  it('converts Cairo wall-clock times to UTC across daylight saving', () => {
    // Winter: UTC+2. Summer (Egypt DST, since 2023): UTC+3.
    expect(zonedToUtc('2026-01-15', '09:00', CAIRO).toISOString()).toBe('2026-01-15T07:00:00.000Z');
    expect(zonedToUtc('2026-07-01', '09:00', CAIRO).toISOString()).toBe('2026-07-01T06:00:00.000Z');
    expect(offsetMinutes(Date.parse('2026-01-15T07:00:00Z'), CAIRO)).toBe(120);
    expect(offsetMinutes(Date.parse('2026-07-01T06:00:00Z'), CAIRO)).toBe(180);
    // Round trip keeps the announced wall-clock time.
    for (const [date, time] of [
      ['2026-04-23', '23:30'],
      ['2026-04-24', '09:00'],
      ['2026-10-29', '22:00'],
      ['2026-10-30', '09:00'],
    ] as const) {
      expect(utcToZoned(zonedToUtc(date, time, CAIRO), CAIRO)).toEqual({ date, time });
    }
  });

  it('moves a time skipped by the spring-forward jump forward, like clocks do', () => {
    // Clocks go from 00:00 to 01:00 on the last Friday of April (2026-04-24).
    const skipped = zonedToUtc('2026-04-24', '00:30', CAIRO);
    expect(utcToZoned(skipped, CAIRO)).toEqual({ date: '2026-04-24', time: '01:30' });
  });

  it('takes standard time for the repeated hour of the autumn change (as PostgreSQL does)', () => {
    // Clocks go back from 24:00 to 23:00 on the last Thursday of October (2026-10-29).
    expect(zonedToUtc('2026-10-29', '23:30', CAIRO).toISOString()).toBe('2026-10-29T21:30:00.000Z');
    expect(zonedToUtc('2026-10-29', '22:30', CAIRO).toISOString()).toBe('2026-10-29T19:30:00.000Z');
  });

  it('knows today in Cairo even when it is still yesterday in UTC', () => {
    expect(todayIn(CAIRO, new Date('2026-10-20T22:30:00Z'))).toBe('2026-10-21');
  });
});

describe('recurring schedules (§6.1)', () => {
  it('generates the weekly occurrences of a twelve-week program, minus exceptions', () => {
    const start = '2026-10-03'; // Saturday
    const dates = weeklyOccurrences({
      startsOn: start,
      endsOn: programEndDate(start, 12),
      weekdays: [0, 3], // Sundays and Wednesdays
    });
    expect(dates).toHaveLength(24);
    expect(dates.slice(0, 3)).toEqual(['2026-10-04', '2026-10-07', '2026-10-11']);
    expect(dates.every((d) => [0, 3].includes(weekdayOf(d)))).toBe(true);

    const withHoliday = weeklyOccurrences({
      startsOn: start,
      endsOn: programEndDate(start, 12),
      weekdays: [0, 3],
      skip: new Set(['2026-10-07']),
    });
    expect(withHoliday).toHaveLength(23);
    expect(withHoliday).not.toContain('2026-10-07');
  });

  it('validates schedule requests', () => {
    const base = {
      title: 'Weekly farm visit',
      weekdays: [3, 0, 3],
      startTime: '09:00',
      groupIds: ['0190a6f0-0000-7000-8000-000000000001'],
    };
    expect(CreateScheduleRequestSchema.safeParse(base).success).toBe(false); // duplicate weekday
    const ok = CreateScheduleRequestSchema.parse({ ...base, weekdays: [3, 0] });
    expect(ok.weekdays).toEqual([0, 3]);
    expect(
      CreateScheduleRequestSchema.safeParse({ ...base, weekdays: [0], endTime: '08:00' }).success,
    ).toBe(false);
    expect(
      CreateScheduleRequestSchema.safeParse({ ...base, weekdays: [0], groupIds: [] }).success,
    ).toBe(false);
  });
});

describe('visits (§6.3, §8.1)', () => {
  const visit = {
    title: 'زيارة مزرعة',
    date: '2026-11-01',
    startTime: '10:00',
    groupIds: ['0190a6f0-0000-7000-8000-000000000001', '0190a6f0-0000-7000-8000-000000000002'],
  };

  it('accepts one or several groups, never none or duplicates', () => {
    expect(CreateVisitRequestSchema.safeParse(visit).success).toBe(true);
    expect(CreateVisitRequestSchema.safeParse({ ...visit, groupIds: [] }).success).toBe(false);
    expect(
      CreateVisitRequestSchema.safeParse({
        ...visit,
        groupIds: [visit.groupIds[0], visit.groupIds[0]],
      }).success,
    ).toBe(false);
  });

  it('requires both coordinates or neither, and https map links', () => {
    expect(
      CreateVisitRequestSchema.safeParse({ ...visit, location: { latitude: 30.1 } }).success,
    ).toBe(false);
    expect(
      CreateVisitRequestSchema.safeParse({
        ...visit,
        location: { latitude: 30.1, longitude: 31.2 },
      }).success,
    ).toBe(true);
    expect(
      CreateVisitRequestSchema.safeParse({ ...visit, location: { mapUrl: 'javascript:alert(1)' } })
        .success,
    ).toBe(false);
    expect(
      CreateVisitRequestSchema.safeParse({
        ...visit,
        location: { mapUrl: 'https://maps.google.com/?q=30.1,31.2' },
      }).success,
    ).toBe(true);
  });

  it('validates the attendance timing window', () => {
    expect(
      VisitTimingSchema.safeParse({
        checkInOpensMinutes: 15,
        graceMinutes: 15,
        checkInClosesMinutes: 60,
      }).success,
    ).toBe(true);
    expect(
      VisitTimingSchema.safeParse({
        checkInOpensMinutes: 15,
        graceMinutes: 90,
        checkInClosesMinutes: 60,
      }).success,
    ).toBe(false);
    expect(UpdateVisitRequestSchema.parse({ timing: 'useDefaults' }).timing).toBe('useDefaults');
  });

  it('derives the phase from the check-in window, counting whole minutes', () => {
    // A 10:00 Cairo visit (08:00Z in winter) opening 15 and closing 60 minutes around the start.
    const visit = {
      startsAt: new Date('2026-11-01T08:00:00Z'),
      checkInOpensMinutes: 15,
      checkInClosesMinutes: 60,
    };
    expect(visitPhase(visit, new Date('2026-11-01T07:44:59Z'))).toBe('UPCOMING');
    expect(visitPhase(visit, new Date('2026-11-01T07:45:00Z'))).toBe('CHECK_IN_OPEN');
    expect(visitPhase(visit, new Date('2026-11-01T09:00:59Z'))).toBe('CHECK_IN_OPEN');
    expect(visitPhase(visit, new Date('2026-11-01T09:01:00Z'))).toBe('FINISHED');
  });

  it('limits calendar ranges', () => {
    expect(CalendarQuerySchema.safeParse({ from: '2026-10-01', to: '2026-10-31' }).success).toBe(
      true,
    );
    expect(CalendarQuerySchema.safeParse({ from: '2026-10-31', to: '2026-10-01' }).success).toBe(
      false,
    );
    expect(CalendarQuerySchema.safeParse({ from: '2026-01-01', to: '2026-12-31' }).success).toBe(
      false,
    );
  });
});
