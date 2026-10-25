import { generateKeyPairSync, type KeyObject, sign } from 'node:crypto';
import {
  AuthResponseSchema,
  BiometricCredentialSchema,
  DeviceKeyChallengeSchema,
  deviceKeyMessage,
  type LocalDate,
  PROGRAM_TIME_ZONE,
  zonedToUtc,
} from '@ftms/core';
import request from 'supertest';
import { AttendanceTokens } from '../src/attendance/attendance-tokens';
import { PrismaService } from '../src/prisma/prisma.service';
import {
  addToGroup,
  bearer,
  bootTestApp,
  createGroup,
  createProgram,
  createUser,
  createVisit,
  fromClientIp,
  login,
  type Mailbox,
  recordOf,
  resetDatabase,
  type SeededUser,
  type TestApp,
  TestClock,
} from './helpers/test-app';

/**
 * A simulated Android device: an EC P-256 key pair standing in for the Android
 * Keystore key, signing with ECDSA-SHA256 (DER), as `Signature("SHA256withECDSA")`
 * does after the BiometricPrompt succeeds. The server sees only the public key.
 */
class AndroidDevice {
  readonly keys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  credentialId: string | null = null;

  get publicKey(): string {
    return this.keys.publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
  }

  sign(message: string, key: KeyObject = this.keys.privateKey): string {
    return sign('sha256', Buffer.from(message), { key, dsaEncoding: 'der' }).toString('base64');
  }
}

/**
 * Optional biometric sign-in in the Android app (Phase 8, §12.1 of the Phase 8
 * prompt): a Keystore key registered after a password or code sign-in, challenge
 * signatures verified by the server, revocation, and the password/code fallback.
 */
