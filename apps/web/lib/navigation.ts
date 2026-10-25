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
  { key: 'trainingCalendar', href: '/calendar' },
  { key: 'attendanceHistory', href: '/attendance' },
  { key: 'notifications', href: '/notifications' },
  { key: 'tickets', href: '/tickets' },
  { key: 'profile', href: '/profile' },
];

const STAFF_NAV: StaffEntry[] = [
  { key: 'dashboard', href: '/dashboard' },
  { key: 'students', href: '/students', anyOf: ['students.read'] },
  { key: 'visits', href: '/visits', anyOf: ['visits.manage'] },
  { key: 'calendar', href: '/calendar' },
  { key: 'groups', href: '/groups', anyOf: ['students.read', 'groups.manage'] },
  { key: 'attendance', href: '/attendance', anyOf: ['attendance.read'] },
  { key: 'tickets', href: '/tickets', anyOf: ['tickets.process'] },
  { key: 'groupSwaps', href: '/group-swaps', anyOf: ['group_swaps.decide', 'group_swaps.audit'] },
  {
    key: 'schedule',
    href: '/schedule',
    anyOf: ['schedule.manage', 'schedule.group.manage', 'attendance.settings.defaults'],
  },
  { key: 'reviewQueues', href: '/reviews', anyOf: ['profile_changes.decide', 'students.manage'] },
  { key: 'activityLogs', href: '/audit', anyOf: ['audit.read'] },
  { key: 'reports', href: '/reports', anyOf: ['reports.export'] },
  { key: 'users', href: '/admin/users', anyOf: ['users.read'] },
  {
    key: 'settings',
    href: '/settings',
    anyOf: ['attendance.settings.visit', 'attendance.settings.defaults'],
  },
  { key: 'profile', href: '/profile' },
];

export function navigationFor(user: Pick<MeResponse, 'role' | 'permissions'>): NavItem[] {
  if (user.role === 'STUDENT') return STUDENT_NAV;
  const held = new Set<string>(user.permissions);
  return STAFF_NAV.filter((item) => !item.anyOf || item.anyOf.some((p) => held.has(p))).map(
    ({ anyOf: _anyOf, ...item }) => item,
  );
}
