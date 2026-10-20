import { Injectable } from '@nestjs/common';
import {
  type AuthResponse,
  type ChangePasswordRequest,
  checkPasswordPolicy,
  parseLoginIdentifier,
  type ResetPasswordRequest,
} from '@ftms/core';
import { AuditService } from '../audit/audit.service';
import { Errors } from '../common/api-exception';
import { BackgroundTasks } from '../common/background-tasks.service';
import { type RequestContext } from '../common/request-context';
import { type AuthMethod, type ChallengePurpose } from '../generated/prisma/client';
import { MailService } from '../mail/mail.service';
import { PrismaService } from '../prisma/prisma.service';
import { RateLimiter, rateLimitKey } from '../rate-limit/rate-limiter';
import { toMe, USER_INCLUDE, type UserWithRelations } from '../users/user-mapping';
import { AUTH, type LimitPolicy, LIMITS } from './auth.constants';
import { type EmailContent, loginCodeEmail, passwordResetEmail } from './auth-emails';
import { ChallengeService } from './challenge.service';
import { hashPassword, verifyAgainstDummy, verifyPassword } from './password-hashing';
import { actorOf, actorOfUser, type AuthPrincipal } from './principal';
import { SessionService } from './session.service';
import { TokenService } from './token.service';

const CODE_MINUTES = AUTH.codeSeconds / 60;

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly limiter: RateLimiter,
    private readonly sessions: SessionService,
    private readonly challenges: ChallengeService,
    private readonly tokens: TokenService,
    private readonly mail: MailService,
    private readonly background: BackgroundTasks,
  ) {}

  /* ─────────────────────────── rate-limit helpers ─────────────────────────── */

  /** Rejects when a key is already at its limit, without counting this request. */
  private async ensureBelow(policy: LimitPolicy, key: string): Promise<void> {
    const state = await this.limiter.peek(key);
    if (state.count >= policy.limit) {
      throw Errors.rateLimited(state.resetInSeconds || policy.windowSeconds);
    }
  }

  private async count(policy: LimitPolicy, key: string): Promise<void> {
    await this.limiter.hit(key, policy.windowSeconds);
  }

  private ipKey(bucket: string, context: RequestContext): string {
    return rateLimitKey(bucket, context.ip ?? 'unknown');
  }

  private findByEmail(email: string): Promise<UserWithRelations | null> {
    return this.prisma.user.findUnique({ where: { email }, include: USER_INCLUDE });
  }

  /* ───────────────────────────── password login ───────────────────────────── */

  /**
   * Email or seat number + password. Every failure mode — unknown identifier,
   * seat number without a linked account, account without a password, wrong
   * password — returns the same error after the same amount of hashing work,
   * so the response reveals nothing about which accounts exist (§4.3, §17).
   */
  async validatePassword(
    rawIdentifier: string,
    password: string,
    context: RequestContext,
  ): Promise<UserWithRelations> {
    const identifier = parseLoginIdentifier(rawIdentifier);
    const subject =
      identifier?.kind === 'email'
        ? identifier.email
        : identifier?.kind === 'seat'
          ? identifier.seatNumber
          : rawIdentifier.trim();
    const idKey = rateLimitKey('login-id', subject);
    const ipKey = this.ipKey('login-ip', context);
    await this.ensureBelow(LIMITS.loginFailuresPerIdentifier, idKey);
    await this.ensureBelow(LIMITS.loginFailuresPerIp, ipKey);

    let user: UserWithRelations | null = null;
    if (identifier?.kind === 'email') {
      user = await this.findByEmail(identifier.email);
    } else if (identifier?.kind === 'seat') {
      const profile = await this.prisma.studentProfile.findUnique({
        where: { seatNumber: identifier.seatNumber },
        include: { user: { include: USER_INCLUDE } },
      });
      user = profile?.user ?? null;
    }

    const valid = user?.passwordHash
      ? await verifyPassword(user.passwordHash, password)
      : await verifyAgainstDummy(password);

    if (!user || !valid) {
      await this.count(LIMITS.loginFailuresPerIdentifier, idKey);
      await this.count(LIMITS.loginFailuresPerIp, ipKey);
      await this.audit.recordSafely({
        actor: user ? actorOfUser(user) : null,
        action: 'auth.login',
        resourceType: 'user',
        resourceId: user?.id ?? null,
        outcome: 'FAILURE',
        reason: !user
          ? 'unknown_identifier'
          : user.passwordHash
            ? 'wrong_password'
            : 'no_password_set',
        metadata: { method: 'PASSWORD', identifierType: identifier?.kind ?? 'unparseable' },
        context,
      });
      throw Errors.invalidCredentials();
    }

    this.assertUsable(user);
    await this.limiter.reset(idKey);
    return user;
  }

  /** Status checks happen only after the password proved the caller knows the account. */
  private assertUsable(user: UserWithRelations): void {
    if (user.status === 'SUSPENDED') throw Errors.accountSuspended();
    if (user.status === 'PENDING_VERIFICATION') throw Errors.accountPending();
  }

  async signIn(
    user: UserWithRelations,
    method: AuthMethod,
    context: RequestContext,
    extra: Record<string, unknown> = {},
  ): Promise<AuthResponse> {
    const now = new Date();
    // No `include` inside the transaction: Prisma 7 would run relation queries
    // concurrently on the transaction's single connection (deprecated by pg).
    const tokens = await this.prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: user.id },
        data: {
          lastLoginAt: now,
          ...(method === 'EMAIL_CODE' && user.emailVerifiedAt === null
            ? { emailVerifiedAt: now }
            : {}),
        },
      });
      const tokens = await this.sessions.create(user, method, context, tx);
      await this.audit.record(
        {
          actor: actorOfUser(user),
          action: 'auth.login',
          resourceType: 'auth_session',
          resourceId: tokens.sessionId,
          outcome: 'SUCCESS',
          metadata: { method, ...extra },
          context,
        },
        tx,
      );
      return tokens;
    });
    const fresh = await this.prisma.user.findUniqueOrThrow({
      where: { id: user.id },
      include: USER_INCLUDE,
    });
    const { sessionId: _sessionId, ...pair } = tokens;
    return { ...pair, user: toMe(fresh) };
  }

  /* ─────────────────────────── emailed one-time codes ─────────────────────────── */

  private async limitCodeRequest(email: string, context: RequestContext): Promise<void> {
    const cooldown = rateLimitKey('code-cooldown', email);
    const perEmail = rateLimitKey('code-email', email);
    const perIp = this.ipKey('code-ip', context);
    await this.ensureBelow(LIMITS.codeRequestCooldownPerEmail, cooldown);
    await this.ensureBelow(LIMITS.codeRequestsPerEmail, perEmail);
    await this.ensureBelow(LIMITS.codeRequestsPerIp, perIp);
    await this.count(LIMITS.codeRequestCooldownPerEmail, cooldown);
    await this.count(LIMITS.codeRequestsPerEmail, perEmail);
    await this.count(LIMITS.codeRequestsPerIp, perIp);
  }

  /**
   * Issues and emails a code when the account qualifies; otherwise does nothing.
   * Either way the caller gets the same answer, and the email is sent in the
   * background so response time does not reveal whether one was sent.
   */
  private async issueCode(
    email: string,
    purpose: ChallengePurpose,
    qualifies: (user: UserWithRelations) => string | null,
    render: (code: string) => EmailContent,
    context: RequestContext,
  ): Promise<void> {
    await this.limitCodeRequest(email, context);
    const user = await this.findByEmail(email);
    const refusal = !user ? 'unknown_email' : qualifies(user);
    const action =
      purpose === 'LOGIN' ? 'auth.login_code.requested' : 'auth.password_reset.requested';

    if (!user || refusal) {
      await this.audit.recordSafely({
        actor: user ? actorOfUser(user) : null,
        action,
        resourceType: 'user',
        resourceId: user?.id ?? null,
        outcome: 'FAILURE',
        reason: refusal,
        context,
      });
      return;
    }

    const code = await this.challenges.issue(user.id, purpose, context);
    await this.audit.record({
      actor: actorOfUser(user),
      action,
      resourceType: 'user',
      resourceId: user.id,
      outcome: 'SUCCESS',
      context,
    });
    const content = render(code);
    this.background.run(`${purpose} code email`, () =>
      this.mail.send({ to: user.email, subject: content.subject, text: content.text }),
    );
  }

  /** First login (§4.3): only for accounts that have no password yet. */
  requestLoginCode(email: string, context: RequestContext): Promise<void> {
    return this.issueCode(
      email,
      'LOGIN',
      (user) =>
        user.status === 'SUSPENDED'
          ? 'account_suspended'
          : user.passwordHash !== null
            ? 'password_already_set'
            : null,
      (code) => loginCodeEmail(code, CODE_MINUTES),
      context,
    );
  }

  requestPasswordReset(email: string, context: RequestContext): Promise<void> {
    return this.issueCode(
      email,
      'PASSWORD_RESET',
      (user) => (user.status === 'SUSPENDED' ? 'account_suspended' : null),
      (code) => passwordResetEmail(code, CODE_MINUTES),
      context,
    );
  }

  /** Verifies a code for `purpose`; counts failures per email and IP. */
  private async consumeCode(
    email: string,
    code: string,
    purpose: ChallengePurpose,
    context: RequestContext,
  ): Promise<UserWithRelations> {
    const emailKey = rateLimitKey('code-fail-email', email);
    const ipKey = this.ipKey('code-fail-ip', context);
    await this.ensureBelow(LIMITS.codeFailuresPerEmail, emailKey);
    await this.ensureBelow(LIMITS.codeFailuresPerIp, ipKey);

    const user = await this.findByEmail(email);
    const ok = user ? await this.challenges.consume(user.id, purpose, code) : false;
    if (!user || !ok) {
      await this.count(LIMITS.codeFailuresPerEmail, emailKey);
      await this.count(LIMITS.codeFailuresPerIp, ipKey);
      await this.audit.recordSafely({
        actor: user ? actorOfUser(user) : null,
        action: purpose === 'LOGIN' ? 'auth.login_code.verified' : 'auth.password_reset.completed',
        resourceType: 'user',
        resourceId: user?.id ?? null,
        outcome: 'FAILURE',
        reason: user ? 'code_invalid_or_expired' : 'unknown_email',
        context,
      });
      throw Errors.codeInvalid();
    }
    this.assertUsable(user);
    await this.limiter.reset(emailKey);
    return user;
  }

  async verifyLoginCode(
    email: string,
    code: string,
    context: RequestContext,
  ): Promise<AuthResponse> {
    const user = await this.consumeCode(email, code, 'LOGIN', context);
    return this.signIn(user, 'EMAIL_CODE', context);
  }

  async resetPassword(input: ResetPasswordRequest, context: RequestContext): Promise<void> {
    const user = await this.consumeCode(input.email, input.code, 'PASSWORD_RESET', context);
    this.assertPolicy(input.newPassword, user);
    const passwordHash = await hashPassword(input.newPassword);
    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: user.id },
        data: {
          passwordHash,
          mustChangePassword: false,
          passwordChangedAt: new Date(),
          emailVerifiedAt: user.emailVerifiedAt ?? new Date(),
        },
      });
      const revoked = await this.sessions.revokeAllForUser(user.id, 'password_reset', { tx });
      await this.audit.record(
        {
          actor: actorOfUser(user),
          action: 'auth.password_reset.completed',
          resourceType: 'user',
          resourceId: user.id,
          outcome: 'SUCCESS',
          metadata: { sessionsRevoked: revoked },
          context,
        },
        tx,
      );
    });
  }

  /* ─────────────────────────────── passwords ─────────────────────────────── */

  private assertPolicy(password: string, user: UserWithRelations): void {
    const violations = checkPasswordPolicy(password, [user.email, user.studentProfile?.seatNumber]);
    if (violations.length > 0) throw Errors.passwordPolicy(violations);
  }

  /**
   * Sets the first password (after an email-code sign-in) or changes the current
   * one (forced or voluntary). Every other session of the account is revoked.
   */
  async changePassword(
    principal: AuthPrincipal,
    input: ChangePasswordRequest,
    context: RequestContext,
  ): Promise<void> {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: principal.userId },
      include: USER_INCLUDE,
    });
    const firstSetup = user.passwordHash === null;

    if (!firstSetup) {
      const failKey = rateLimitKey('password-change', user.id);
      await this.ensureBelow(LIMITS.passwordChangeFailuresPerUser, failKey);
      const ok = input.currentPassword
        ? await verifyPassword(user.passwordHash!, input.currentPassword)
        : false;
      if (!ok) {
        await this.count(LIMITS.passwordChangeFailuresPerUser, failKey);
        await this.audit.recordSafely({
          actor: actorOf(principal),
          action: 'auth.password.changed',
          resourceType: 'user',
          resourceId: user.id,
          outcome: 'FAILURE',
          reason: 'current_password_incorrect',
          context,
        });
        throw Errors.currentPasswordIncorrect();
      }
      if (await verifyPassword(user.passwordHash!, input.newPassword)) {
        throw Errors.passwordPolicy(['SAME_AS_CURRENT']);
      }
    }
    this.assertPolicy(input.newPassword, user);

    const passwordHash = await hashPassword(input.newPassword);
    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: user.id },
        data: { passwordHash, mustChangePassword: false, passwordChangedAt: new Date() },
      });
      const revoked = await this.sessions.revokeAllForUser(user.id, 'password_changed', {
        exceptSessionId: principal.sessionId,
        tx,
      });
      await this.audit.record(
        {
          actor: actorOf(principal),
          action: 'auth.password.changed',
          resourceType: 'user',
          resourceId: user.id,
          outcome: 'SUCCESS',
          metadata: { firstSetup, forced: user.mustChangePassword, otherSessionsRevoked: revoked },
          context,
        },
        tx,
      );
    });
  }

  /* ─────────────────────────────── sessions ─────────────────────────────── */

  async refresh(refreshToken: string, context: RequestContext): Promise<AuthResponse> {
    const claims = await this.tokens.verifyRefresh(refreshToken);
    if (!claims) throw Errors.sessionInvalid();
    const { user, tokens } = await this.sessions.rotate(claims, context);
    return { ...tokens, user: toMe(user) };
  }

  async logout(principal: AuthPrincipal, context: RequestContext): Promise<void> {
    await this.sessions.revoke(principal.sessionId, 'logout');
    await this.audit.recordSafely({
      actor: actorOf(principal),
      action: 'auth.logout',
      resourceType: 'auth_session',
      resourceId: principal.sessionId,
      outcome: 'SUCCESS',
      context,
    });
  }
}
