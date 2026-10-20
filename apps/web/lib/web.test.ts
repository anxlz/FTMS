import {
  API_ERROR_CODES,
  IMPORT_COLUMNS,
  IMPORT_ROW_ACTIONS,
  IMPORT_ROW_ERRORS,
  IMPORT_STATUSES,
  MEMBERSHIP_SOURCES,
  PERMISSION_KEYS,
  PROTECTED_PROFILE_FIELDS,
  REQUEST_STATUSES,
  ROLES,
  ROLE_DEFAULT_PERMISSIONS,
  VERIFICATION_ISSUES,
  VISIT_FILE_KINDS,
  VISIT_PHASES,
  VISIT_STATUSES,
  weekdayOf,
} from '@ftms/core';
import { describe, expect, it } from 'vitest';
import ar from '../messages/ar.json';
import en from '../messages/en.json';
import { intlLocale, resolveLocale } from '../i18n/locale';
import { needsRefresh, tokenExpiresAt } from './auth/tokens';
import { lastDayOf, monthGrid, parseMonth, shiftMonth, WEEK_ORDER } from './calendar';
import { showValue } from './display';
import { navigationFor } from './navigation';
import { permissionMessageKey } from './permission-label';

type Tree = { [key: string]: string | Tree };

const keys = (tree: Tree, prefix = ''): string[] =>
  Object.entries(tree).flatMap(([k, v]) =>
    typeof v === 'string' ? [`${prefix}${k}`] : keys(v, `${prefix}${k}.`),
  );

const lookup = (tree: Tree, path: string): unknown =>
  path.split('.').reduce<unknown>((node, part) => (node as Tree | undefined)?.[part], tree);

describe('message catalogs', () => {
  it('Arabic and English define exactly the same keys', () => {
    expect(keys(ar as Tree).sort()).toEqual(keys(en as Tree).sort());
  });

  it('translate every API error code, role and permission', () => {
    for (const catalog of [ar, en] as Tree[]) {
      for (const code of API_ERROR_CODES)
        expect(lookup(catalog, `errors.${code}`)).toEqual(expect.any(String));
      for (const role of ROLES)
        expect(lookup(catalog, `roles.${role}`)).toEqual(expect.any(String));
      for (const key of PERMISSION_KEYS)
        expect(lookup(catalog, permissionMessageKey(key))).toEqual(expect.any(String));
    }
  });

  it('translate every Phase 2 code: import rows, statuses, issues, columns', () => {
    const required = [
      ...IMPORT_ROW_ERRORS.map((c) => `importErrors.${c}`),
      ...IMPORT_ROW_ACTIONS.map((c) => `imports.action.${c}`),
      ...IMPORT_STATUSES.map((c) => `imports.status.${c}`),
      ...IMPORT_COLUMNS.map((c) => `imports.columnNames.${c}`),
      ...PROTECTED_PROFILE_FIELDS.map((c) => `imports.columnNames.${c}`),
      ...REQUEST_STATUSES.map((c) => `reviews.statuses.${c}`),
      ...VERIFICATION_ISSUES.map((c) => `reviews.issues.${c}`),
      ...VERIFICATION_ISSUES.map((c) => `reviews.issueHints.${c}`),
      ...MEMBERSHIP_SOURCES.map((c) => `students.sources.${c}`),
    ];
    for (const catalog of [ar, en] as Tree[]) {
      for (const key of required)
        expect([key, lookup(catalog, key)]).toEqual([key, expect.any(String)]);
    }
  });

  it('translate every Phase 3 code: visit statuses, phases, file kinds', () => {
    const required = [
      ...VISIT_STATUSES.map((c) => `visits.status.${c}`),
      ...VISIT_PHASES.map((c) => `visits.phase.${c}`),
      ...VISIT_FILE_KINDS.map((c) => `visits.files.kinds.${c}`),
    ];
    for (const catalog of [ar, en] as Tree[]) {
      for (const key of required)
        expect([key, lookup(catalog, key)]).toEqual([key, expect.any(String)]);
    }
  });

  it('never uses dots inside a key (next-intl reads them as nesting)', () => {
    const dotted = (tree: Tree): string[] =>
      Object.entries(tree).flatMap(([k, v]) => [
        ...(k.includes('.') ? [k] : []),
        ...(typeof v === 'string' ? [] : dotted(v)),
      ]);
    expect(dotted(ar as Tree)).toEqual([]);
    expect(dotted(en as Tree)).toEqual([]);
  });

  it('uses Western digits only, in Arabic too (§18.1)', () => {
    expect(JSON.stringify(ar)).not.toMatch(/[٠-٩]/);
  });
});

