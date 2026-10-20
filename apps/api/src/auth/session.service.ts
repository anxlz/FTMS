import { Injectable } from '@nestjs/common';
import { type TokenPair } from '@ftms/core';
import { AuditService } from '../audit/audit.service';
import { Errors } from '../common/api-exception';
import { randomToken, safeEqual, sha256Hex } from '../common/crypto';
import { type RequestContext } from '../common/request-context';
import { type AuthMethod, type Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { USER_INCLUDE, type UserWithRelations } from '../users/user-mapping';
import { AUTH } from './auth.constants';
import { actorOfUser, isUsableStatus } from './principal';
import { type RefreshClaims, TokenService } from './token.service';

export type SessionRevokeReason =
  | 'logout'
  | 'password_changed'
  | 'password_reset'
  | 'account_suspended'
  | 'refresh_reuse'
  | 'admin_reset'
  | 'account_unlinked';

/**
 * Sessions are rows; refresh tokens are signed JWTs whose id (`jti`) is stored
 * only as a SHA-256 hash and rotated on every use. Presenting an already-rotated
 * token outside a short grace window is treated as theft: the session is revoked.
 */
@Injectable()
export class SessionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tokens: TokenService,
    private readonly audit: AuditService,
  ) {}

  async create(
    user: Pick<UserWithRelations, 'id' | 'role'>,
    method: AuthMethod,
    context: RequestContext,
    tx?: Prisma.TransactionClient,
  ): Promise<TokenPair & { sessionId: string }> {
    const jti = randomToken();
    const expiresAt = new Date(Date.now() + AUTH.sessionSeconds * 1000);
    const session = await (tx ?? this.prisma).authSession.create({
      data: {
        userId: user.id,
        method,
        currentRefreshHash: sha256Hex(jti),
        expiresAt,
        ip: context.ip,
        userAgent: context.userAgent,
      },
    });
    const pair = await this.issue(user, session.id, jti, expiresAt);
    return { ...pair, sessionId: session.id };
  }

  /** Exchanges a refresh token for a new pair. Returns the (active) account it belongs to. */
  async rotate(
    claims: RefreshClaims,
    context: RequestContext,
  ): Promise<{ user: UserWithRelations; tokens: TokenPair }> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const now = new Date();
      const session = await this.prisma.authSession.findUnique({
        where: { id: claims.sid },
        include: { user: { include: USER_INCLUDE } },
      });
      if (!session || session.userId !== claims.sub) throw Errors.sessionInvalid();
      if (session.revokedAt !== null || session.expiresAt <= now) throw Errors.sessionInvalid();
      if (!isUsableStatus(session.user.status)) {
        await this.revoke(session.id, 'account_suspended');
        throw Errors.sessionInvalid();
      }

      const presented = sha256Hex(claims.jti);
      const isCurrent = safeEqual(presented, session.currentRefreshHash);
      const inGrace =
        session.previousRefreshHash !== null &&
        safeEqual(presented, session.previousRefreshHash) &&
        session.rotatedAt !== null &&
        now.getTime() - session.rotatedAt.getTime() <= AUTH.refreshGraceSeconds * 1000;

      if (!isCurrent && !inGrace) {
        await this.revoke(session.id, 'refresh_reuse');
        await this.audit.recordSafely({
          actor: actorOfUser(session.user),
          action: 'auth.refresh',
          resourceType: 'auth_session',
          resourceId: session.id,
          outcome: 'FAILURE',
          reason: 'refresh_token_reuse_detected',
          context,
        });
        throw Errors.sessionInvalid();
      }

      const jti = randomToken();
      // Optimistic concurrency: only one parallel rotation can win; the loser re-reads
      // and, holding the now-previous token within the grace window, rotates again.
      const updated = await this.prisma.authSession.updateMany({
        where: { id: session.id, currentRefreshHash: session.currentRefreshHash, revokedAt: null },
        data: {
          previousRefreshHash: session.currentRefreshHash,
          currentRefreshHash: sha256Hex(jti),
          rotatedAt: now,
          lastUsedAt: now,
          ip: context.ip,
          userAgent: context.userAgent,
        },
      });
      if (updated.count === 1) {
        const tokens = await this.issue(session.user, session.id, jti, session.expiresAt);
        return { user: session.user, tokens };
      }
    }
    throw Errors.sessionInvalid();
  }

  async revoke(sessionId: string, reason: SessionRevokeReason, tx?: Prisma.TransactionClient) {
    await (tx ?? this.prisma).authSession.updateMany({
      where: { id: sessionId, revokedAt: null },
      data: { revokedAt: new Date(), revokeReason: reason },
    });
  }

  /** Revokes every active session of a user, optionally keeping the caller's own. */
  async revokeAllForUser(
    userId: string,
    reason: SessionRevokeReason,
    options: { exceptSessionId?: string; tx?: Prisma.TransactionClient } = {},
  ): Promise<number> {
    const result = await (options.tx ?? this.prisma).authSession.updateMany({
      where: {
        userId,
        revokedAt: null,
        ...(options.exceptSessionId ? { id: { not: options.exceptSessionId } } : {}),
      },
      data: { revokedAt: new Date(), revokeReason: reason },
    });
    return result.count;
  }

  private async issue(
    user: Pick<UserWithRelations, 'id' | 'role'>,
    sessionId: string,
    jti: string,
    sessionExpiresAt: Date,
  ): Promise<TokenPair> {
    const access = await this.tokens.signAccess({ sub: user.id, sid: sessionId, role: user.role });
    const refresh = await this.tokens.signRefresh(
      { sub: user.id, sid: sessionId, jti },
      sessionExpiresAt,
    );
    return {
      accessToken: access.token,
      accessTokenExpiresAt: access.expiresAt.toISOString(),
      refreshToken: refresh.token,
      refreshTokenExpiresAt: refresh.expiresAt.toISOString(),
    };
  }
}
