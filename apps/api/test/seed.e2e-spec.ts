import { checkPasswordPolicy } from '@ftms/core';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import { seedSuperAdmin, SUPER_ADMIN_EMAIL } from '../src/scripts/seed-super-admin';
import {
  bearer,
  bootTestApp,
  createUser,
  login,
  resetDatabase,
  type TestApp,
} from './helpers/test-app';

describe('Super Admin bootstrap (§2) against a real Postgres', () => {
  let app: TestApp;
  let prisma: PrismaService;

  beforeAll(async () => {
    ({ app } = await bootTestApp());
    prisma = app.get(PrismaService);
  });
  beforeEach(() => resetDatabase(app));
  afterAll(async () => {
    await app.close();
  });

  it('creates the Super Admin with a strong one-time password that must be changed', async () => {
    const result = await seedSuperAdmin(prisma);
    expect(result.action).toBe('created');
    if (result.action === 'unchanged') throw new Error('unreachable');
    expect(result.password.length).toBeGreaterThanOrEqual(24);
    expect(checkPasswordPolicy(result.password, [SUPER_ADMIN_EMAIL])).toEqual([]);

    const user = await prisma.user.findUniqueOrThrow({ where: { email: SUPER_ADMIN_EMAIL } });
    expect(user).toMatchObject({ role: 'SUPER_ADMIN', status: 'ACTIVE', mustChangePassword: true });
    expect(user.passwordHash).toMatch(/^\$argon2id\$/);
    expect(user.passwordHash).not.toContain(result.password);

    // The DoD flow: sign in with the generated password → forced to change it.
    const auth = await login(app, 'ST22425244@agr.asu.edu.eg', result.password);
    expect(auth.user.passwordSetupRequired).toBe(true);
    const http = request(app.getHttpServer());
    await http.get('/admin/users').set(bearer(auth.accessToken)).expect(403);
    await request(app.getHttpServer())
      .post('/auth/password/change')
      .set(bearer(auth.accessToken))
      .send({ currentPassword: result.password, newPassword: 'nile delta harvest 2026' })
      .expect(204);
    await request(app.getHttpServer())
      .get('/admin/users')
      .set(bearer(auth.accessToken))
      .expect(200);
    await request(app.getHttpServer())
      .post('/auth/login')
      .send({ identifier: SUPER_ADMIN_EMAIL, password: result.password })
      .expect(401);
  });

  it('is idempotent: a second run changes nothing', async () => {
    const first = await seedSuperAdmin(prisma);
    const before = await prisma.user.findUniqueOrThrow({ where: { email: SUPER_ADMIN_EMAIL } });
    const second = await seedSuperAdmin(prisma);
    expect(second).toEqual({ action: 'unchanged', userId: first.userId });
    const after = await prisma.user.findUniqueOrThrow({ where: { email: SUPER_ADMIN_EMAIL } });
    expect(after.passwordHash).toBe(before.passwordHash);
  });

  it('--reset-password issues a new one-time password and signs out every session', async () => {
    const created = await seedSuperAdmin(prisma);
    if (created.action === 'unchanged') throw new Error('unreachable');
    const session = await login(app, SUPER_ADMIN_EMAIL, created.password);

    const reset = await seedSuperAdmin(prisma, { resetPassword: true });
    if (reset.action === 'unchanged') throw new Error('unreachable');
    expect(reset.action).toBe('reset');
    expect(reset.password).not.toBe(created.password);

    await request(app.getHttpServer()).get('/auth/me').set(bearer(session.accessToken)).expect(401);
    const fresh = await login(app, SUPER_ADMIN_EMAIL, reset.password);
    expect(fresh.user.passwordSetupRequired).toBe(true);
  });

  it('refuses to touch the address if it belongs to a non-admin account', async () => {
    await createUser(app, 'FACULTY', { email: SUPER_ADMIN_EMAIL });
    await expect(seedSuperAdmin(prisma)).rejects.toThrow(/refusing to change it/);
  });

  it('never writes the password to the audit log', async () => {
    const result = await seedSuperAdmin(prisma);
    if (result.action === 'unchanged') throw new Error('unreachable');
    const rows = await prisma.auditLog.findMany();
    expect(rows.map((r) => r.action)).toEqual(['user.seeded']);
    const dump = JSON.stringify(rows, (_, v: unknown) =>
      typeof v === 'bigint' ? v.toString() : v,
    );
    expect(dump).not.toContain(result.password);
  });
});
