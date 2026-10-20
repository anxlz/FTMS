/**
 * The four primary roles (§3). Every account has exactly one. Role checks and the
 * permission resolution below are the single source of truth for both the API's
 * guards and the web app's navigation (which only HIDES controls — the API enforces).
 */
export const ROLES = ['SUPER_ADMIN', 'TRAINING_DIRECTOR', 'FACULTY', 'STUDENT'] as const;
export type Role = (typeof ROLES)[number];

/** Roles that work in the faculty-side interface. */
export const STAFF_ROLES = ['SUPER_ADMIN', 'TRAINING_DIRECTOR', 'FACULTY'] as const;
export type StaffRole = (typeof STAFF_ROLES)[number];

export const isStaffRole = (role: Role): role is StaffRole => role !== 'STUDENT';

export const ACCOUNT_STATUSES = ['PENDING_VERIFICATION', 'ACTIVE', 'SUSPENDED'] as const;
export type AccountStatus = (typeof ACCOUNT_STATUSES)[number];
