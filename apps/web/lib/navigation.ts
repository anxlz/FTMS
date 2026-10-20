import { type MeResponse, type PermissionKey } from '@ftms/core';

/**
 * Navigation per role (§18.2). An item is shown only if the account may use it
 * (role or permission); items whose feature ships in a later phase are shown as
 * "coming soon" without a link. The API enforces access regardless (§17).
 */
export interface NavItem {
  /** Message key under `nav`. */
  key: string;
  /** Present only when the page exists. */
  href?: string;
  /** Phase that delivers the feature, for "coming soon" items. */
  phase?: number;
}

interface StaffEntry extends NavItem {
  /** Shown when the account holds at least one of these. */
  anyOf?: PermissionKey[];
}

const STUDENT_NAV: NavItem[] = [
  { key: 'dashboard', href: '/dashboard' },
  { key: 'trainingCalendar', phase: 3 },
  { key: 'attendanceHistory', phase: 4 },
  { key: 'notifications', phase: 3 },
  { key: 'tickets', phase: 5 },
  { key: 'profile', href: '/profile' },
];

const STAFF_NAV: StaffEntry[] = [
  { key: 'dashboard', href: '/dashboard' },
  { key: 'students', href: '/students', anyOf: ['students.read'] },
  { key: 'visits', phase: 3, anyOf: ['visits.manage'] },
  { key: 'calendar', phase: 3 },
  { key: 'groups', href: '/groups', anyOf: ['students.read', 'groups.manage'] },
  { key: 'attendance', phase: 4, anyOf: ['attendance.read'] },
  { key: 'tickets', phase: 5, anyOf: ['tickets.process'] },
  { key: 'groupSwaps', phase: 5, anyOf: ['group_swaps.decide'] },
  { key: 'schedule', phase: 3, anyOf: ['schedule.manage'] },
  { key: 'reviewQueues', href: '/reviews', anyOf: ['profile_changes.decide', 'students.manage'] },
  { key: 'activityLogs', phase: 6, anyOf: ['audit.read'] },
  { key: 'reports', phase: 6, anyOf: ['reports.export'] },
  { key: 'users', href: '/admin/users', anyOf: ['users.read'] },
  { key: 'settings', phase: 4, anyOf: ['attendance.settings.visit'] },
  { key: 'profile', href: '/profile' },
];

export function navigationFor(user: Pick<MeResponse, 'role' | 'permissions'>): NavItem[] {
  if (user.role === 'STUDENT') return STUDENT_NAV;
  const held = new Set<string>(user.permissions);
  return STAFF_NAV.filter((item) => !item.anyOf || item.anyOf.some((p) => held.has(p))).map(
    ({ anyOf: _anyOf, ...item }) => item,
  );
}
