import { AuthResponseSchema, MeResponseSchema } from '@ftms/core';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import { MemoryRateLimiter, RateLimiter } from '../src/rate-limit/rate-limiter';
import {
  bearer,
  bootTestApp,
  createUser,
  fromClientIp,
  login,
  type Mailbox,
  resetDatabase,
  type TestApp,
} from './helpers/test-app';

describe('Authentication (§4.3, §20.1) against a real Postgres', () => {
  let app: TestApp;
  let mailbox: Mailbox;
  let prisma: PrismaService;
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    ({ app, mailbox } = await bootTestApp());
    prisma = app.get(PrismaService);
  });
  beforeEach(async () => {
    await resetDatabase(app);
    mailbox.clear();
  });
  afterAll(async () => {
    await app.close();
  });

  /* ───────────────────────────── password login ───────────────────────────── */

  describe('password login', () => {
    it('signs in with the university email, case-insensitively', async () => {
      const faculty = await createUser(app, 'FACULTY');
      const res = await http()
        .post('/auth/login')
        .send({ identifier: faculty.email.toUpperCase(), password: faculty.password })
        .expect(200);
      const body = AuthResponseSchema.parse(res.body);
      expect(body.user).toMatchObject({
        email: faculty.email,
        role: 'FACULTY',
        passwordSetupRequired: false,
      });
      expect(new Date(body.accessTokenExpiresAt).getTime()).toBeGreaterThan(Date.now());
    });

    it('signs in with the seat number', async () => {
      const student = await createUser(app, 'STUDENT', { seatNumber: 'AG-2026' });
      const res = await http()
        .post('/auth/login')
        .send({ identifier: ' ag-2026 ', password: student.password })
        .expect(200);
      expect(res.body.user.studentProfile).toEqual({
        seatNumber: 'AG-2026',
        fullName: expect.any(String),
      });
    });

    it('rejects a seat-number login for a student who has no password yet', async () => {
      const student = await createUser(app, 'STUDENT', { password: null, seatNumber: 'NOPW-1' });
      const res = await http()
        .post('/auth/login')
        .send({ identifier: 'NOPW-1', password: 'anything at all 123' })
        .expect(401);
      expect(res.body.code).toBe('AUTH_INVALID_CREDENTIALS');
      const audit = await prisma.auditLog.findFirst({ where: { resourceId: student.id } });
      expect(audit).toMatchObject({
        action: 'auth.login',
        outcome: 'FAILURE',
        reason: 'no_password_set',
      });
    });

    it('answers unknown accounts, unlinked seat numbers and wrong passwords identically', async () => {
      const faculty = await createUser(app, 'FACULTY');
      await prisma.studentProfile.create({
        data: { seatNumber: 'IMPORTED-1', fullName: 'Not linked yet' },
      });
      const attempts = [
        { identifier: 'nobody@agr.asu.edu.eg', password: 'whatever whatever' },
        { identifier: 'IMPORTED-1', password: 'whatever whatever' },
        { identifier: faculty.email, password: 'wrong password here' },
        { identifier: '!!not-an-identifier!!', password: 'whatever whatever' },
      ];
      const bodies = [];
      for (const attempt of attempts) {
        const res = await http().post('/auth/login').send(attempt).expect(401);
        bodies.push(res.body);
      }
      expect(new Set(bodies.map((b) => JSON.stringify(b))).size).toBe(1);
      expect(bodies[0]).toEqual({
        statusCode: 401,
        code: 'AUTH_INVALID_CREDENTIALS',
        message: 'Invalid credentials',
      });
    });

    it('reveals a suspension only to someone who knows the password', async () => {
      const faculty = await createUser(app, 'FACULTY', { status: 'SUSPENDED' });
      await http()
        .post('/auth/login')
        .send({ identifier: faculty.email, password: 'wrong one here' })
        .expect(401);
      const res = await http()
        .post('/auth/login')
        .send({ identifier: faculty.email, password: faculty.password })
        .expect(403);
      expect(res.body.code).toBe('AUTH_ACCOUNT_SUSPENDED');
    });

    it('locks an identifier after 10 failures — even the right password then gets 429', async () => {
      const faculty = await createUser(app, 'FACULTY');
      for (let i = 0; i < 10; i += 1) {
        await http()
          .post('/auth/login')
          .set(fromClientIp(`198.51.100.${i + 1}`))
          .send({ identifier: faculty.email, password: `wrong ${i} attempt` })
          .expect(401);
      }
      const res = await http()
        .post('/auth/login')
        .set(fromClientIp('198.51.100.200'))
        .send({ identifier: faculty.email, password: faculty.password })
        .expect(429);
      expect(res.body.code).toBe('AUTH_RATE_LIMITED');
      expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
    });

    it('limits failures per client IP across different accounts', async () => {
      for (let i = 0; i < 50; i += 1) {
        await http()
          .post('/auth/login')
          .set(fromClientIp('203.0.113.7'))
          .send({ identifier: `ghost${i}@agr.asu.edu.eg`, password: 'nope nope nope' })
          .expect(401);
      }
      const faculty = await createUser(app, 'FACULTY');
      await http()
        .post('/auth/login')
        .set(fromClientIp('203.0.113.7'))
        .send({ identifier: faculty.email, password: faculty.password })
        .expect(429);
      // A different client is unaffected.
      await http()
        .post('/auth/login')
        .set(fromClientIp('203.0.113.8'))
        .send({ identifier: faculty.email, password: faculty.password })
        .expect(200);
    }, 60_000);

    it('rejects a malformed body with field-level validation errors', async () => {
      const res = await http().post('/auth/login').send({ identifier: '' }).expect(400);
      expect(res.body.code).toBe('VALIDATION_FAILED');
      expect(Object.keys(res.body.details as Record<string, unknown>)).toEqual(
        expect.arrayContaining(['identifier', 'password']),
      );
    });
  });

  /* ─────────────────────── first login by emailed code ─────────────────────── */

  describe('first login with an emailed code', () => {
    const requestCode = (email: string, ip = '192.0.2.10') =>
      http().post('/auth/code/request').set(fromClientIp(ip)).send({ email });

    it('emails a code only to accounts without a password, with an identical answer for everyone', async () => {
      const fresh = await createUser(app, 'STUDENT', { password: null });
      const established = await createUser(app, 'FACULTY');

      const responses = await Promise.all([
        requestCode(fresh.email, '192.0.2.1'),
        requestCode(established.email, '192.0.2.2'),
        requestCode('nobody@agr.asu.edu.eg', '192.0.2.3'),
      ]);
      for (const res of responses) {
        expect(res.status).toBe(202);
        expect(res.body).toEqual({ accepted: true });
      }
      expect(await mailbox.latestCode(fresh.email)).toMatch(/^\d{6}$/);
      expect(mailbox.messages.map((m) => m.to)).toEqual([fresh.email]);
    });

    it('signs in with the code, then blocks everything except setting a password', async () => {
      const student = await createUser(app, 'STUDENT', { password: null, seatNumber: 'FIRST-1' });
      await requestCode(student.email).expect(202);
      const code = (await mailbox.latestCode(student.email))!;

      const res = await http()
        .post('/auth/code/verify')
        .send({ email: student.email, code })
        .expect(200);
      const auth = AuthResponseSchema.parse(res.body);
      expect(auth.user.passwordSetupRequired).toBe(true);

      // The account can read itself but nothing else until a password exists.
      await http().get('/auth/me').set(bearer(auth.accessToken)).expect(200);
      const blocked = await http().get('/admin/users').set(bearer(auth.accessToken)).expect(403);
      expect(blocked.body.code).toBe('AUTH_PASSWORD_CHANGE_REQUIRED');

      await http()
        .post('/auth/password/change')
        .set(bearer(auth.accessToken))
        .send({ newPassword: 'olive branch lantern 9' })
        .expect(204);

      const me = MeResponseSchema.parse(
        (await http().get('/auth/me').set(bearer(auth.accessToken)).expect(200)).body,
      );
      expect(me.passwordSetupRequired).toBe(false);
      // Now both identifiers work with the new password.
      await login(app, student.email, 'olive branch lantern 9');
      await login(app, 'FIRST-1', 'olive branch lantern 9');
      const user = await prisma.user.findUniqueOrThrow({ where: { id: student.id } });
      expect(user.emailVerifiedAt).not.toBeNull();
    });

    it('rejects wrong codes and burns the code after 5 attempts', async () => {
      const student = await createUser(app, 'STUDENT', { password: null });
      await requestCode(student.email).expect(202);
      const code = (await mailbox.latestCode(student.email))!;
      const wrong = code === '000000' ? '111111' : '000000';
      for (let i = 0; i < 5; i += 1) {
        const res = await http()
          .post('/auth/code/verify')
          .send({ email: student.email, code: wrong })
          .expect(400);
        expect(res.body.code).toBe('AUTH_CODE_INVALID');
      }
      await http().post('/auth/code/verify').send({ email: student.email, code }).expect(400);
    });

    it('rejects an expired code', async () => {
      const student = await createUser(app, 'STUDENT', { password: null });
      await requestCode(student.email).expect(202);
      const code = (await mailbox.latestCode(student.email))!;
      await prisma.authChallenge.updateMany({
        where: { userId: student.id },
        data: {
          expiresAt: new Date(Date.now() - 1000),
          createdAt: new Date(Date.now() - 11 * 60_000),
        },
      });
      await http().post('/auth/code/verify').send({ email: student.email, code }).expect(400);
    });

    it('accepts a code only once', async () => {
      const student = await createUser(app, 'STUDENT', { password: null });
      await requestCode(student.email).expect(202);
      const code = (await mailbox.latestCode(student.email))!;
      await http().post('/auth/code/verify').send({ email: student.email, code }).expect(200);
      await http().post('/auth/code/verify').send({ email: student.email, code }).expect(400);
    });

    it('invalidates the previous code when a new one is issued, and enforces a cooldown', async () => {
      const student = await createUser(app, 'STUDENT', { password: null });
      await requestCode(student.email).expect(202);
      const first = (await mailbox.latestCode(student.email))!;

      const tooSoon = await requestCode(student.email).expect(429);
      expect(tooSoon.body.code).toBe('AUTH_RATE_LIMITED');

      // Skip the cooldown by expiring its counter, then request again.
      await resetDatabaseLimiterOnly(app);
      await requestCode(student.email).expect(202);
      const second = (await mailbox.latestCode(student.email))!;
      if (first !== second) {
        await http()
          .post('/auth/code/verify')
          .send({ email: student.email, code: first })
          .expect(400);
      }
      await http()
        .post('/auth/code/verify')
        .send({ email: student.email, code: second })
        .expect(200);
    });

    it('rejects a malformed code without touching the database', async () => {
      const res = await http()
        .post('/auth/code/verify')
        .send({ email: 'a@agr.asu.edu.eg', code: '12ab' })
        .expect(400);
      expect(res.body).toMatchObject({
        code: 'VALIDATION_FAILED',
        details: { code: ['CODE_FORMAT'] },
      });
    });
  });

  /* ──────────────────────────── password recovery ──────────────────────────── */

  describe('password recovery', () => {
    it('resets the password with an emailed code and signs out every session', async () => {
      const faculty = await createUser(app, 'FACULTY');
      const session = await login(app, faculty.email, faculty.password!);

      await http().post('/auth/password/forgot').send({ email: faculty.email }).expect(202);
      const code = (await mailbox.latestCode(faculty.email))!;
      await http()
        .post('/auth/password/reset')
        .send({ email: faculty.email, code, newPassword: 'quiet river morning 77' })
        .expect(204);

      await http().get('/auth/me').set(bearer(session.accessToken)).expect(401);
      await http()
        .post('/auth/login')
        .send({ identifier: faculty.email, password: faculty.password })
        .expect(401);
      await login(app, faculty.email, 'quiet river morning 77');
    });

    it('answers identically for unknown emails and sends nothing', async () => {
      const res = await http()
        .post('/auth/password/forgot')
        .send({ email: 'ghost@agr.asu.edu.eg' })
        .expect(202);
      expect(res.body).toEqual({ accepted: true });
      expect(await mailbox.latestCode('ghost@agr.asu.edu.eg')).toBeNull();
    });

    it('enforces the password policy on reset (code stays unusable for a second try)', async () => {
      const faculty = await createUser(app, 'FACULTY', { email: 'dr.salma@agr.asu.edu.eg' });
      await http().post('/auth/password/forgot').send({ email: faculty.email }).expect(202);
      const code = (await mailbox.latestCode(faculty.email))!;
      const res = await http()
        .post('/auth/password/reset')
        .send({ email: faculty.email, code, newPassword: 'dr.salma-2026-pass' })
        .expect(400);
      expect(res.body).toMatchObject({
        code: 'PASSWORD_POLICY',
        details: { newPassword: ['CONTAINS_IDENTIFIER'] },
      });
    });
  });

  /* ───────────────────────────── password change ───────────────────────────── */

  describe('password change', () => {
    it('requires the current password, rejects reuse, and keeps only the current session', async () => {
      const faculty = await createUser(app, 'FACULTY');
      const keep = await login(app, faculty.email, faculty.password!);
      const other = await login(app, faculty.email, faculty.password!);

      const wrong = await http()
        .post('/auth/password/change')
        .set(bearer(keep.accessToken))
        .send({ currentPassword: 'not my password', newPassword: 'fresh meadow sunrise 5' })
        .expect(400);
      expect(wrong.body.code).toBe('AUTH_CURRENT_PASSWORD_INCORRECT');

      const reuse = await http()
        .post('/auth/password/change')
        .set(bearer(keep.accessToken))
        .send({ currentPassword: faculty.password, newPassword: faculty.password })
        .expect(400);
      expect(reuse.body.details).toEqual({ newPassword: ['SAME_AS_CURRENT'] });

      await http()
        .post('/auth/password/change')
        .set(bearer(keep.accessToken))
        .send({ currentPassword: faculty.password, newPassword: 'fresh meadow sunrise 5' })
        .expect(204);

      await http().get('/auth/me').set(bearer(keep.accessToken)).expect(200);
      await http().get('/auth/me').set(bearer(other.accessToken)).expect(401);
    });

    it('forces a seeded account to change its password before anything else', async () => {
      const admin = await createUser(app, 'SUPER_ADMIN', { mustChangePassword: true });
      const auth = await login(app, admin.email, admin.password!);
      expect(auth.user.passwordSetupRequired).toBe(true);
      await http().get('/admin/users').set(bearer(auth.accessToken)).expect(403);
      await http()
        .post('/auth/password/change')
        .set(bearer(auth.accessToken))
        .send({ currentPassword: admin.password, newPassword: 'harvest moon citadel 3' })
        .expect(204);
      await http().get('/admin/users').set(bearer(auth.accessToken)).expect(200);
    });
  });

  /* ───────────────────────────────── sessions ───────────────────────────────── */

  describe('sessions and refresh tokens', () => {
    it('rotates refresh tokens on every use', async () => {
      const faculty = await createUser(app, 'FACULTY');
      const first = await login(app, faculty.email, faculty.password!);
      const res = await http()
        .post('/auth/refresh')
        .send({ refreshToken: first.refreshToken })
        .expect(200);
      const second = AuthResponseSchema.parse(res.body);
      expect(second.refreshToken).not.toBe(first.refreshToken);
      expect(second.refreshTokenExpiresAt).toBe(first.refreshTokenExpiresAt); // absolute lifetime
      await http().get('/auth/me').set(bearer(second.accessToken)).expect(200);
    });

    it('tolerates a parallel refresh within the grace window, then treats reuse as theft', async () => {
      const faculty = await createUser(app, 'FACULTY');
      const first = await login(app, faculty.email, faculty.password!);
      await http().post('/auth/refresh').send({ refreshToken: first.refreshToken }).expect(200);
      // Same (now previous) token again, seconds later: a parallel tab — allowed.
      const parallel = await http()
        .post('/auth/refresh')
        .send({ refreshToken: first.refreshToken })
        .expect(200);

      // Long after the rotation, presenting an old token means it leaked.
      await prisma.authSession.updateMany({
        where: { userId: faculty.id },
        data: { rotatedAt: new Date(Date.now() - 5 * 60_000) },
      });
      const stolen = await http()
        .post('/auth/refresh')
        .send({ refreshToken: first.refreshToken })
        .expect(401);
      expect(stolen.body.code).toBe('AUTH_SESSION_INVALID');

      // The whole session is gone, including the legitimate holder's tokens.
      await http()
        .post('/auth/refresh')
        .send({ refreshToken: parallel.body.refreshToken })
        .expect(401);
      await http()
        .get('/auth/me')
        .set(bearer(AuthResponseSchema.parse(parallel.body).accessToken))
        .expect(401);
      const audit = await prisma.auditLog.findFirst({
        where: { reason: 'refresh_token_reuse_detected' },
      });
      expect(audit?.actorId).toBe(faculty.id);
    });

    it('rejects an access token used as a refresh token, and garbage', async () => {
      const faculty = await createUser(app, 'FACULTY');
      const auth = await login(app, faculty.email, faculty.password!);
      await http().post('/auth/refresh').send({ refreshToken: auth.accessToken }).expect(401);
      await http().post('/auth/refresh').send({ refreshToken: 'not.a.jwt' }).expect(401);
      await http().get('/auth/me').set(bearer(auth.refreshToken)).expect(401);
    });

    it('logout revokes the session immediately', async () => {
      const faculty = await createUser(app, 'FACULTY');
      const auth = await login(app, faculty.email, faculty.password!);
      await http().post('/auth/logout').set(bearer(auth.accessToken)).expect(204);
      await http().get('/auth/me').set(bearer(auth.accessToken)).expect(401);
      await http().post('/auth/refresh').send({ refreshToken: auth.refreshToken }).expect(401);
    });

    it('a suspension takes effect on the very next request', async () => {
      const faculty = await createUser(app, 'FACULTY');
      const auth = await login(app, faculty.email, faculty.password!);
      await prisma.user.update({ where: { id: faculty.id }, data: { status: 'SUSPENDED' } });
      await http().get('/auth/me').set(bearer(auth.accessToken)).expect(401);
      await http().post('/auth/refresh').send({ refreshToken: auth.refreshToken }).expect(401);
    });

    it('stores the language preference on the profile', async () => {
      const student = await createUser(app, 'STUDENT');
      const auth = await login(app, student.email, student.password!);
      expect(auth.user.preferredLocale).toBe('ar');
      const res = await http()
        .patch('/auth/me/preferences')
        .set(bearer(auth.accessToken))
        .send({ preferredLocale: 'en' })
        .expect(200);
      expect(res.body.preferredLocale).toBe('en');
      await http()
        .patch('/auth/me/preferences')
        .set(bearer(auth.accessToken))
        .send({ preferredLocale: 'fr' })
        .expect(400);
    });
  });

  /* ───────────────────────────────── auditing ───────────────────────────────── */

  it('audits every step and never stores passwords, codes or tokens (§15.2)', async () => {
    const student = await createUser(app, 'STUDENT', { password: null });
    await requestCode(student.email);
    const code = (await mailbox.latestCode(student.email))!;
    const auth = AuthResponseSchema.parse(
      (await http().post('/auth/code/verify').send({ email: student.email, code })).body,
    );
    const newPassword = 'secret sauce ninety 9';
    await http()
      .post('/auth/password/change')
      .set(bearer(auth.accessToken))
      .send({ newPassword })
      .expect(204);
    await http()
      .post('/auth/login')
      .send({ identifier: student.email, password: 'wrong guess 1234' })
      .expect(401);
    const refreshed = AuthResponseSchema.parse(
      (await http().post('/auth/refresh').send({ refreshToken: auth.refreshToken })).body,
    );

    const rows = await prisma.auditLog.findMany({ orderBy: { id: 'asc' } });
    expect(rows.map((r) => `${r.action}:${r.outcome}`)).toEqual([
      'auth.login_code.requested:SUCCESS',
      'auth.login:SUCCESS',
      'auth.password.changed:SUCCESS',
      'auth.login:FAILURE',
    ]);
    const dump = JSON.stringify(rows, (_, v: unknown) =>
      typeof v === 'bigint' ? v.toString() : v,
    );
    for (const secret of [
      code,
      newPassword,
      'wrong guess 1234',
      auth.accessToken,
      auth.refreshToken,
      refreshed.refreshToken,
    ]) {
      expect(dump).not.toContain(secret);
    }
    expect(rows[1]?.metadata).toEqual({ method: 'EMAIL_CODE' });
  });

  function requestCode(email: string) {
    return http().post('/auth/code/request').set(fromClientIp('192.0.2.99')).send({ email });
  }
});

/** Clears only the rate-limit counters (keeps database state). */
function resetDatabaseLimiterOnly(app: TestApp): Promise<void> {
  const limiter = app.get(RateLimiter);
  if (limiter instanceof MemoryRateLimiter) limiter.clear();
  return Promise.resolve();
}
