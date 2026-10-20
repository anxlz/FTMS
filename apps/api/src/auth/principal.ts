import { Injectable } from '@nestjs/common';
import { type Locale, type PermissionKey, type Role } from '@ftms/core';
import { type AuthMethod } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { type AuditActor } from '../audit/audit.service';
import {
  effectivePermissions,
  passwordSetupRequired,
  USER_INCLUDE,
  type UserWithRelations,
} from '../users/user-mapping';

/** The authenticated caller, rebuilt from the database on every request. */
export interface AuthPrincipal {
  userId: string;
  sessionId: string;
  sessionMethod: AuthMethod;
  email: string;
  role: Role;
  displayName: string;
  preferredLocale: Locale;
  passwordSetupRequired: boolean;
  permissions: ReadonlySet<PermissionKey>;
}

export const actorOf = (p: Pick<AuthPrincipal, 'userId' | 'displayName' | 'role'>): AuditActor => ({
  id: p.userId,
  displayName: p.displayName,
  role: p.role,
});

export const actorOfUser = (
  u: Pick<UserWithRelations, 'id' | 'displayName' | 'role'>,
): AuditActor => ({
  id: u.id,
  displayName: u.displayName,
  role: u.role,
});

/** `lastUsedAt` is refreshed at most this often, to avoid a write per request. */
const TOUCH_INTERVAL_MS = 5 * 60_000;

/**
 * Loads the principal for an access token. The role, status and permissions come
 * from the database, never from the token, so suspensions, role changes, grant
 * changes and logouts take effect on the very next request (§17).
 */
@Injectable()
export class PrincipalService {
  constructor(private readonly prisma: PrismaService) {}

  async load(sessionId: string, userId: string, now = new Date()): Promise<AuthPrincipal | null> {
    const session = await this.prisma.authSession.findUnique({
      where: { id: sessionId },
      include: { user: { include: USER_INCLUDE } },
    });
    if (!session || session.userId !== userId) return null;
    if (session.revokedAt !== null || session.expiresAt <= now) return null;
    const user = session.user;
    if (user.status !== 'ACTIVE') return null;

    if (now.getTime() - session.lastUsedAt.getTime() > TOUCH_INTERVAL_MS) {
      await this.prisma.authSession.update({
        where: { id: session.id },
        data: { lastUsedAt: now },
      });
    }

    return {
      userId: user.id,
      sessionId: session.id,
      sessionMethod: session.method,
      email: user.email,
      role: user.role,
      displayName: user.displayName,
      preferredLocale: user.preferredLocale,
      passwordSetupRequired: passwordSetupRequired(user),
      permissions: new Set(effectivePermissions(user)),
    };
  }
}
