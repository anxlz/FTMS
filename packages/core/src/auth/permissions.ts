import { type Role } from './roles';

/**
 * Staff permission catalog. Keys are stable identifiers stored in the database
 * (`permissions` table, seeded by migration — a test keeps both in sync).
 *
 * `grantable: false` marks Super-Admin-only capabilities: they can never be
 * granted to another account, so the Super Admin and Training Director keep
 * distinct scopes (§17). Student self-service actions are not permissions; they
 * are guarded by role + ownership.
 */
export const PERMISSIONS = {
  'users.read': { grantable: true, description: 'View user accounts' },
  'users.manage': {
    grantable: false,
    description: 'Create any account, change roles and account states',
  },
  'faculty.manage': { grantable: true, description: 'Create and suspend faculty accounts' },
  'permissions.manage': {
    grantable: false,
    description: 'Grant or revoke individual permissions',
  },
  'settings.manage': { grantable: false, description: 'Manage global application settings' },
  'audit.read': { grantable: true, description: 'Read administrative audit logs' },
  'students.read': { grantable: true, description: 'View student records' },
  'students.manage': { grantable: true, description: 'Edit student records' },
  'students.import': { grantable: true, description: 'Import students from spreadsheets' },
  'profile_changes.decide': {
    grantable: true,
    description: 'Approve or reject protected profile changes',
  },
  'groups.manage': { grantable: true, description: 'Create groups and manage membership' },
  'schedule.manage': { grantable: true, description: 'Configure the training-wide schedule' },
  'schedule.group.manage': {
    grantable: true,
    description: 'Configure group-specific training schedules',
  },
  'visits.manage': { grantable: true, description: 'Create, edit and cancel training visits' },
  'attendance.read': { grantable: true, description: 'View attendance records' },
  'attendance.correct': { grantable: true, description: 'Correct attendance status and lateness' },
  'attendance.settings.defaults': {
    grantable: true,
    description: 'Configure training-wide attendance defaults',
  },
  'attendance.settings.visit': {
    grantable: true,
    description: 'Override attendance settings for a visit',
  },
  'tickets.process': { grantable: true, description: 'Review and process support tickets' },
  'group_swaps.decide': { grantable: true, description: 'Approve or reject group-swap requests' },
  'group_swaps.audit': {
    grantable: true,
    description: 'See who decided group-swap requests',
  },
  'reports.export': { grantable: true, description: 'Export attendance reports' },
} as const satisfies Record<string, { grantable: boolean; description: string }>;

export type PermissionKey = keyof typeof PERMISSIONS;
export const PERMISSION_KEYS = Object.keys(PERMISSIONS) as PermissionKey[];

export const isPermissionKey = (value: string): value is PermissionKey =>
  Object.prototype.hasOwnProperty.call(PERMISSIONS, value);

const FACULTY_DEFAULTS: readonly PermissionKey[] = [
  'students.read',
  'students.manage',
  'students.import',
  'profile_changes.decide',
  'groups.manage',
  'visits.manage',
  'attendance.read',
  'attendance.correct',
  'attendance.settings.visit',
  'tickets.process',
  'group_swaps.decide',
  'reports.export',
];

const DIRECTOR_DEFAULTS: readonly PermissionKey[] = [
  ...FACULTY_DEFAULTS,
  'users.read',
  'faculty.manage',
  'audit.read',
  'schedule.manage',
  'schedule.group.manage',
  'attendance.settings.defaults',
  'group_swaps.audit',
];

/** Default permissions per role, before any per-user grant. */
export const ROLE_DEFAULT_PERMISSIONS: Record<Role, readonly PermissionKey[]> = {
  SUPER_ADMIN: PERMISSION_KEYS,
  TRAINING_DIRECTOR: DIRECTOR_DEFAULTS,
  FACULTY: FACULTY_DEFAULTS,
  STUDENT: [],
};

export type GrantEffect = 'ALLOW' | 'DENY';

export interface PermissionGrant {
  permission: PermissionKey;
  effect: GrantEffect;
}

/** Roles whose permissions may be adjusted with per-user grants. */
export const canReceiveGrants = (role: Role): boolean =>
  role === 'TRAINING_DIRECTOR' || role === 'FACULTY';

/**
 * Effective permissions = role defaults + ALLOW grants − DENY grants.
 * The Super Admin always holds every permission; students never hold any.
 * Non-grantable permissions are ignored in grants even if a row exists.
 */
export function resolvePermissions(
  role: Role,
  grants: readonly PermissionGrant[] = [],
): PermissionKey[] {
  if (role === 'SUPER_ADMIN') return [...PERMISSION_KEYS];
  if (!canReceiveGrants(role)) return [];

  const effective = new Set<PermissionKey>(ROLE_DEFAULT_PERMISSIONS[role]);
  for (const grant of grants) {
    if (!PERMISSIONS[grant.permission].grantable) continue;
    if (grant.effect === 'ALLOW') effective.add(grant.permission);
  }
  for (const grant of grants) {
    if (grant.effect === 'DENY') effective.delete(grant.permission);
  }
  return PERMISSION_KEYS.filter((key) => effective.has(key));
}
