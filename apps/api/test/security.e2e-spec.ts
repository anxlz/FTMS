import { createHmac } from 'node:crypto';
import { AttendanceSummaryResponseSchema } from '@ftms/core';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import { EXPORT_LIMIT } from '../src/rate-limit/export-throttle';
import {
  bearer,
  bootTestApp,
  createStudentRecord,
  createUser,
  login,
  resetDatabase,
  type SeededUser,
  type TestApp,
} from './helpers/test-app';

const b64 = (value: object | string) =>
  Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64url');

/** A JWT signed with `secret` (HS256), or unsigned with `alg: none`. */
function jwt(payload: object, secret: string | null, alg = 'HS256'): string {
  const head = `${b64({ alg: secret === null ? 'none' : alg, typ: 'JWT' })}.${b64(payload)}`;
  if (secret === null) return `${head}.`;
  return `${head}.${createHmac('sha256', secret).update(head).digest('base64url')}`;
}

/**
 * §17 controls exercised from the outside, as an attacker would: forged and
 * replayed tokens, injection-shaped input, oversized and malformed bodies,
 * cross-origin calls, response headers, error bodies and export limits.
 */
describe('Security controls (§17)', () => {
  let app: TestApp;
  let prisma: PrismaService;
  const http = () => request(app.getHttpServer());
  let director: SeededUser;
  let student: SeededUser;
  let token: string;
  let studentToken: string;

  beforeAll(async () => {
    ({ app } = await bootTestApp());
    prisma = app.get(PrismaService);
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(async () => {
    await resetDatabase(app);
    director = await createUser(app, 'TRAINING_DIRECTOR');
    student = await createUser(app, 'STUDENT');
    token = (await login(app, director.email, director.password!)).accessToken;
    studentToken = (await login(app, student.email, student.password!)).accessToken;
  });

  describe('access tokens', () => {
    const claims = async () => {
      const session = await prisma.authSession.findFirstOrThrow({ where: { userId: director.id } });
      const now = Math.floor(Date.now() / 1000);
      return {
        sub: director.id,
        sid: session.id,
        role: 'SUPER_ADMIN',
        typ: 'access',
        iss: 'ftms-api',
        aud: 'ftms',
        iat: now,
        exp: now + 600,
      };
    };
    const get = (t: string) => http().get('/admin/users').set(bearer(t));

    it('refuses unsigned, wrongly signed, expired, mis-typed and altered tokens', async () => {
      const c = await claims();
      const real = process.env.JWT_ACCESS_SECRET!;
      const forged = [
        jwt(c, null), // alg: none
        jwt(c, 'an attacker-chosen secret of thirty-two+ chars'),
        jwt(c, process.env.JWT_REFRESH_SECRET!), // the other secret
        jwt({ ...c, exp: c.iat - 10 }, real), // expired
        jwt({ ...c, typ: 'refresh' }, real), // a refresh token's type
        jwt({ ...c, aud: 'someone-else' }, real),
        jwt({ ...c, iss: 'someone-else' }, real),
        jwt(c, real, 'HS512'), // header says another algorithm
        `${token.split('.').slice(0, 2).join('.')}.${'A'.repeat(43)}`, // signature removed
      ];
      for (const t of forged) {
        const res = await get(t);
        expect([t.slice(0, 20), res.status]).toEqual([t.slice(0, 20), 401]);
      }
      // The role in a token is never trusted: a correctly signed Director token
      // that claims SUPER_ADMIN still acts as the Director's account.
      const claimed = await get(jwt(c, real));
      expect(claimed.status).toBe(200);
      const roles = await http()
        .put(`/admin/users/${student.id}/permissions`)
        .set(bearer(jwt(c, real)))
        .send({ grants: [], reason: 'escalation attempt' });
      expect(roles.status).toBe(403);
    });

    it('refuses a token whose session was revoked or whose account was suspended', async () => {
      const c = await claims();
      const real = jwt(c, process.env.JWT_ACCESS_SECRET!);
      await prisma.authSession.update({ where: { id: c.sid }, data: { revokedAt: new Date() } });
      expect((await get(real)).status).toBe(401);
      expect((await get(token)).status).toBe(401);
      await prisma.user.update({ where: { id: student.id }, data: { status: 'SUSPENDED' } });
      expect((await http().get('/auth/me').set(bearer(studentToken))).status).toBe(401);
    });
  });

  describe('input', () => {
    it('treats injection-shaped search text as plain text', async () => {
      await createStudentRecord(app, { seatNumber: 'INJ-1', fullName: "O'Brien Ahmed" });
      for (const q of ["' OR 1=1 --", "'; DROP TABLE users; --", '%', '_', '\\', "O'Brien"]) {
        for (const path of [
          '/students',
          '/tickets',
          '/audit-logs',
          '/reports/attendance-summary',
        ]) {
          const res = await http()
            .get(`${path}?q=${encodeURIComponent(q)}`)
            .set(bearer(token));
          expect([path, q, res.status]).toEqual([path, q, 200]);
        }
      }
      const found = AttendanceSummaryResponseSchema.parse(
        (
          await http()
            .get(`/reports/attendance-summary?q=${encodeURIComponent("O'Brien")}`)
            .set(bearer(token))
        ).body,
      );
      expect(found.rows.map((r) => r.seatNumber)).toEqual(['INJ-1']);
      // Wildcards match literally, not everything.
      const wild = (await http().get('/students?q=%25').set(bearer(token))).body as {
        total: number;
      };
      expect(wild.total).toBe(0);
      expect(await prisma.user.count()).toBe(2);
    });

    it('answers malformed, oversized and prototype-polluting bodies without side effects', async () => {
      const malformed = await http()
        .post('/groups')
        .set(bearer(token))
        .set('content-type', 'application/json')
        .send('{"name": "unterminated');
      expect(malformed.status).toBe(400);
      expect(JSON.stringify(malformed.body)).not.toMatch(/at \w+ \(|node_modules|\.ts:\d+/);

      const huge = await http()
        .post('/groups')
        .set(bearer(token))
        .send({ name: 'x'.repeat(2_000_000) });
      expect([400, 413]).toContain(huge.status);

      const polluted = await http()
        .post('/groups')
        .set(bearer(token))
        .set('content-type', 'application/json')
        .send(
          '{"name": "Clean group", "__proto__": {"isAdmin": true}, "constructor": {"prototype": {"isAdmin": true}}}',
        );
      expect(polluted.status).toBe(201);
      expect(({} as { isAdmin?: boolean }).isAdmin).toBeUndefined();

      // Unknown fields are dropped, never written (mass assignment).
      const renamed = await http()
        .patch('/auth/me/preferences')
        .set(bearer(studentToken))
        .send({ preferredLocale: 'en', role: 'SUPER_ADMIN', status: 'ACTIVE' });
      expect(renamed.status).toBe(200);
      expect((await prisma.user.findUniqueOrThrow({ where: { id: student.id } })).role).toBe(
        'STUDENT',
      );
    });
  });

  describe('responses', () => {
    it('carries headers that keep browsers from sniffing, framing or caching', async () => {
      for (const path of ['/health', '/auth/me', '/no/such/route']) {
        const res = await http().get(path).set(bearer(token));
        expect(res.headers['x-content-type-options']).toBe('nosniff');
        expect(res.headers['x-frame-options']).toBe('DENY');
        expect(res.headers['content-security-policy']).toBe(
          "default-src 'none'; frame-ancestors 'none'",
        );
        expect(res.headers['referrer-policy']).toBe('no-referrer');
        expect(res.headers['cache-control']).toBe('no-store');
        expect(res.headers['x-powered-by']).toBeUndefined();
      }
    });

    it('does not answer cross-origin browser calls (the browser talks to the web server only)', async () => {
      const preflight = await http()
        .options('/auth/login')
        .set('origin', 'https://evil.example')
        .set('access-control-request-method', 'POST');
      expect(preflight.headers['access-control-allow-origin']).toBeUndefined();
      const simple = await http()
        .post('/auth/login')
        .set('origin', 'https://evil.example')
        .send({ identifier: director.email, password: director.password });
      expect(simple.headers['access-control-allow-origin']).toBeUndefined();
      expect(simple.headers['access-control-allow-credentials']).toBeUndefined();
    });

    it('never puts internals in error bodies', async () => {
      const responses = [
        await http().get('/students/not-a-uuid').set(bearer(token)),
        await http().get('/students/01900000-0000-7000-8000-000000000000').set(bearer(token)),
        await http().post('/visits').set(bearer(token)).send({ title: 1 }),
        await http().get('/no/such/route'),
      ];
      for (const res of responses) {
        expect(Object.keys(res.body as object).sort()).toEqual(
          expect.arrayContaining(['code', 'message', 'statusCode']),
        );
        expect(JSON.stringify(res.body)).not.toMatch(/prisma|postgres|SELECT|stack|\.ts:\d+/i);
      }
    });
  });

  it(`limits each account to ${EXPORT_LIMIT.limit} report downloads per ${EXPORT_LIMIT.windowSeconds / 60} minutes`, async () => {
    for (let i = 0; i < EXPORT_LIMIT.limit; i += 1) {
      const path = [
        '/attendance/export?format=csv',
        '/reports/attendance-summary/export?format=csv',
        '/audit-logs/export?format=csv',
      ][i % 3]!;
      expect((await http().get(path).set(bearer(token))).status).toBe(200);
    }
    const refused = await http()
      .get('/reports/attendance-summary/export?format=csv')
      .set(bearer(token));
    expect(refused.status).toBe(429);
    expect(refused.body.code).toBe('AUTH_RATE_LIMITED');
    expect(Number(refused.headers['retry-after'])).toBeGreaterThan(0);
    // Another account is not affected.
    const other = await createUser(app, 'TRAINING_DIRECTOR');
    const otherToken = (await login(app, other.email, other.password!)).accessToken;
    expect((await http().get('/attendance/export?format=csv').set(bearer(otherToken))).status).toBe(
      200,
    );
  });
});
