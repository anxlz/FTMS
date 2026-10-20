import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';
import { LoginRequestSchema, type Role } from '@ftms/core';
import type { Request } from 'express';
import { Errors } from '../../common/api-exception';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import {
  ALLOW_PENDING_PASSWORD,
  ALLOW_PENDING_VERIFICATION,
  IS_PUBLIC,
  PERMISSIONS_KEY,
  type PermissionRequirement,
  ROLES_KEY,
} from '../decorators';
import { type AuthPrincipal } from '../principal';

const metadata = <T>(reflector: Reflector, key: string, context: ExecutionContext) =>
  reflector.getAllAndOverride<T | undefined>(key, [context.getHandler(), context.getClass()]);

const principalOf = (context: ExecutionContext): AuthPrincipal | undefined =>
  context.switchToHttp().getRequest<Request & { user?: AuthPrincipal }>().user;

/**
 * Global guard 1/5 — authentication. Every route requires a valid bearer token
 * unless marked `@Public()`.
 */
@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  constructor(private readonly reflector: Reflector) {
    super();
  }

  override canActivate(context: ExecutionContext) {
    if (metadata<boolean>(this.reflector, IS_PUBLIC, context)) return true;
    return super.canActivate(context);
  }

  override handleRequest<T>(error: unknown, principal: T | false): T {
    if (error instanceof Error && 'code' in error) throw error;
    if (error || !principal) throw Errors.authRequired();
    return principal;
  }
}

/**
 * Global guard 2/5 — an account that must set or change its password can only
 * reach the routes needed to do that (§2 Super Admin bootstrap, §4.3 first login).
 */
@Injectable()
export class PasswordSetupGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const principal = principalOf(context);
    if (!principal || !principal.passwordSetupRequired) return true;
    if (metadata<boolean>(this.reflector, ALLOW_PENDING_PASSWORD, context)) return true;
    throw Errors.passwordChangeRequired();
  }
}

/**
 * Global guard 3/5 — a student account waiting for verification (§4.2 Case B)
 * can only reach the routes marked `@AllowPendingVerification()`.
 */
@Injectable()
export class VerificationGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const principal = principalOf(context);
    if (!principal || principal.status !== 'PENDING_VERIFICATION') return true;
    if (metadata<boolean>(this.reflector, ALLOW_PENDING_VERIFICATION, context)) return true;
    throw Errors.accountPending();
  }
}

/** Global guard 4/5 — `@Roles(...)`. */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const roles = metadata<Role[]>(this.reflector, ROLES_KEY, context);
    if (!roles || roles.length === 0) return true;
    const principal = principalOf(context);
    if (!principal) throw Errors.authRequired();
    if (!roles.includes(principal.role)) throw Errors.forbidden();
    return true;
  }
}

/** Global guard 5/5 — `@RequirePermissions(...)` / `@RequireAnyPermission(...)`. */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requirement = metadata<PermissionRequirement>(this.reflector, PERMISSIONS_KEY, context);
    if (!requirement || requirement.keys.length === 0) return true;
    const principal = principalOf(context);
    if (!principal) throw Errors.authRequired();
    const held = (key: (typeof requirement.keys)[number]) => principal.permissions.has(key);
    const allowed =
      requirement.mode === 'all' ? requirement.keys.every(held) : requirement.keys.some(held);
    if (!allowed) throw Errors.forbidden();
    return true;
  }
}

/** Password login: validates the body shape first, then runs the local strategy. */
@Injectable()
export class LocalAuthGuard extends AuthGuard('local') {
  private readonly pipe = new ZodValidationPipe(LoginRequestSchema);

  override canActivate(context: ExecutionContext) {
    this.pipe.transform(context.switchToHttp().getRequest<Request>().body);
    return super.canActivate(context);
  }

  override handleRequest<T>(error: unknown, user: T | false): T {
    if (error instanceof Error) throw error;
    if (error || !user) throw Errors.invalidCredentials();
    return user;
  }
}