describe('Android device-key biometric sign-in (Phase 8)', () => {
  const clock = new TestClock();
  let app: TestApp;
  let mailbox: Mailbox;
  let prisma: PrismaService;
  const http = () => request(app.getHttpServer());
  let student: SeededUser;
  let token: string;

  beforeAll(async () => {
    ({ app, mailbox } = await bootTestApp({ clock }));
    prisma = app.get(PrismaService);
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(async () => {
    clock.reset();
    mailbox.clear();
    await resetDatabase(app);
    student = await createUser(app, 'STUDENT');
    token = (await login(app, student.email, student.password!)).accessToken;
  });

  const expectError = (res: request.Response, status: number, code: string) =>
    expect({ status: res.status, code: res.body?.code }).toEqual({ status, code });

  const ok = async (pending: Promise<request.Response>) => {
    const res = await pending;
    expect({ status: res.status, code: res.body?.code }).toEqual({ status: 200, code: undefined });
    return res;
  };

  async function registrationChallenge(accessToken = token) {
    const res = await http()
      .post('/auth/biometric/device/options')
      .set(bearer(accessToken))
      .expect(200);
    return DeviceKeyChallengeSchema.parse(res.body);
  }

  /** Enables biometric sign-in for the device, as Profile → Security → Biometric login does. */
  async function enable(device: AndroidDevice, accessToken = token) {
    const { challengeId, challenge } = await registrationChallenge(accessToken);
    const res = await http()
      .post('/auth/biometric/device')
      .set(bearer(accessToken))
      .send({
        challengeId,
        publicKey: device.publicKey,
        signature: device.sign(deviceKeyMessage('register', challengeId, challenge)),
        name: 'Pixel 8',
      })
      .expect(201);
    const credential = BiometricCredentialSchema.parse(res.body);
    device.credentialId = credential.credentialId;
    return credential;
  }

  async function loginChallenge(credentialId: string, headers: Record<string, string> = {}) {
    const res = await http()
      .post('/auth/biometric/device/login/options')
      .set(headers)
      .send({ credentialId })
      .expect(200);
    return DeviceKeyChallengeSchema.parse(res.body);
  }

  async function deviceLogin(device: AndroidDevice, headers: Record<string, string> = {}) {
    const { challengeId, challenge } = await loginChallenge(device.credentialId!, headers);
    return http()
      .post('/auth/biometric/device/login')
      .set(headers)
      .send({
        challengeId,
        credentialId: device.credentialId,
        signature: device.sign(
          deviceKeyMessage('login', challengeId, challenge, device.credentialId!),
        ),
      });
  }

  it('is off until the user enables it: nothing is registered and a sign-in attempt fails', async () => {
    const list = await http().get('/auth/biometric/credentials').set(bearer(token)).expect(200);
    expect(list.body).toEqual([]);
    const device = new AndroidDevice();
    device.credentialId = 'never-registered-0123456789';
    expectError(await deviceLogin(device), 401, 'BIOMETRIC_FAILED');
    expect(await prisma.webAuthnCredential.count()).toBe(0);
  });

  it('can be enabled only from a password or email-code session', async () => {
    expectError(await http().post('/auth/biometric/device/options'), 401, 'AUTH_REQUIRED');
    const device = new AndroidDevice();
    await enable(device);
    const biometric = AuthResponseSchema.parse((await ok(deviceLogin(device))).body);
    expectError(
      await http().post('/auth/biometric/device/options').set(bearer(biometric.accessToken)),
      403,
      'BIOMETRIC_REAUTH_REQUIRED',
    );
    // An account without a password enables it after signing in with an emailed code.
    const fresh = await createUser(app, 'STUDENT', { password: null });
    await http().post('/auth/code/request').send({ email: fresh.email }).expect(202);
    const code = (await mailbox.latestCode(fresh.email))!;
    const viaCode = AuthResponseSchema.parse(
      (await http().post('/auth/code/verify').send({ email: fresh.email, code }).expect(200)).body,
    );
    await http()
      .post('/auth/password/change')
      .set(bearer(viaCode.accessToken))
      .send({ newPassword: 'quiet meadow lantern 64' })
      .expect(204);
    const relogin = await login(app, fresh.email, 'quiet meadow lantern 64');
    await enable(new AndroidDevice(), relogin.accessToken);
  });

  it('registers a key only with a valid, fresh proof of possession of a P-256 key', async () => {
    const device = new AndroidDevice();
    const stranger = new AndroidDevice();
    const attempt = async (change: (c: { challengeId: string; challenge: string }) => object) => {
      const c = await registrationChallenge();
      return http()
        .post('/auth/biometric/device')
        .set(bearer(token))
        .send({
          challengeId: c.challengeId,
          publicKey: device.publicKey,
          signature: device.sign(deviceKeyMessage('register', c.challengeId, c.challenge)),
          name: 'Phone',
          ...change(c),
        });
    };
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const p384 = generateKeyPairSync('ec', { namedCurve: 'secp384r1' });
    for (const change of [
      // Signed by another key.
      (c: { challengeId: string; challenge: string }) => ({
        signature: stranger.sign(deviceKeyMessage('register', c.challengeId, c.challenge)),
      }),
      // Over another challenge, or for sign-in instead of registration.
      (c: { challengeId: string }) => ({
        signature: device.sign(deviceKeyMessage('register', c.challengeId, 'other')),
      }),
      (c: { challengeId: string; challenge: string }) => ({
        signature: device.sign(deviceKeyMessage('login', c.challengeId, c.challenge)),
      }),
      // Not an EC P-256 key.
      () => ({
        publicKey: rsa.publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
      }),
      () => ({
        publicKey: p384.publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
      }),
      () => ({ publicKey: Buffer.from('not a key at all, just bytes').toString('base64') }),
    ]) {
      expectError(await attempt(change), 401, 'BIOMETRIC_FAILED');
    }
    // A challenge is single-use and expires after 5 minutes.
    const c = await registrationChallenge();
    const body = {
      challengeId: c.challengeId,
      publicKey: device.publicKey,
      signature: device.sign(deviceKeyMessage('register', c.challengeId, c.challenge)),
      name: 'Phone',
    };
    clock.set(new Date(Date.now() + 5 * 60_000 + 1000));
    expectError(
      await http().post('/auth/biometric/device').set(bearer(token)).send(body),
      401,
      'BIOMETRIC_FAILED',
    );
    clock.reset();
    expect(await prisma.webAuthnCredential.count()).toBe(0);

    const credential = await enable(device);
    expect(credential).toMatchObject({ kind: 'ANDROID_KEY', name: 'Pixel 8', multiDevice: false });
    const stored = await prisma.webAuthnCredential.findUniqueOrThrow({
      where: { id: credential.id },
    });
    expect(Buffer.from(stored.publicKey).toString('base64')).toBe(device.publicKey);
    // Audited and notified, without key material.
    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { action: 'auth.biometric_enabled' },
    });
    expect(audit.after).toEqual({ name: 'Pixel 8', kind: 'ANDROID_KEY' });
    const logged = JSON.stringify(
      (await prisma.auditLog.findMany()).map((e) => [e.before, e.after, e.metadata, e.reason]),
    );
    expect(logged).not.toContain(device.publicKey.slice(20, 60));
    expect(logged).not.toContain(credential.credentialId);
    expect(
      await prisma.notification.count({
        where: { recipientId: student.id, type: 'security.biometric_enabled' },
      }),
    ).toBe(1);
  });

  it('signs in with a valid signature from the registered key', async () => {
    const device = new AndroidDevice();
    await enable(device);
    const res = await ok(deviceLogin(device));
    const auth = AuthResponseSchema.parse(res.body);
    expect(auth.user.id).toBe(student.id);
    const session = await prisma.authSession.findFirstOrThrow({
      where: { userId: student.id, method: 'BIOMETRIC' },
    });
    expect(session.webauthnCredentialId).not.toBeNull();
    await http().get('/auth/me').set(bearer(auth.accessToken)).expect(200);
    // The options answer is the same whether or not the credential exists.
    const known = await loginChallenge(device.credentialId!);
    const unknown = await loginChallenge('unknown-credential-0123456789');
    expect(Object.keys(known)).toEqual(Object.keys(unknown));
  });

  it('rejects wrong signatures, expired or reused challenges, other credentials and passkey routes', async () => {
    const device = new AndroidDevice();
    const otherDevice = new AndroidDevice();
    await enable(device);
    const someoneElse = await createUser(app, 'STUDENT');
    const theirs = new AndroidDevice();
    await enable(theirs, (await login(app, someoneElse.email, someoneElse.password!)).accessToken);
    const post = (body: object) => http().post('/auth/biometric/device/login').send(body);

    // Signed by another key.
    let c = await loginChallenge(device.credentialId!);
    expectError(
      await post({
        challengeId: c.challengeId,
        credentialId: device.credentialId,
        signature: otherDevice.sign(
          deviceKeyMessage('login', c.challengeId, c.challenge, device.credentialId!),
        ),
      }),
      401,
      'BIOMETRIC_FAILED',
    );
    // A challenge issued for one credential, signed and sent for another account's.
    c = await loginChallenge(device.credentialId!);
    expectError(
      await post({
        challengeId: c.challengeId,
        credentialId: theirs.credentialId,
        signature: theirs.sign(
          deviceKeyMessage('login', c.challengeId, c.challenge, theirs.credentialId!),
        ),
      }),
      401,
      'BIOMETRIC_FAILED',
    );
    // Reused challenge.
    c = await loginChallenge(device.credentialId!);
    const good = {
      challengeId: c.challengeId,
      credentialId: device.credentialId,
      signature: device.sign(
        deviceKeyMessage('login', c.challengeId, c.challenge, device.credentialId!),
      ),
    };
    await post(good).expect(200);
    expectError(await post(good), 401, 'BIOMETRIC_FAILED');
    // Expired challenge.
    c = await loginChallenge(device.credentialId!);
    clock.set(new Date(Date.now() + 5 * 60_000 + 1000));
    expectError(
      await post({
        challengeId: c.challengeId,
        credentialId: device.credentialId,
        signature: device.sign(
          deviceKeyMessage('login', c.challengeId, c.challenge, device.credentialId!),
        ),
      }),
      401,
      'BIOMETRIC_FAILED',
    );
    clock.reset();
    // A signature made for registration is not a sign-in.
    c = await loginChallenge(device.credentialId!);
    expectError(
      await post({
        challengeId: c.challengeId,
        credentialId: device.credentialId,
        signature: device.sign(deviceKeyMessage('register', c.challengeId, c.challenge)),
      }),
      401,
      'BIOMETRIC_FAILED',
    );
    // A client-side "success" flag is not a signature.
    c = await loginChallenge(device.credentialId!);
    expectError(
      await post({
        challengeId: c.challengeId,
        credentialId: device.credentialId,
        biometricSuccess: true,
      }),
      400,
      'VALIDATION_FAILED',
    );
    // A device key cannot be used on the passkey (WebAuthn) route.
    const options = await http().post('/auth/biometric/login/options').expect(200);
    expectError(
      await http()
        .post('/auth/biometric/login')
        .send({
          challengeId: options.body.challengeId,
          response: {
            id: device.credentialId,
            rawId: device.credentialId,
            type: 'public-key',
            response: {},
          },
        }),
      401,
      'BIOMETRIC_FAILED',
    );
  });

  it('disabling it revokes the credential at once; password, code sign-in and attendance are unaffected', async () => {
    const device = new AndroidDevice();
    const credential = await enable(device);
    const viaDevice = AuthResponseSchema.parse((await ok(deviceLogin(device))).body);

    // Another account cannot remove it.
    const intruder = await createUser(app, 'STUDENT');
    const intruderToken = (await login(app, intruder.email, intruder.password!)).accessToken;
    expectError(
      await http()
        .delete(`/auth/biometric/credentials/${credential.id}`)
        .set(bearer(intruderToken))
        .send({}),
      404,
      'NOT_FOUND',
    );

    // Profile → Security → Biometric login → off: the session that is open stays open.
    await http()
      .delete(`/auth/biometric/credentials/${credential.id}`)
      .set(bearer(token))
      .send({ reason: 'Turned off on this phone' })
      .expect(204);
    await http().get('/auth/me').set(bearer(token)).expect(200);
    // The device can no longer sign in, and the session it opened has ended.
    expectError(await deviceLogin(device), 401, 'BIOMETRIC_FAILED');
    expectError(
      await http().get('/auth/me').set(bearer(viaDevice.accessToken)),
      401,
      'AUTH_REQUIRED',
    );
    expect(
      await http()
        .get('/auth/biometric/credentials')
        .set(bearer(token))
        .then((r) => r.body as unknown),
    ).toEqual([]);

    // Password sign-in still works…
    await login(app, student.email, student.password!);
    // …and so does the emailed code for an account without a password.
    const codeOnly = await createUser(app, 'STUDENT', { password: null });
    await http().post('/auth/code/request').send({ email: codeOnly.email }).expect(202);
    await http()
      .post('/auth/code/verify')
      .send({ email: codeOnly.email, code: (await mailbox.latestCode(codeOnly.email))! })
      .expect(200);

    // Attendance never depended on it: the student checks in normally.
    const program = await createProgram(app);
    const group = await createGroup(app);
    await addToGroup(app, await recordOf(app, student.id), group.id);
    const day: LocalDate = '2026-12-15';
    const visit = await createVisit(app, program.id, [group.id], { date: day, startTime: '10:00' });
    clock.set(zonedToUtc(day, '10:05', PROGRAM_TIME_ZONE));
    const fresh = (await login(app, student.email, student.password!)).accessToken;
    await http()
      .post('/attendance/check-in')
      .set(bearer(fresh))
      .send({
        token: app.get(AttendanceTokens).sign(visit.id),
        location: { latitude: 30, longitude: 31, accuracy: 10 },
      })
      .expect(201);
  });

  it('failed attempts change nothing but the per-IP limit', async () => {
    const device = new AndroidDevice();
    await enable(device);
    const ip = fromClientIp('203.0.113.9');
    const wrong = new AndroidDevice();
    wrong.credentialId = device.credentialId;
    for (let i = 0; i < 30; i += 1) {
      expectError(await deviceLogin(wrong, ip), 401, 'BIOMETRIC_FAILED');
    }
    expectError(await deviceLogin(device, ip), 429, 'AUTH_RATE_LIMITED');
    // The account and the credential are untouched; another network can sign in.
    expect((await prisma.user.findUniqueOrThrow({ where: { id: student.id } })).status).toBe(
      'ACTIVE',
    );
    await ok(deviceLogin(device, fromClientIp('203.0.113.10')));
    await login(app, student.email, student.password!);
  });
});