describe('locale', () => {
  it('defaults to Arabic and accepts only supported locales', () => {
    expect(resolveLocale(undefined)).toBe('ar');
    expect(resolveLocale('fr')).toBe('ar');
    expect(resolveLocale('en')).toBe('en');
  });

  it('formats Arabic numbers and dates with Western digits', () => {
    const number = new Intl.NumberFormat(intlLocale('ar')).format(1234567);
    const date = new Intl.DateTimeFormat(intlLocale('ar'), {
      dateStyle: 'long',
      timeZone: 'Africa/Cairo',
    }).format(new Date('2026-10-20T12:00:00Z'));
    expect(number).toMatch(/\d/);
    expect(number).not.toMatch(/[٠-٩]/);
    expect(date).toContain('2026');
    expect(date).toContain('أكتوبر');
  });
});

describe('access token expiry', () => {
  const token = (exp: number) =>
    `x.${Buffer.from(JSON.stringify({ exp })).toString('base64url')}.y`;

  it('reads exp without verifying the signature', () => {
    expect(tokenExpiresAt(token(1_900_000_000))).toBe(1_900_000_000_000);
    expect(tokenExpiresAt('garbage')).toBeNull();
  });

  it('refreshes when missing, unreadable, or within 60 s of expiry', () => {
    const now = 1_800_000_000_000;
    expect(needsRefresh(undefined, now)).toBe(true);
    expect(needsRefresh('garbage', now)).toBe(true);
    expect(needsRefresh(token(now / 1000 + 30), now)).toBe(true);
    expect(needsRefresh(token(now / 1000 + 600), now)).toBe(false);
  });
});

describe('navigation per role (§18.2)', () => {
  const nav = (role: (typeof ROLES)[number], permissions = ROLE_DEFAULT_PERMISSIONS[role]) =>
    navigationFor({ role, permissions: [...permissions] }).map((i) => i.key);

  it('gives students only their own sections', () => {
    expect(nav('STUDENT')).toEqual([
      'dashboard',
      'trainingCalendar',
      'attendanceHistory',
      'notifications',
      'tickets',
      'profile',
    ]);
  });

  it('shows faculty their operational sections but not accounts or audit logs', () => {
    const items = nav('FACULTY');
    expect(items).toEqual(
      expect.arrayContaining([
        'students',
        'visits',
        'groups',
        'reviewQueues',
        'attendance',
        'tickets',
        'groupSwaps',
        'settings',
      ]),
    );
    expect(items).not.toContain('users');
    expect(items).not.toContain('activityLogs');
    expect(items).not.toContain('schedule');
  });

  it('adds schedule, activity logs, reports, review queues and accounts for the Training Director', () => {
    expect(nav('TRAINING_DIRECTOR')).toEqual(
      expect.arrayContaining(['schedule', 'activityLogs', 'reports', 'reviewQueues', 'users']),
    );
  });

  it('follows per-user grants, not just roles', () => {
    expect(nav('FACULTY', [...ROLE_DEFAULT_PERMISSIONS.FACULTY, 'users.read'])).toContain('users');
  });

  it('links only to pages that exist; later-phase items carry their phase', () => {
    for (const item of navigationFor({ role: 'SUPER_ADMIN', permissions: [...PERMISSION_KEYS] })) {
      if (item.href) {
        expect([
          '/dashboard',
          '/profile',
          '/admin/users',
          '/students',
          '/groups',
          '/reviews',
          '/calendar',
          '/notifications',
          '/visits',
          '/schedule',
        ]).toContain(item.href);
      } else expect(item.phase).toBeGreaterThanOrEqual(4);
    }
  });
});

describe('calendar month view (§18.1)', () => {
  it('lays out weeks from Saturday to Friday, covering the whole month', () => {
    expect(WEEK_ORDER).toEqual([6, 0, 1, 2, 3, 4, 5]);
    const weeks = monthGrid('2026-11');
    expect(weeks[0]?.[0]).toBe('2026-10-31'); // the Saturday before 1 November (a Sunday)
    for (const week of weeks) {
      expect(week).toHaveLength(7);
      expect(weekdayOf(week[0]!)).toBe(6);
    }
    expect(weeks.flat()).toContain('2026-11-30');
    expect(weeks.at(-1)?.at(-1)).toBe('2026-12-04');
  });

  it('moves between months and parses the month parameter safely', () => {
    expect(shiftMonth('2026-12', 1)).toBe('2027-01');
    expect(shiftMonth('2026-01', -1)).toBe('2025-12');
    expect(lastDayOf('2028-02')).toBe('2028-02-29');
    expect(parseMonth('2026-13', '2026-10-21')).toBe('2026-10');
    expect(parseMonth('<script>', '2026-10-21')).toBe('2026-10');
    expect(parseMonth('2027-03', '2026-10-21')).toBe('2027-03');
  });

  it('shows recorded history values as plain text', () => {
    expect(showValue(null)).toBe('—');
    expect(showValue(['A', 'B'])).toBe('A, B');
    expect(showValue({ name: 'Farm', latitude: null, mapUrl: 'https://x' })).toBe(
      'name: Farm · mapUrl: https://x',
    );
  });
});
