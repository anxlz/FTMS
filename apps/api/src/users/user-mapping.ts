import {
  type MeResponse,
  type PermissionGrant,
  type PermissionKey,
  resolvePermissions,
  type UserDetail,
  type UserSummary,
} from '@ftms/core';
import { type AuthMethod, Prisma } from '../generated/prisma/client';

/** Relations needed to describe an account (profile + grants). */
export const USER_INCLUDE = {
  studentProfile: true,
  facultyProfile: true,
  grants: true,
} as const satisfies Prisma.UserInclude;

export type UserWithRelations = Prisma.UserGetPayload<{ include: typeof USER_INCLUDE }>;

export const grantsOf = (user: UserWithRelations): PermissionGrant[] =>
  user.grants.map((g) => ({ permission: g.permissionKey as PermissionKey, effect: g.effect }));

export const effectivePermissions = (user: UserWithRelations): PermissionKey[] =>
  resolvePermissions(user.role, grantsOf(user));

/** A password must be set (first login) or replaced (forced change) before normal use. */
export const passwordSetupRequired = (
  user: Pick<UserWithRelations, 'passwordHash' | 'mustChangePassword'>,
) => user.passwordHash === null || user.mustChangePassword;

export function toMe(user: UserWithRelations, sessionMethod: AuthMethod): MeResponse {
  return {
    id: user.id,
    email: user.email,
    role: user.role,
    status: user.status,
    displayName: user.displayName,
    preferredLocale: user.preferredLocale,
    passwordSetupRequired: passwordSetupRequired(user),
    sessionMethod,
    hasPassword: user.passwordHash !== null,
    permissions: effectivePermissions(user),
    studentProfile: user.studentProfile
      ? { seatNumber: user.studentProfile.seatNumber, fullName: user.studentProfile.fullName }
      : null,
    facultyProfile: user.facultyProfile
      ? {
          fullName: user.facultyProfile.fullName,
          academicTitle: user.facultyProfile.academicTitle,
          department: user.facultyProfile.department,
        }
      : null,
  };
}

export function toSummary(user: UserWithRelations): UserSummary {
  return {
    id: user.id,
    email: user.email,
    role: user.role,
    status: user.status,
    displayName: user.displayName,
    seatNumber: user.studentProfile?.seatNumber ?? null,
    hasPassword: user.passwordHash !== null,
    lastLoginAt: user.lastLoginAt?.toISOString() ?? null,
    createdAt: user.createdAt.toISOString(),
  };
}

export function toDetail(user: UserWithRelations): UserDetail {
  return {
    ...toSummary(user),
    grants: grantsOf(user),
    effectivePermissions: effectivePermissions(user),
  };
}

/** Non-secret snapshot of an account for audit before/after comparisons. */
export const auditSnapshot = (user: UserWithRelations): Record<string, unknown> => ({
  email: user.email,
  role: user.role,
  status: user.status,
  displayName: user.displayName,
  seatNumber: user.studentProfile?.seatNumber ?? null,
  hasPassword: user.passwordHash !== null,
  grants: grantsOf(user),
});
