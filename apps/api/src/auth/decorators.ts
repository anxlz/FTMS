import { createParamDecorator, type ExecutionContext, SetMetadata } from '@nestjs/common';
import { type PermissionKey, type Role } from '@ftms/core';
import type { Request } from 'express';
import { Errors } from '../common/api-exception';
import { type AuthPrincipal } from './principal';

export const IS_PUBLIC = 'ftms:isPublic';
export const ALLOW_PENDING_PASSWORD = 'ftms:allowPendingPassword';
export const ALLOW_PENDING_VERIFICATION = 'ftms:allowPendingVerification';
export const ROLES_KEY = 'ftms:roles';
export const PERMISSIONS_KEY = 'ftms:permissions';

/** Opts a route out of authentication. Everything else requires a valid access token. */
export const Public = () => SetMetadata(IS_PUBLIC, true);

/**
 * Lets an account that still has to set or change its password reach the route.
 * Only the routes needed to finish that step (and sign out) carry it.
 */
export const AllowPendingPasswordSetup = () => SetMetadata(ALLOW_PENDING_PASSWORD, true);

/**
 * Lets a student account that is still waiting for verification (§4.2 Case B)
 * reach the route. Everything else answers AUTH_ACCOUNT_PENDING: such an account
 * must not see academic data until a reviewer verifies it.
 */
export const AllowPendingVerification = () => SetMetadata(ALLOW_PENDING_VERIFICATION, true);

/** Restricts a route to the listed roles. */
export const Roles = (...roles: Role[]) => SetMetadata(ROLES_KEY, roles);

export interface PermissionRequirement {
  mode: 'all' | 'any';
  keys: PermissionKey[];
}

/** The caller must hold every listed permission. */
export const RequirePermissions = (...keys: PermissionKey[]) =>
  SetMetadata(PERMISSIONS_KEY, { mode: 'all', keys } satisfies PermissionRequirement);

/** The caller must hold at least one listed permission (the service refines the check). */
export const RequireAnyPermission = (...keys: PermissionKey[]) =>
  SetMetadata(PERMISSIONS_KEY, { mode: 'any', keys } satisfies PermissionRequirement);

/** Injects the authenticated principal. */
export const CurrentPrincipal = createParamDecorator(
  (_: unknown, context: ExecutionContext): AuthPrincipal => {
    const principal = context.switchToHttp().getRequest<Request & { user?: AuthPrincipal }>().user;
    if (!principal) throw Errors.authRequired();
    return principal;
  },
);
