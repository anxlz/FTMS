import { Injectable } from '@nestjs/common';
import {
  type AuditAction,
  type AuthResponse,
  type ChangePasswordRequest,
  checkPasswordPolicy,
  composeFullName,
  isUniversityEmail,
  parseLoginIdentifier,
  type ResetPasswordRequest,
  type SignupRequest,
  type SignupResponse,
  type SignupVerify,
  type VerificationIssue,
} from '@ftms/core';
import { AuditService } from '../audit/audit.service';
import { ApiException, Errors } from '../common/api-exception';
import { BackgroundTasks } from '../common/background-tasks.service';
import { type RequestContext } from '../common/request-context';
import { AppConfigService } from '../config/app-config.service';
import { type AuthMethod, type ChallengePurpose, Prisma } from '../generated/prisma/client';
import { MailService } from '../mail/mail.service';
import { PrismaService } from '../prisma/prisma.service';
import { RateLimiter, rateLimitKey } from '../rate-limit/rate-limiter';
import { toMe, USER_INCLUDE, type UserWithRelations } from '../users/user-mapping';
import { AUTH, type LimitPolicy, LIMITS } from './auth.constants';
import {
  accountExistsEmail,
  type EmailContent,
  loginCodeEmail,
  passwordResetEmail,
  signupCodeEmail,
} from './auth-emails';
import { ChallengeService } from './challenge.service';
import { hashPassword, verifyAgainstDummy, verifyPassword } from './password-hashing';
import { actorOf, actorOfUser, type AuthPrincipal } from './principal';
import { SessionService } from './session.service';
import { decideIdentityMatch, StudentLinkingService } from './student-linking.service';
import { TokenService } from './token.service';

const CODE_MINUTES = AUTH.codeSeconds / 60;

