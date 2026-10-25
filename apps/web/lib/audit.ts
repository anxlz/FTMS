import { type AuditResourceType } from '@ftms/core';

/**
 * Where the record an audit event concerns can be opened (§15.3), or null
 * when it has no page of its own (sessions, devices, exported files). The
 * page itself still checks the reader's permissions.
 */
export function auditResourceHref(resource: {
  type: AuditResourceType;
  id: string;
  visitId?: string | null;
}): string | null {
  const id = encodeURIComponent(resource.id);
  switch (resource.type) {
    case 'user':
      return `/admin/users/${id}`;
    case 'student':
      return `/students/${id}`;
    case 'group':
      return `/groups/${id}`;
    case 'visit':
      return `/visits/${id}`;
    case 'attendance':
    case 'guest_check_in':
      return resource.visitId ? `/visits/${encodeURIComponent(resource.visitId)}/attendance` : null;
    case 'schedule':
      return `/schedule/${id}`;
    case 'schedule_exception':
      return '/schedule';
    case 'program':
      return '/settings';
    case 'student_import':
      return `/students/import/${id}`;
    case 'profile_change_request':
      return `/reviews/profile-changes/${id}`;
    case 'student_verification_request':
      return `/reviews/verifications/${id}`;
    case 'ticket':
      return `/tickets/${id}`;
    case 'group_swap':
      return `/group-swaps/${id}`;
    case 'auth_session':
    case 'webauthn_credential':
    case 'report':
    case 'audit_log':
      return null;
  }
}

/** Filters of the log carried from page to page and into exports. */
export const AUDIT_FILTER_KEYS = [
  'q',
  'actor',
  'scope',
  'category',
  'action',
  'resourceType',
  'resourceId',
  'outcome',
  'decisions',
  'from',
  'to',
] as const;
