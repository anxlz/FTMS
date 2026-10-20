import { PERMISSIONS } from '@ftms/core';
import { PrismaService } from '../src/prisma/prisma.service';
import { bootTestApp, createUser, resetDatabase, type TestApp } from './helpers/test-app';

/**
 * The database itself enforces the rules that matter most (§16.1), so a bug in
 * application code — or a direct SQL session — cannot break them.
 */
describe('Database structure (real Postgres)', () => {
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

  const sqlError = async (sql: string, ...params: unknown[]) => {
    try {
      await prisma.$executeRawUnsafe(sql, ...params);
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
    throw new Error(`Expected the database to reject: ${sql}`);
  };

  it('enables Row Level Security on every table in the public schema', async () => {
    const tables = await prisma.$queryRaw<{ relname: string; relrowsecurity: boolean }[]>`
      SELECT c.relname, c.relrowsecurity FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r' ORDER BY c.relname`;
    expect(tables.length).toBeGreaterThanOrEqual(9);
    expect(tables.filter((t) => !t.relrowsecurity).map((t) => t.relname)).toEqual([]);
  });

  it('gives the Supabase Data API roles no table access (when those roles exist)', async () => {
    const leaks = await prisma.$queryRaw<{ grantee: string; table_name: string }[]>`
      SELECT grantee, table_name FROM information_schema.role_table_grants
      WHERE table_schema = 'public' AND grantee IN ('anon', 'authenticated')`;
    expect(leaks).toEqual([]);
  });

  it('keeps the permissions table identical to the @ftms/core catalog', async () => {
    const rows = await prisma.permission.findMany({ orderBy: { key: 'asc' } });
    const expected = Object.entries(PERMISSIONS)
      .map(([key, p]) => ({ key, grantable: p.grantable, description: p.description }))
      .sort((a, b) => a.key.localeCompare(b.key));
    expect(rows).toEqual(expected);
  });

  describe('audit log is append-only', () => {
    beforeEach(async () => {
      await prisma.auditLog.create({
        data: { action: 'test.event', resourceType: 'test', outcome: 'SUCCESS' },
      });
    });

    it.each([
      ['UPDATE', `UPDATE audit_logs SET action = 'tampered'`],
      ['DELETE', 'DELETE FROM audit_logs'],
      ['TRUNCATE', 'TRUNCATE audit_logs'],
    ])('rejects %s', async (_op, sql) => {
      expect(await sqlError(sql)).toContain('audit_logs is append-only');
      expect(await prisma.auditLog.count()).toBe(1);
    });

    it('rejects updates through Prisma as well', async () => {
      await expect(prisma.auditLog.updateMany({ data: { action: 'tampered' } })).rejects.toThrow();
      await expect(prisma.auditLog.deleteMany({})).rejects.toThrow();
    });
  });

  it('stores emails only in normalized lowercase form', async () => {
    const error = await sqlError(
      `INSERT INTO users (id, email, role, display_name, updated_at)
       VALUES (gen_random_uuid(), 'Mixed@Case.eg', 'FACULTY', 'X', now())`,
    );
    expect(error).toContain('users_email_normalized');
  });

  it('enforces unique emails and seat numbers, and the seat number format', async () => {
    const student = await createUser(app, 'STUDENT', { seatNumber: 'UNIQ-1' });
    await expect(
      prisma.user.create({ data: { email: student.email, role: 'FACULTY', displayName: 'Dup' } }),
    ).rejects.toThrow();
    await expect(
      prisma.studentProfile.create({ data: { seatNumber: 'UNIQ-1', fullName: 'Dup' } }),
    ).rejects.toThrow();
    expect(
      await sqlError(`INSERT INTO student_profiles (id, seat_number, full_name, updated_at)
                      VALUES (gen_random_uuid(), 'lower case', 'X', now())`),
    ).toContain('student_profiles_seat_number_format');
  });

  it('allows at most one student profile per account', async () => {
    const student = await createUser(app, 'STUDENT');
    await expect(
      prisma.studentProfile.create({
        data: { seatNumber: 'SECOND-1', fullName: 'Second', userId: student.id },
      }),
    ).rejects.toThrow();
  });

  it('only attaches student profiles to STUDENT accounts and faculty profiles to staff', async () => {
    const faculty = await createUser(app, 'FACULTY');
    const student = await createUser(app, 'STUDENT');
    await expect(
      prisma.studentProfile.create({
        data: { seatNumber: 'WRONG-1', fullName: 'X', userId: faculty.id },
      }),
    ).rejects.toThrow(/cannot belong to a FACULTY account/);
    await expect(
      prisma.facultyProfile.create({ data: { fullName: 'X', userId: student.id } }),
    ).rejects.toThrow(/cannot belong to a STUDENT account/);
  });

  it('rejects permission grants for students, Super Admins, and Super-Admin-only permissions', async () => {
    const student = await createUser(app, 'STUDENT');
    const admin = await createUser(app, 'SUPER_ADMIN');
    const faculty = await createUser(app, 'FACULTY');
    const grant = (userId: string, permissionKey: string) =>
      prisma.userPermissionGrant.create({
        data: { userId, permissionKey, effect: 'ALLOW', reason: 'test' },
      });

    await expect(grant(student.id, 'attendance.read')).rejects.toThrow(/not allowed for STUDENT/);
    await expect(grant(admin.id, 'attendance.read')).rejects.toThrow(/not allowed for SUPER_ADMIN/);
    await expect(grant(faculty.id, 'users.manage')).rejects.toThrow(/cannot be granted/);
    await expect(grant(faculty.id, 'no.such.permission')).rejects.toThrow();
    await expect(grant(faculty.id, 'audit.read')).resolves.toBeDefined();
  });

  it('rejects role changes across the student/staff line and with leftover grants', async () => {
    const student = await createUser(app, 'STUDENT');
    const faculty = await createUser(app, 'FACULTY');
    await expect(
      prisma.user.update({ where: { id: student.id }, data: { role: 'FACULTY' } }),
    ).rejects.toThrow(/between STUDENT and staff/);
    await prisma.userPermissionGrant.create({
      data: { userId: faculty.id, permissionKey: 'audit.read', effect: 'ALLOW', reason: 'test' },
    });
    await expect(
      prisma.user.update({ where: { id: faculty.id }, data: { role: 'SUPER_ADMIN' } }),
    ).rejects.toThrow(/remove permission grants/);
    await expect(
      prisma.user.update({ where: { id: faculty.id }, data: { role: 'TRAINING_DIRECTOR' } }),
    ).resolves.toMatchObject({ role: 'TRAINING_DIRECTOR' });
  });

  it('keeps code attempts within their maximum', async () => {
    const faculty = await createUser(app, 'FACULTY');
    await expect(
      prisma.authChallenge.create({
        data: {
          email: faculty.email,
          userId: faculty.id,
          purpose: 'LOGIN',
          codeHash: 'x'.repeat(64),
          expiresAt: new Date(Date.now() + 60_000),
          maxAttempts: 5,
          attempts: 6,
        },
      }),
    ).rejects.toThrow();
  });
});