const emailTaken = () =>
  new ApiException(409, 'EMAIL_ALREADY_EXISTS', 'An account already exists for this email');

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
    private readonly linking: StudentLinkingService,
    private readonly config: AppConfigService,
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

  /**
   * Status checks happen only after the password or code proved the caller knows
   * the account. A student waiting for verification may sign in — the
   * verification guard confines the session to the verification page.
   */
  private assertUsable(user: UserWithRelations): void {
    if (user.status === 'SUSPENDED') throw Errors.accountSuspended();
  }

  async signIn(
    user: UserWithRelations,
    method: AuthMethod,
    context: RequestContext,
    extra: Record<string, unknown> = {},
    session: { webauthnCredentialId?: string } = {},
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
      const tokens = await this.sessions.create(user, method, context, tx, session);
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
    return { ...pair, user: toMe(fresh, method) };
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

  /** Emails in the background, so response time does not reveal whether one was sent. */
  private sendInBackground(to: string, label: string, content: EmailContent): void {
    this.background.run(label, () =>
      this.mail.send({ to, subject: content.subject, text: content.text }),
    );
  }

  /** An imported student record with this email that no account has claimed yet (§4.3). */
  private findUnclaimedRecord(email: string) {
    return this.prisma.studentProfile.findFirst({
      where: { universityEmail: email, userId: null },
    });
  }

  /**
   * First login (§4.3), step 1. A code is sent when:
   * - an account without a password exists for the email (e.g. created by an
   *   admin, or a signup that never set a password), or
   * - no account exists yet but an imported student record carries the email —
   *   the account is created and linked when the code is verified.
   * Every caller gets the same answer either way (anti-enumeration).
   */
  async requestLoginCode(email: string, context: RequestContext): Promise<void> {
    await this.limitCodeRequest(email, context);
    const action = 'auth.login_code.requested';
    const user = await this.findByEmail(email);
    const record = user ? null : await this.findUnclaimedRecord(email);
    const refusal = user
      ? user.status === 'SUSPENDED'
        ? 'account_suspended'
        : user.passwordHash !== null
          ? 'password_already_set'
          : null
      : record
        ? null
        : 'unknown_email';

    if (refusal) {
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

    const code = await this.challenges.issue(email, 'LOGIN', context, { userId: user?.id });
    await this.audit.record({
      actor: user ? actorOfUser(user) : null,
      action,
      resourceType: user ? 'user' : 'student',
      resourceId: user?.id ?? record!.id,
      outcome: 'SUCCESS',
      metadata: user ? null : { firstLoginForImportedRecord: true },
      context,
    });
    this.sendInBackground(email, 'LOGIN code email', loginCodeEmail(code, CODE_MINUTES));
  }

  async requestPasswordReset(email: string, context: RequestContext): Promise<void> {
    await this.limitCodeRequest(email, context);
    const action = 'auth.password_reset.requested';
    const user = await this.findByEmail(email);
    const refusal = !user
      ? 'unknown_email'
      : user.status === 'SUSPENDED'
        ? 'account_suspended'
        : null;
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
    const code = await this.challenges.issue(email, 'PASSWORD_RESET', context, { userId: user.id });
    await this.audit.record({
      actor: actorOfUser(user),
      action,
      resourceType: 'user',
      resourceId: user.id,
      outcome: 'SUCCESS',
      context,
    });
    this.sendInBackground(
      email,
      'PASSWORD_RESET code email',
      passwordResetEmail(code, CODE_MINUTES),
    );
  }

  /**
   * Verifies a code for `purpose`; counts failures per email and IP. Returns the
   * account for the email, if one exists (signup and first login of an imported
   * record verify an address that has no account yet).
   */
  private async consumeCode(
    email: string,
    code: string,
    purpose: ChallengePurpose,
    auditAction: AuditAction,
    context: RequestContext,
  ): Promise<UserWithRelations | null> {
    const emailKey = rateLimitKey('code-fail-email', email);
    const ipKey = this.ipKey('code-fail-ip', context);
    await this.ensureBelow(LIMITS.codeFailuresPerEmail, emailKey);
    await this.ensureBelow(LIMITS.codeFailuresPerIp, ipKey);

    const ok = await this.challenges.consume(email, purpose, code);
    const user = await this.findByEmail(email);
    if (!ok) {
      await this.count(LIMITS.codeFailuresPerEmail, emailKey);
      await this.count(LIMITS.codeFailuresPerIp, ipKey);
      await this.audit.recordSafely({
        actor: user ? actorOfUser(user) : null,
        action: auditAction,
        resourceType: 'user',
        resourceId: user?.id ?? null,
        outcome: 'FAILURE',
        reason: 'code_invalid_or_expired',
        context,
      });
      throw Errors.codeInvalid();
    }
    await this.limiter.reset(emailKey);
    if (user) this.assertUsable(user);
    return user;
  }

  /**
   * First login, step 2. For an imported record without an account, the verified
   * email proves the person is the one faculty recorded: the account is created
   * and linked in one transaction (§4.3 steps 3–4), then a password is set.
   */
  async verifyLoginCode(
    email: string,
    code: string,
    context: RequestContext,
  ): Promise<AuthResponse> {
    const action = 'auth.login_code.verified';
    const existing = await this.consumeCode(email, code, 'LOGIN', action, context);
    if (existing) return this.signIn(existing, 'EMAIL_CODE', context);

    const userId = await this.prisma.$transaction(async (tx) => {
      const record = await tx.studentProfile.findFirst({
        where: { universityEmail: email, userId: null },
      });
      if (!record) return null;
      const user = await this.linking.createAccount(tx, {
        email,
        displayName: record.fullName,
        status: 'ACTIVE',
      });
      if (!(await this.linking.link(tx, { userId: user.id, studentId: record.id, email }))) {
        throw Errors.codeInvalid();
      }
      await this.audit.record(
        {
          actor: { id: user.id, displayName: record.fullName, role: 'STUDENT' },
          action: 'student.account_linked',
          resourceType: 'student',
          resourceId: record.id,
          outcome: 'SUCCESS',
          after: { userId: user.id, email, seatNumber: record.seatNumber },
          metadata: { method: 'first_login_email_code' },
          context,
        },
        tx,
      );
      return user.id;
    });
    if (!userId) {
      // The record was removed or claimed between the code request and now.
      await this.audit.recordSafely({
        actor: null,
        action,
        resourceType: 'user',
        outcome: 'FAILURE',
        reason: 'no_account_or_unclaimed_record',
        context,
      });
      throw Errors.codeInvalid();
    }
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      include: USER_INCLUDE,
    });
    return this.signIn(user, 'EMAIL_CODE', context, { accountCreated: true });
  }

  async resetPassword(input: ResetPasswordRequest, context: RequestContext): Promise<void> {
    const user = await this.consumeCode(
      input.email,
      input.code,
      'PASSWORD_RESET',
      'auth.password_reset.completed',
      context,
    );
    if (!user) throw Errors.codeInvalid();
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

  /* ───────────────────────────── signup (§4.2) ───────────────────────────── */

  /**
   * Signup, step 1: verify the university email before anything is created.
   * Only university addresses are accepted. If an account already exists, the
   * address gets a "you already have an account" email instead of a code — the
   * response is the same, so nothing is revealed to whoever typed it.
   */
  async requestSignupCode(input: SignupRequest, context: RequestContext): Promise<void> {
    this.assertUniversityEmail(input.email);
    await this.limitCodeRequest(input.email, context);
    const action = 'auth.signup.code_requested';
    const user = await this.findByEmail(input.email);
    if (user) {
      await this.audit.recordSafely({
        actor: null,
        action,
        resourceType: 'user',
        resourceId: user.id,
        outcome: 'FAILURE',
        reason: 'account_exists',
        context,
      });
      this.sendInBackground(
        input.email,
        'account exists email',
        accountExistsEmail(this.config.get('WEB_APP_URL')),
      );
      return;
    }
    const code = await this.challenges.issue(input.email, 'SIGNUP', context);
    await this.audit.record({
      actor: null,
      action,
      resourceType: 'user',
      outcome: 'SUCCESS',
      metadata: { seatNumber: input.seatNumber },
      context,
    });
    this.sendInBackground(input.email, 'SIGNUP code email', signupCodeEmail(code, CODE_MINUTES));
  }

  /**
   * Signup, step 2: the code proves the email. Then (§4.2):
   * - Case A — seat number + identity match an imported record: the account is
   *   created ACTIVE and linked; the record's data is the account's data.
   * - Case B — no trustworthy match: the account is created PENDING_VERIFICATION
   *   with a review request; it cannot reach academic data until a reviewer
   *   links or creates its record.
   * The student then sets a password (the account has none yet).
   */
  async verifySignup(input: SignupVerify, context: RequestContext): Promise<SignupResponse> {
    this.assertUniversityEmail(input.email);
    const existing = await this.consumeCode(
      input.email,
      input.code,
      'SIGNUP',
      'auth.signup.completed',
      context,
    );
    if (existing) throw emailTaken();

    const fullName = composeFullName(input);
    let outcome: { userId: string; linked: boolean };
    try {
      outcome = await this.prisma.$transaction(async (tx) => {
        const matchInput = await this.linking.matchInput(
          tx,
          input.email,
          input.seatNumber,
          fullName,
        );
        const match = decideIdentityMatch(matchInput);
        const record = matchInput.bySeat;

        if (match.kind === 'MATCH' && record) {
          const user = await this.linking.createAccount(tx, {
            email: input.email,
            displayName: record.fullName,
            status: 'ACTIVE',
          });
          if (
            await this.linking.link(tx, {
              userId: user.id,
              studentId: record.id,
              email: input.email,
            })
          ) {
            await this.audit.record(
              {
                actor: { id: user.id, displayName: record.fullName, role: 'STUDENT' },
                action: 'student.account_linked',
                resourceType: 'student',
                resourceId: record.id,
                outcome: 'SUCCESS',
                after: { userId: user.id, email: input.email, seatNumber: record.seatNumber },
                metadata: { method: 'signup' },
                context,
              },
              tx,
            );
            return { userId: user.id, linked: true };
          }
          // Claimed by someone else a moment ago: fall through to review.
          await tx.user.update({
            where: { id: user.id },
            data: { status: 'PENDING_VERIFICATION' },
          });
          await this.verificationRequest(
            tx,
            user.id,
            input,
            fullName,
            'SEAT_ALREADY_LINKED',
            context,
          );
          return { userId: user.id, linked: false };
        }

        const user = await this.linking.createAccount(tx, {
          email: input.email,
          displayName: fullName,
          status: 'PENDING_VERIFICATION',
        });
        const issue = match.kind === 'NO_MATCH' ? match.issue : 'NO_RECORD';
        await this.verificationRequest(tx, user.id, input, fullName, issue, context);
        return { userId: user.id, linked: false };
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw emailTaken();
      }
      throw error;
    }

    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: outcome.userId },
      include: USER_INCLUDE,
    });
    const session = await this.signIn(user, 'EMAIL_CODE', context, {
      signup: outcome.linked ? 'linked' : 'pending_review',
    });
    return { ...session, linked: outcome.linked };
  }

  private async verificationRequest(
    tx: Prisma.TransactionClient,
    userId: string,
    input: SignupRequest,
    fullName: string,
    issue: VerificationIssue,
    context: RequestContext,
  ): Promise<void> {
    const request = await tx.studentVerificationRequest.create({
      data: {
        userId,
        seatNumber: input.seatNumber,
        firstName: input.firstName,
        fatherName: input.fatherName,
        grandfatherName: input.grandfatherName,
        familyName: input.familyName,
        fullName,
        issue,
      },
    });
    await this.audit.record(
      {
        actor: { id: userId, displayName: fullName, role: 'STUDENT' },
        action: 'student.verification.requested',
        resourceType: 'student_verification_request',
        resourceId: request.id,
        outcome: 'SUCCESS',
        after: { seatNumber: input.seatNumber, fullName, issue },
        metadata: { source: 'signup' },
        context,
      },
      tx,
    );
  }

  private assertUniversityEmail(email: string): void {
    if (!isUniversityEmail(email, this.config.get('UNIVERSITY_EMAIL_DOMAINS'))) {
      throw new ApiException(400, 'EMAIL_NOT_UNIVERSITY', 'Use your university email address', {
        details: { email: ['EMAIL_NOT_UNIVERSITY'] },
      });
    }
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
    const { user, tokens, method } = await this.sessions.rotate(claims, context);
    return { ...tokens, user: toMe(user, method) };
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
