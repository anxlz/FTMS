/**
 * Every event the shared audit service may record (§15.1, §15.4). Writers are
 * typed against this list, so the Training Director's log can label, group
 * and filter every action — a new action must be added here first.
 */
export const AUDIT_ACTIONS = [
  // Sign-in and account security
  'auth.login',
  'auth.logout',
  'auth.refresh',
  'auth.login_code.requested',
  'auth.login_code.verified',
  'auth.signup.code_requested',
  'auth.signup.completed',
  'auth.password.changed',
  'auth.password_reset.requested',
  'auth.password_reset.completed',
  'auth.biometric_enabled',
  'auth.biometric_revoked',
  // Accounts, roles and permissions
  'user.created',
  'user.status_changed',
  'user.role_changed',
  'user.permissions_changed',
  'user.seeded',
  'user.password_reset_by_seed',
  // Student records
  'student.created',
  'student.updated',
  'student.deleted',
  'student.account_linked',
  'student.account_unlinked',
  'student.profile_updated_by_student',
  // Reviews
  'student.verification.requested',
  'student.verification.approved',
  'student.verification.rejected',
  'profile_change.submitted',
  'profile_change.approved',
  'profile_change.rejected',
  'profile_change.cancelled',
  // Groups
  'group.created',
  'group.updated',
  'group.archived',
  'group.restored',
  'group.member_added',
  'group.member_moved',
  'group.member_removed',
  // Spreadsheet imports
  'student_import.previewed',
  'student_import.discarded',
  'student_import.committed',
  // Training settings
  'program.created',
  'program.updated',
  // Schedules
  'schedule.created',
  'schedule.updated',
  'schedule.ended',
  'schedule_exception.created',
  'schedule_exception.removed',
  // Visits
  'visit.created',
  'visit.updated',
  'visit.cancelled',
  'visit.restored',
  'visit.file_added',
  'visit.file_removed',
  // Attendance
  'attendance.checked_in',
  'attendance.guest_submitted',
  'attendance.corrected',
  'attendance.absences_recorded',
  // Tickets
  'ticket.created',
  'ticket.replied',
  'ticket.note_added',
  'ticket.status_changed',
  // Group swaps
  'group_swap.requested',
  'group_swap.counterpart_accepted',
  'group_swap.counterpart_rejected',
  'group_swap.withdrawn',
  'group_swap.approved',
  'group_swap.rejected',
  'group_swap.cancelled',
  // Exports (recorded for audit purposes, §15.1)
  'attendance.exported',
  'report.exported',
  'audit.exported',
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export const isAuditAction = (value: string): value is AuditAction =>
  (AUDIT_ACTIONS as readonly string[]).includes(value);

/** What an event is about (`resource_type`). */
export const AUDIT_RESOURCE_TYPES = [
  'user',
  'auth_session',
  'webauthn_credential',
  'student',
  'student_verification_request',
  'profile_change_request',
  'group',
  'student_import',
  'program',
  'schedule',
  'schedule_exception',
  'visit',
  'attendance',
  'guest_check_in',
  'ticket',
  'group_swap',
  'report',
  'audit_log',
] as const;
export type AuditResourceType = (typeof AUDIT_RESOURCE_TYPES)[number];

/** Groups of actions for filtering and the faculty activity summary. */
export const AUDIT_CATEGORIES = [
  'SIGN_IN',
  'ACCOUNTS',
  'STUDENTS',
  'REVIEWS',
  'GROUPS',
  'IMPORTS',
  'SETTINGS',
  'SCHEDULES',
  'VISITS',
  'ATTENDANCE',
  'TICKETS',
  'GROUP_SWAPS',
  'EXPORTS',
] as const;
export type AuditCategory = (typeof AUDIT_CATEGORIES)[number];

const EXPORT_ACTIONS: readonly AuditAction[] = [
  'attendance.exported',
  'report.exported',
  'audit.exported',
];

export function auditCategoryOf(action: AuditAction): AuditCategory {
  if (EXPORT_ACTIONS.includes(action)) return 'EXPORTS';
  if (action.startsWith('student.verification.') || action.startsWith('profile_change.')) {
    return 'REVIEWS';
  }
  const prefix = action.slice(0, action.indexOf('.'));
  switch (prefix) {
    case 'auth':
      return 'SIGN_IN';
    case 'user':
      return 'ACCOUNTS';
    case 'student':
      return 'STUDENTS';
    case 'group':
      return 'GROUPS';
    case 'student_import':
      return 'IMPORTS';
    case 'program':
      return 'SETTINGS';
    case 'schedule':
    case 'schedule_exception':
      return 'SCHEDULES';
    case 'visit':
      return 'VISITS';
    case 'attendance':
      return 'ATTENDANCE';
    case 'ticket':
      return 'TICKETS';
    default:
      return 'GROUP_SWAPS';
  }
}

export const actionsInCategory = (category: AuditCategory): AuditAction[] =>
  AUDIT_ACTIONS.filter((a) => auditCategoryOf(a) === category);

/**
 * Administrative decisions (§3.2, §14.7): approvals and rejections, the
 * students' consent to swaps, attendance corrections, ticket outcomes and
 * changes to accounts' access.
 */
export const DECISION_ACTIONS = [
  'student.verification.approved',
  'student.verification.rejected',
  'profile_change.approved',
  'profile_change.rejected',
  'group_swap.counterpart_accepted',
  'group_swap.counterpart_rejected',
  'group_swap.approved',
  'group_swap.rejected',
  'attendance.corrected',
  'ticket.status_changed',
  'user.status_changed',
  'user.role_changed',
  'user.permissions_changed',
] as const satisfies readonly AuditAction[];
