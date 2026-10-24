import { Injectable } from '@nestjs/common';
import {
  type AuthResponse,
  type BiometricCredential,
  type BiometricLoginRequest,
  type RegisterCredentialRequest,
  type WebAuthnOptionsResponse,
  type WebAuthnResponseJson,
} from '@ftms/core';
import {
  type AuthenticationResponseJSON,
  generateAuthenticationOptions,
  generateRegistrationOptions,
  type RegistrationResponseJSON,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';
import { AuditService } from '../../audit/audit.service';
import { ApiException, Errors } from '../../common/api-exception';
import { BackgroundTasks } from '../../common/background-tasks.service';
import { Clock } from '../../common/clock';
import { isUniqueViolation } from '../../common/db-errors';
import { type RequestContext } from '../../common/request-context';
import { AppConfigService } from '../../config/app-config.service';
import { type Prisma, type WebAuthnCredential } from '../../generated/prisma/client';
import { MailService } from '../../mail/mail.service';
import { NotificationsService } from '../../notifications/notifications.service';
import { PrismaService } from '../../prisma/prisma.service';
import { rateLimitKey, RateLimiter } from '../../rate-limit/rate-limiter';
import { USER_INCLUDE } from '../../users/user-mapping';
import { biometricChangeEmail } from '../auth-emails';
import { LIMITS } from '../auth.constants';
import { AuthService } from '../auth.service';
import { actorOf, type AuthPrincipal } from '../principal';
import { uuidBytes, uuidFromHandle, WebAuthnChallenges, WebAuthnSettings } from './webauthn';

/** Upper bound of enrolled devices per account. */
const MAX_CREDENTIALS = 10;

export const BiometricErrors = {
  /** One answer for every failure: nothing reveals which credentials or accounts exist. */
  failed: () =>
    new ApiException(401, 'BIOMETRIC_FAILED', 'Biometric verification failed; try again'),
  reauthRequired: () =>
    new ApiException(
      403,
      'BIOMETRIC_REAUTH_REQUIRED',
      'Sign in with your password or an email code to enable biometric sign-in on a device',
    ),
  exists: () =>
    new ApiException(
      409,
      'BIOMETRIC_CREDENTIAL_EXISTS',
      'This device is already registered for biometric sign-in',
    ),
  tooMany: () =>
    new ApiException(409, 'BIOMETRIC_CREDENTIAL_EXISTS', `At most ${MAX_CREDENTIALS} devices`),
};

const toCredential = (c: WebAuthnCredential): BiometricCredential => ({
  id: c.id,
  name: c.name,
  createdAt: c.createdAt.toISOString(),
  lastUsedAt: c.lastUsedAt?.toISOString() ?? null,
  multiDevice: c.multiDevice,
});

/**
 * Biometric sign-in with platform authenticators (WebAuthn passkeys, §4.5).
 * The device's operating system performs the biometric check; the server only
 * stores public keys and verifies signed assertions. No biometric data, private
 * key or raw assertion is ever stored or audited.
 */
@Injectable()
export class BiometricsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly auth: AuthService,
    private readonly challenges: WebAuthnChallenges,
    private readonly settings: WebAuthnSettings,
    private readonly limiter: RateLimiter,
    private readonly notifications: NotificationsService,
    private readonly mail: MailService,
    private readonly background: BackgroundTasks,
    private readonly config: AppConfigService,
    private readonly clock: Clock,
  ) {}

  /* ─────────────────────────── enrollment ─────────────────────────── */

  /**
   * Enrollment must follow a sign-in with a password or an email code: a
   * biometric session can never enroll another device (no bootstrapping).
   */
  async registrationOptions(principal: AuthPrincipal): Promise<WebAuthnOptionsResponse> {
    if (principal.sessionMethod === 'BIOMETRIC') throw BiometricErrors.reauthRequired();
    const active = await this.prisma.webAuthnCredential.findMany({
      where: { userId: principal.userId, revokedAt: null },
    });
    if (active.length >= MAX_CREDENTIALS) throw BiometricErrors.tooMany();
    const options = await generateRegistrationOptions({
      rpName: this.settings.rpName,
      rpID: this.settings.rpId,
      userID: uuidBytes(principal.userId),
      userName: principal.email,
      userDisplayName: principal.displayName,
      attestationType: 'none',
      timeout: 120_000,
      excludeCredentials: active.map((c) => ({ id: c.credentialId, transports: c.transports })),
      authenticatorSelection: {
        authenticatorAttachment: 'platform',
        residentKey: 'required',
        userVerification: 'required',
      },
    });
    const challengeId = await this.challenges.create('REGISTRATION', options.challenge, {
      userId: principal.userId,
    });
    return { challengeId, options: options as unknown as Record<string, unknown> };
  }

  async register(
    principal: AuthPrincipal,
    input: RegisterCredentialRequest,
    context: RequestContext,
  ): Promise<BiometricCredential> {
    if (principal.sessionMethod === 'BIOMETRIC') throw BiometricErrors.reauthRequired();
    const expected = await this.challenges.consume(input.challengeId, 'REGISTRATION', {
      userId: principal.userId,
    });
    if (!expected) throw BiometricErrors.failed();
    let verification;
    try {
      verification = await verifyRegistrationResponse({
        response: input.response as unknown as RegistrationResponseJSON,
        expectedChallenge: expected,
        expectedOrigin: this.settings.origin,
        expectedRPID: this.settings.rpId,
        requireUserVerification: true,
      });
    } catch {
      throw BiometricErrors.failed();
    }
    if (!verification.verified) throw BiometricErrors.failed();
    const info = verification.registrationInfo;

    try {
      const credential = await this.prisma.$transaction(async (tx) => {
        const created = await tx.webAuthnCredential.create({
          data: {
            userId: principal.userId,
            credentialId: info.credential.id,
            publicKey: Buffer.from(info.credential.publicKey),
            signCount: BigInt(info.credential.counter),
            transports: info.credential.transports ?? [],
            multiDevice: info.credentialDeviceType === 'multiDevice',
            backedUp: info.credentialBackedUp,
            aaguid: info.aaguid,
            name: input.name,
            createdAt: this.clock.now(),
          },
        });
        await this.audit.record(
          {
            actor: actorOf(principal),
            action: 'auth.biometric_enabled',
            resourceType: 'webauthn_credential',
            resourceId: created.id,
            outcome: 'SUCCESS',
            after: { name: created.name, multiDevice: created.multiDevice },
            context,
          },
          tx,
        );
        await this.notifications.notify(tx, [principal.userId], {
          type: 'security.biometric_enabled',
          data: { deviceName: created.name },
          link: '/profile',
          dedupeKey: `security.biometric_enabled:${created.id}`,
        });
        return created;
      });
      this.securityEmail(principal.email, true, credential.name);
      return toCredential(credential);
    } catch (error) {
      if (isUniqueViolation(error, 'webauthn_credentials_credential_id_key')) {
        throw BiometricErrors.exists();
      }
      throw error;
    }
  }

  async list(userId: string): Promise<BiometricCredential[]> {
    const rows = await this.prisma.webAuthnCredential.findMany({
      where: { userId, revokedAt: null },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map(toCredential);
  }

  /** Takes effect at once: the device can no longer sign in, and its sessions end. */
  async revoke(
    principal: AuthPrincipal,
    id: string,
    reason: string | undefined,
    context: RequestContext,
  ): Promise<void> {
    const revoked = await this.prisma.$transaction(async (tx) => {
      const rows = await tx.webAuthnCredential.updateManyAndReturn({
        where: { id, userId: principal.userId, revokedAt: null },
        data: {
          revokedAt: this.clock.now(),
          revokedById: principal.userId,
          revokeReason: reason ?? null,
        },
      });
      const credential = rows[0];
      if (!credential) throw Errors.notFound('Device');
      const ended = await tx.authSession.updateMany({
        where: { webauthnCredentialId: id, revokedAt: null },
        data: { revokedAt: new Date(), revokeReason: 'biometric_revoked' },
      });
      await this.audit.record(
        {
          actor: actorOf(principal),
          action: 'auth.biometric_revoked',
          resourceType: 'webauthn_credential',
          resourceId: id,
          outcome: 'SUCCESS',
          reason: reason ?? null,
          before: { name: credential.name },
          metadata: { sessionsEnded: ended.count },
          context,
        },
        tx,
      );
      await this.notifications.notify(tx, [principal.userId], {
        type: 'security.biometric_revoked',
        data: { deviceName: credential.name },
        link: '/profile',
        dedupeKey: `security.biometric_revoked:${id}`,
      });
      return credential;
    });
    this.securityEmail(principal.email, false, revoked.name);
  }

  private securityEmail(to: string, enabled: boolean, deviceName: string): void {
    const content = biometricChangeEmail({
      enabled,
      deviceName,
      webAppUrl: this.config.get('WEB_APP_URL'),
    });
    this.background.run('biometric security email', () =>
      this.mail.send({ to, subject: content.subject, text: content.text }),
    );
  }

  /* ─────────────────────────── sign-in ─────────────────────────── */

  /**
   * Usernameless: the browser offers the account's discoverable passkey, so the
   * request names no account and the response reveals none (anti-enumeration).
   */
  async loginOptions(context: RequestContext): Promise<WebAuthnOptionsResponse> {
    const key = rateLimitKey('biometric-options-ip', context.ip ?? 'unknown');
    const state = await this.limiter.hit(key, LIMITS.biometricOptionsPerIp.windowSeconds);
    if (state.count > LIMITS.biometricOptionsPerIp.limit) {
      throw Errors.rateLimited(state.resetInSeconds || LIMITS.biometricOptionsPerIp.windowSeconds);
    }
    const options = await generateAuthenticationOptions({
      rpID: this.settings.rpId,
      userVerification: 'required',
      timeout: 120_000,
    });
    const challengeId = await this.challenges.create('AUTHENTICATION', options.challenge);
    return { challengeId, options: options as unknown as Record<string, unknown> };
  }

  async login(input: BiometricLoginRequest, context: RequestContext): Promise<AuthResponse> {
    const ipKey = rateLimitKey('biometric-fail-ip', context.ip ?? 'unknown');
    const state = await this.limiter.peek(ipKey);
    if (state.count >= LIMITS.biometricFailuresPerIp.limit) {
      throw Errors.rateLimited(state.resetInSeconds || LIMITS.biometricFailuresPerIp.windowSeconds);
    }
    const fail = async (reason: string, userId: string | null = null): Promise<never> => {
      await this.limiter.hit(ipKey, LIMITS.biometricFailuresPerIp.windowSeconds);
      await this.audit.recordSafely({
        actor: null,
        action: 'auth.login',
        resourceType: 'user',
        resourceId: userId,
        outcome: 'FAILURE',
        reason,
        metadata: { method: 'BIOMETRIC' },
        context,
      });
      throw BiometricErrors.failed();
    };

    const expected = await this.challenges.consume(input.challengeId, 'AUTHENTICATION', {
      userId: null,
    });
    if (!expected) return fail('challenge_invalid');
    const credential = await this.prisma.webAuthnCredential.findUnique({
      where: { credentialId: input.response.id },
    });
    if (!credential || credential.revokedAt) return fail('credential_unknown_or_revoked');
    const verified = await this.verify(credential, input.response, expected);
    if (!verified) return fail('assertion_invalid', credential.userId);

    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: credential.userId },
      include: USER_INCLUDE,
    });
    if (user.status === 'SUSPENDED') throw Errors.accountSuspended();
    await this.limiter.reset(ipKey);
    return this.auth.signIn(
      user,
      'BIOMETRIC',
      context,
      { credentialId: credential.id },
      { webauthnCredentialId: credential.id },
    );
  }

  /**
   * Verifies a fresh assertion from one of the account's active credentials
   * against a challenge already consumed by the caller; records its use.
   * Returns the credential, or null when anything does not match.
   */
  async verifyForUser(
    userId: string,
    response: WebAuthnResponseJson,
    expectedChallenge: string,
    db: Prisma.TransactionClient | PrismaService = this.prisma,
  ): Promise<WebAuthnCredential | null> {
    const credential = await db.webAuthnCredential.findUnique({
      where: { credentialId: response.id },
    });
    if (!credential || credential.userId !== userId || credential.revokedAt) return null;
    return (await this.verify(credential, response, expectedChallenge, db)) ? credential : null;
  }

  private async verify(
    credential: WebAuthnCredential,
    response: WebAuthnResponseJson,
    expectedChallenge: string,
    db: Prisma.TransactionClient | PrismaService = this.prisma,
  ): Promise<boolean> {
    const json = response as unknown as AuthenticationResponseJSON;
    // The user handle, when the authenticator returns it, must name the owner.
    const handle = json.response.userHandle;
    if (handle && uuidFromHandle(handle) !== credential.userId) return false;
    try {
      const result = await verifyAuthenticationResponse({
        response: json,
        expectedChallenge,
        expectedOrigin: this.settings.origin,
        expectedRPID: this.settings.rpId,
        credential: {
          id: credential.credentialId,
          publicKey: new Uint8Array(credential.publicKey),
          counter: Number(credential.signCount),
          transports: credential.transports,
        },
        requireUserVerification: true,
      });
      if (!result.verified) return false;
      await db.webAuthnCredential.update({
        where: { id: credential.id },
        data: {
          signCount: BigInt(result.authenticationInfo.newCounter),
          lastUsedAt: this.clock.now(),
        },
      });
      return true;
    } catch {
      return false;
    }
  }
}
