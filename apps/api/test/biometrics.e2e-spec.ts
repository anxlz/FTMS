import {
  AuthResponseSchema,
  BiometricCredentialSchema,
  MeResponseSchema,
  WebAuthnOptionsResponseSchema,
} from '@ftms/core';
import request from 'supertest';
import { z } from 'zod';
import { WebAuthnSettings } from '../src/auth/biometrics/webauthn';
import { BackgroundTasks } from '../src/common/background-tasks.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { SoftAuthenticator } from './helpers/authenticator';
import {
  bearer,
  bootTestApp,
  createUser,
  fromClientIp,
  login,
  type Mailbox,
  resetDatabase,
  type SeededUser,
  type TestApp,
  TestClock,
} from './helpers/test-app';

describe('Biometric sign-in with platform passkeys (§4.5, §20.1)', () => {
  let app: TestApp;
  let mailbox: Mailbox;
  let prisma: PrismaService;
  let origin: string;
  const clock = new TestClock();
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    ({ app, mailbox } = await bootTestApp({ clock }));
    prisma = app.get(PrismaService);
    origin = app.get(WebAuthnSettings).origin;
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(async () => {
    clock.reset();
    await resetDatabase(app);
    mailbox.clear();
  });

  const device = () => new SoftAuthenticator(origin);

  /** The whole audit log as text, to prove what it never contains. */
  const auditText = async () =>
    JSON.stringify(await prisma.auditLog.findMany(), (_k, v: unknown) =>
      typeof v === 'bigint' ? String(v) : v,
    );

  async function registrationOptions(token: string) {
    const res = await http().post('/auth/biometric/credentials/options').set(bearer(token));
    expect(res.status).toBe(200);
    return WebAuthnOptionsResponseSchema.parse(res.body);
  }

  /** Signs in with the password and enrolls `authenticator` as "My phone". */
  async function enroll(user: SeededUser, authenticator = device(), name = 'My phone') {
    const { accessToken } = await login(app, user.email, user.password!);
    const { challengeId, options } = await registrationOptions(accessToken);
    const res = await http()
      .post('/auth/biometric/credentials')
      .set(bearer(accessToken))
      .send({ challengeId, name, response: authenticator.register(options) })
      .expect(201);
    return { credential: BiometricCredentialSchema.parse(res.body), accessToken, authenticator };
  }

  async function loginOptions(ip = '192.0.2.10') {
    const res = await http()
      .post('/auth/biometric/login/options')
      .set(fromClientIp(ip))
      .expect(200);
    return WebAuthnOptionsResponseSchema.parse(res.body);
  }

  function biometricLogin(body: object, ip = '192.0.2.10') {
    return http().post('/auth/biometric/login').set(fromClientIp(ip)).send(body);
  }

  async function signInWith(authenticator: SoftAuthenticator) {
    const { challengeId, options } = await loginOptions();
    return biometricLogin({ challengeId, response: authenticator.assert(options) });
  }

  /* ─────────────────────────── enrollment ─────────────────────────── */

  it('needs a signed-in account to enroll a device', async () => {
    const options = await http().post('/auth/biometric/credentials/options').expect(401);
    expect(options.body.code).toBe('AUTH_REQUIRED');
    const list = await http().get('/auth/biometric/credentials').expect(401);
    expect(list.body.code).toBe('AUTH_REQUIRED');
  });

  it('enrolls a platform passkey after a password sign-in, audits and notifies it', async () => {
    const student = await createUser(app, 'STUDENT');
    const { accessToken } = await login(app, student.email, student.password!);
    const { challengeId, options } = await registrationOptions(accessToken);
    // Discoverable, user-verifying platform credential bound to this site.
    expect(options).toMatchObject({
      rp: { id: new URL(origin).hostname },
      authenticatorSelection: {
        authenticatorAttachment: 'platform',
        residentKey: 'required',
        userVerification: 'required',
      },
      attestation: 'none',
    });
    // The user handle is the account id's bytes, not the email or seat number.
    const handle = Buffer.from((options as { user: { id: string } }).user.id, 'base64url');
    expect(handle.toString('hex')).toBe(student.id.replace(/-/g, ''));

    const authenticator = device();
    const res = await http()
      .post('/auth/biometric/credentials')
      .set(bearer(accessToken))
      .send({ challengeId, name: 'هاتفي', response: authenticator.register(options) })
      .expect(201);
    const credential = BiometricCredentialSchema.parse(res.body);
    expect(credential).toMatchObject({ name: 'هاتفي', lastUsedAt: null, multiDevice: false });

    const list = await http()
      .get('/auth/biometric/credentials')
      .set(bearer(accessToken))
      .expect(200);
    expect(z.array(BiometricCredentialSchema).parse(list.body)).toEqual([credential]);

    const row = await prisma.webAuthnCredential.findUniqueOrThrow({ where: { id: credential.id } });
    expect(row.credentialId).toBe(authenticator.id);
    expect(row.publicKey.length).toBeGreaterThan(60); // COSE public key only

    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { action: 'auth.biometric_enabled', resourceId: credential.id },
    });
    expect(audit.actorId).toBe(student.id);
    // No key material, challenge or assertion anywhere in the audit log.
    const log = await auditText();
    expect(log).not.toContain(authenticator.id);
    expect(log).not.toContain(Buffer.from(row.publicKey).toString('base64'));
    expect(log).not.toContain(Buffer.from(row.publicKey).toString('base64url'));
    expect(log).not.toContain(options.challenge as string);

    await app.get(BackgroundTasks).drain();
    expect(mailbox.messages.some((m) => m.to === student.email)).toBe(true);
    const notification = await prisma.notification.findFirstOrThrow({
      where: { recipientId: student.id, type: 'security.biometric_enabled' },
    });
    expect(notification.link).toBe('/profile');
  });

  it('refuses an enrollment from a biometric session (no device bootstrapping)', async () => {
    const student = await createUser(app, 'STUDENT');
    const { authenticator } = await enroll(student);
    const signedIn = AuthResponseSchema.parse((await signInWith(authenticator)).body);

    const me = MeResponseSchema.parse(
      (await http().get('/auth/me').set(bearer(signedIn.accessToken)).expect(200)).body,
    );
    expect(me.sessionMethod).toBe('BIOMETRIC');

    const res = await http()
      .post('/auth/biometric/credentials/options')
      .set(bearer(signedIn.accessToken))
      .expect(403);
    expect(res.body.code).toBe('BIOMETRIC_REAUTH_REQUIRED');
  });

  it('rejects enrollment responses that do not answer this account’s challenge', async () => {
    const [a, b] = [await createUser(app, 'STUDENT'), await createUser(app, 'FACULTY')];
    const tokenA = (await login(app, a.email, a.password!)).accessToken;
    const tokenB = (await login(app, b.email, b.password!)).accessToken;
    const optionsA = await registrationOptions(tokenA);

    // B cannot spend A's challenge.
    const stolen = await http()
      .post('/auth/biometric/credentials')
      .set(bearer(tokenB))
      .send({
        challengeId: optionsA.challengeId,
        name: 'Phone',
        response: device().register(optionsA.options),
      })
      .expect(401);
    expect(stolen.body.code).toBe('BIOMETRIC_FAILED');

    // Without user verification (no biometric check on the device).
    const fresh = await registrationOptions(tokenA);
    await http()
      .post('/auth/biometric/credentials')
      .set(bearer(tokenA))
      .send({
        challengeId: fresh.challengeId,
        name: 'Phone',
        response: device().register(fresh.options, { userVerified: false }),
      })
      .expect(401);

    // From another site.
    const other = await registrationOptions(tokenA);
    await http()
      .post('/auth/biometric/credentials')
      .set(bearer(tokenA))
      .send({
        challengeId: other.challengeId,
        name: 'Phone',
        response: device().register(other.options, { origin: 'https://evil.example' }),
      })
      .expect(401);

    // Expired challenge.
    const late = await registrationOptions(tokenA);
    clock.set(new Date(Date.now() + 6 * 60_000));
    await http()
      .post('/auth/biometric/credentials')
      .set(bearer(tokenA))
      .send({
        challengeId: late.challengeId,
        name: 'Phone',
        response: device().register(late.options),
      })
      .expect(401);
    clock.reset();

    // A challenge is single-use.
    const once = await registrationOptions(tokenA);
    const authenticator = device();
    const body = {
      challengeId: once.challengeId,
      name: 'Phone',
      response: authenticator.register(once.options),
    };
    await http().post('/auth/biometric/credentials').set(bearer(tokenA)).send(body).expect(201);
    await http().post('/auth/biometric/credentials').set(bearer(tokenA)).send(body).expect(401);

    expect(await prisma.webAuthnCredential.count()).toBe(1);
  });

  it('refuses to register the same device twice', async () => {
    const student = await createUser(app, 'STUDENT');
    const { accessToken, authenticator } = await enroll(student);
    const { challengeId, options } = await registrationOptions(accessToken);
    // The browser is told which credentials already exist…
    expect((options as { excludeCredentials: { id: string }[] }).excludeCredentials).toEqual([
      expect.objectContaining({ id: authenticator.id }),
    ]);
    // …and the server refuses a duplicate anyway.
    const res = await http()
      .post('/auth/biometric/credentials')
      .set(bearer(accessToken))
      .send({ challengeId, name: 'Again', response: authenticator.register(options) })
      .expect(409);
    expect(res.body.code).toBe('BIOMETRIC_CREDENTIAL_EXISTS');
  });

  /* ─────────────────────────── sign-in ─────────────────────────── */

  it('signs in with a valid assertion from a registered device, without naming the account', async () => {
    const faculty = await createUser(app, 'FACULTY');
    const { credential, authenticator } = await enroll(faculty);

    const { challengeId, options } = await loginOptions();
    // Usernameless: no account hints in the options.
    expect(options).not.toHaveProperty('allowCredentials.0');
    expect(options).toMatchObject({ userVerification: 'required' });

    const res = await biometricLogin({ challengeId, response: authenticator.assert(options) });
    expect(res.status).toBe(200);
    const auth = AuthResponseSchema.parse(res.body);
    expect(auth.user.id).toBe(faculty.id);

    const session = await prisma.authSession.findFirstOrThrow({
      where: { userId: faculty.id, method: 'BIOMETRIC' },
    });
    expect(session.webauthnCredentialId).toBe(credential.id);
    const row = await prisma.webAuthnCredential.findUniqueOrThrow({ where: { id: credential.id } });
    expect(row.lastUsedAt).not.toBeNull();
    expect(row.signCount).toBe(1n);

    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { action: 'auth.login', actorId: faculty.id, outcome: 'SUCCESS' },
      orderBy: { occurredAt: 'desc' },
    });
    expect(audit.metadata).toMatchObject({ method: 'BIOMETRIC' });
    const log = await auditText();
    expect(log).not.toContain(authenticator.id);
    expect(log).not.toContain(options.challenge as string);
  });

  it('refuses every assertion that is not a fresh, valid one from a registered device', async () => {
    const student = await createUser(app, 'STUDENT');
    const { authenticator } = await enroll(student);

    const expectFailure = async (body: object) => {
      const res = await biometricLogin(body);
      expect({ status: res.status, code: res.body.code }).toEqual({
        status: 401,
        code: 'BIOMETRIC_FAILED',
      });
    };

    // An unregistered device.
    let o = await loginOptions();
    await expectFailure({ challengeId: o.challengeId, response: device().assert(o.options) });
    // A forged signature.
    o = await loginOptions();
    await expectFailure({
      challengeId: o.challengeId,
      response: authenticator.assert(o.options, { forgeSignature: true }),
    });
    // No biometric verification on the device.
    o = await loginOptions();
    await expectFailure({
      challengeId: o.challengeId,
      response: authenticator.assert(o.options, { userVerified: false }),
    });
    // Signed for another site.
    o = await loginOptions();
    await expectFailure({
      challengeId: o.challengeId,
      response: authenticator.assert(o.options, { origin: 'https://evil.example' }),
    });
    // A user handle naming another account.
    const other = await createUser(app, 'STUDENT');
    o = await loginOptions();
    await expectFailure({
      challengeId: o.challengeId,
      response: authenticator.assert(o.options, {
        userHandle: Buffer.from(other.id.replace(/-/g, ''), 'hex').toString('base64url'),
      }),
    });
    // An answer to a challenge that was never issued.
    o = await loginOptions();
    await expectFailure({
      challengeId: '01900000-0000-7000-8000-000000000000',
      response: authenticator.assert(o.options),
    });
    // Replaying a successful assertion.
    o = await loginOptions();
    const good = { challengeId: o.challengeId, response: authenticator.assert(o.options) };
    expect((await biometricLogin(good)).status).toBe(200);
    await expectFailure(good);
    // An expired challenge.
    o = await loginOptions();
    clock.set(new Date(Date.now() + 6 * 60_000));
    await expectFailure({ challengeId: o.challengeId, response: authenticator.assert(o.options) });
    clock.reset();

    expect(
      await prisma.authSession.count({ where: { userId: student.id, method: 'BIOMETRIC' } }),
    ).toBe(1);
    const failures = await prisma.auditLog.count({
      where: { action: 'auth.login', outcome: 'FAILURE' },
    });
    expect(failures).toBeGreaterThanOrEqual(7);
  });

  it('rate-limits failed biometric sign-ins per client IP', async () => {
    const student = await createUser(app, 'STUDENT');
    await enroll(student);
    const ip = '198.51.100.77';
    for (let i = 0; i < 30; i += 1) {
      const o = await loginOptions(ip);
      const res = await biometricLogin(
        { challengeId: o.challengeId, response: device().assert(o.options) },
        ip,
      );
      expect(res.status).toBe(401);
    }
    const o = await loginOptions(ip);
    const res = await biometricLogin(
      { challengeId: o.challengeId, response: device().assert(o.options) },
      ip,
    );
    expect(res.status).toBe(429);
    expect(res.body.code).toBe('AUTH_RATE_LIMITED');
  });

  it('refuses a suspended account even with a valid device', async () => {
    const student = await createUser(app, 'STUDENT');
    const { authenticator } = await enroll(student);
    await prisma.user.update({ where: { id: student.id }, data: { status: 'SUSPENDED' } });
    const res = await signInWith(authenticator);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('AUTH_ACCOUNT_SUSPENDED');
  });

  /* ─────────────────────────── revocation ─────────────────────────── */

  it('revoking a device stops its sign-ins at once and ends the sessions it opened', async () => {
    const student = await createUser(app, 'STUDENT');
    const { credential, accessToken, authenticator } = await enroll(student);
    const phone = AuthResponseSchema.parse((await signInWith(authenticator)).body);
    await http().get('/auth/me').set(bearer(phone.accessToken)).expect(200);

    await http()
      .delete(`/auth/biometric/credentials/${credential.id}`)
      .set(bearer(accessToken))
      .send({ reason: 'Lost the phone' })
      .expect(204);

    // The session opened with the device ends immediately; the password session stays.
    await http().get('/auth/me').set(bearer(phone.accessToken)).expect(401);
    await http().post('/auth/refresh').send({ refreshToken: phone.refreshToken }).expect(401);
    await http().get('/auth/me').set(bearer(accessToken)).expect(200);

    const res = await signInWith(authenticator);
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('BIOMETRIC_FAILED');

    const list = await http()
      .get('/auth/biometric/credentials')
      .set(bearer(accessToken))
      .expect(200);
    expect(list.body).toEqual([]);

    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { action: 'auth.biometric_revoked', resourceId: credential.id },
    });
    expect(audit).toMatchObject({ actorId: student.id, reason: 'Lost the phone' });
    expect(audit.metadata).toMatchObject({ sessionsEnded: 1 });
    await app.get(BackgroundTasks).drain();
    expect(
      await prisma.notification.count({
        where: { recipientId: student.id, type: 'security.biometric_revoked' },
      }),
    ).toBe(1);

    // Revoked is final: a second revoke finds nothing; the row cannot be revived.
    await http()
      .delete(`/auth/biometric/credentials/${credential.id}`)
      .set(bearer(accessToken))
      .send({})
      .expect(404);
    await expect(
      prisma.webAuthnCredential.update({ where: { id: credential.id }, data: { revokedAt: null } }),
    ).rejects.toThrow();
  });

  it('lets each account manage only its own devices', async () => {
    const owner = await createUser(app, 'STUDENT');
    const { credential } = await enroll(owner);
    const admin = await createUser(app, 'SUPER_ADMIN');
    const adminToken = (await login(app, admin.email, admin.password!)).accessToken;

    const list = await http()
      .get('/auth/biometric/credentials')
      .set(bearer(adminToken))
      .expect(200);
    expect(list.body).toEqual([]);
    await http()
      .delete(`/auth/biometric/credentials/${credential.id}`)
      .set(bearer(adminToken))
      .send({})
      .expect(404);
    const row = await prisma.webAuthnCredential.findUniqueOrThrow({ where: { id: credential.id } });
    expect(row.revokedAt).toBeNull();
  });

  /* ─────────────────────────── other methods remain ─────────────────────────── */

  it('keeps password and emailed-code sign-in working after biometrics are enabled', async () => {
    const faculty = await createUser(app, 'FACULTY');
    const { authenticator } = await enroll(faculty);

    // Password sign-in.
    const byPassword = await login(app, faculty.email, faculty.password!);
    const me = MeResponseSchema.parse(
      (await http().get('/auth/me').set(bearer(byPassword.accessToken)).expect(200)).body,
    );
    expect(me.sessionMethod).toBe('PASSWORD');

    // Recovery by emailed code, then the new password.
    await http().post('/auth/password/forgot').send({ email: faculty.email }).expect(202);
    const code = (await mailbox.latestCode(faculty.email))!;
    await http()
      .post('/auth/password/reset')
      .send({ email: faculty.email, code, newPassword: 'quiet orchard lantern 42' })
      .expect(204);
    await login(app, faculty.email, 'quiet orchard lantern 42');

    // The device still works.
    expect((await signInWith(authenticator)).status).toBe(200);

    // An account first signing in with an emailed code (no password yet).
    const fresh = await createUser(app, 'STUDENT', { password: null });
    await http().post('/auth/code/request').send({ email: fresh.email }).expect(202);
    const first = (await mailbox.latestCode(fresh.email))!;
    const res = await http()
      .post('/auth/code/verify')
      .send({ email: fresh.email, code: first })
      .expect(200);
    const session = AuthResponseSchema.parse(res.body);
    expect(session.user).toMatchObject({
      passwordSetupRequired: true,
      sessionMethod: 'EMAIL_CODE',
    });
  });
});
