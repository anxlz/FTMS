import { randomBytes } from 'node:crypto';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import {
  addToGroup,
  bearer,
  bootTestApp,
  createGroup,
  createProgram,
  createStudentRecord,
  createUser,
  createVisit,
  login,
  recordOf,
  resetDatabase,
  type TestApp,
} from './helpers/test-app';

/** Phase 4 rules enforced by the database itself (§8, §16.1), violated directly. */
describe('Attendance and biometric database rules (real Postgres)', () => {
  let app: TestApp;
  let prisma: PrismaService;
  let visitId: string;
  let groupId: string;
  let studentId: string;
  let userId: string;

  beforeAll(async () => {
    ({ app } = await bootTestApp());
    prisma = app.get(PrismaService);
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(async () => {
    await resetDatabase(app);
    const programId = (await createProgram(app)).id;
    groupId = (await createGroup(app)).id;
    visitId = (await createVisit(app, programId, [groupId])).id;
    const user = await createUser(app, 'STUDENT');
    userId = user.id;
    studentId = await recordOf(app, user.id);
    await addToGroup(app, studentId, groupId);
  });

  const present = (extra: Record<string, unknown> = {}) => ({
    visitId,
    studentId,
    groupId,
    status: 'PRESENT' as const,
    source: 'QR' as const,
    checkedInAt: new Date(),
    ...extra,
  });

  const rejects = (promise: Promise<unknown>, pattern: RegExp) =>
    expect(promise).rejects.toThrow(pattern);

  it('keeps one record per student per visit', async () => {
    await prisma.attendanceRecord.create({ data: present() });
    await rejects(
      prisma.attendanceRecord.create({ data: present({ status: 'LATE', minutesLate: 3 }) }),
      /Unique constraint|attendance_records_visit_id_student_id_key/,
    );
  });

  it('ties lateness to the LATE status, within the longest possible window', async () => {
    await rejects(
      prisma.attendanceRecord.create({ data: present({ status: 'LATE', minutesLate: 0 }) }),
      /attendance_records_lateness/,
    );
    await rejects(
      prisma.attendanceRecord.create({ data: present({ minutesLate: 5 }) }),
      /attendance_records_lateness/,
    );
    await rejects(
      prisma.attendanceRecord.create({ data: present({ status: 'LATE', minutesLate: 721 }) }),
      /attendance_records_lateness/,
    );
  });

  it('keeps sources consistent: scans have a time, automatic records are timeless absences', async () => {
    await rejects(
      prisma.attendanceRecord.create({ data: present({ checkedInAt: null }) }),
      /attendance_records_source/,
    );
    await rejects(
      prisma.attendanceRecord.create({
        data: present({ source: 'AUTOMATIC', checkedInAt: null }),
      }),
      /attendance_records_source/,
    );
    await rejects(
      prisma.attendanceRecord.create({
        data: present({ source: 'MANUAL', checkedInAt: null }),
      }),
      /attendance_records_source/,
    );
    await rejects(
      prisma.attendanceRecord.create({
        data: present({
          status: 'ABSENT',
          source: 'AUTOMATIC',
          checkedInAt: null,
          biometricVerified: true,
        }),
      }),
      /attendance_records_source/,
    );
    await rejects(
      prisma.attendanceRecord.create({
        data: present({ correctionReason: 'No correction was made' }),
      }),
      /attendance_records_correction/,
    );
  });

  it('accepts only complete, valid coordinates', async () => {
    await rejects(
      prisma.attendanceRecord.create({ data: present({ latitude: 30 }) }),
      /attendance_records_location/,
    );
    await rejects(
      prisma.attendanceRecord.create({ data: present({ latitude: 95, longitude: 31 }) }),
      /attendance_records_location/,
    );
    await rejects(
      prisma.attendanceRecord.create({ data: present({ accuracyMeters: 10 }) }),
      /attendance_records_location/,
    );
    await prisma.attendanceRecord.create({
      data: present({ latitude: 30.04, longitude: 31.23, accuracyMeters: 8, distanceMeters: 40 }),
    });
  });

  it('registers attendance only for scheduled visits and their groups', async () => {
    const otherGroup = (await createGroup(app)).id;
    await rejects(
      prisma.attendanceRecord.create({ data: present({ groupId: otherGroup }) }),
      /is not assigned to visit/,
    );
    await prisma.trainingVisit.update({
      where: { id: visitId },
      data: { status: 'CANCELLED', cancelReason: 'Rain', cancelledAt: new Date() },
    });
    await rejects(prisma.attendanceRecord.create({ data: present() }), /is cancelled/);
  });

  it('never moves a record to another visit, student or group', async () => {
    const record = await prisma.attendanceRecord.create({ data: present() });
    const other = await createUser(app, 'STUDENT');
    const otherRecord = await recordOf(app, other.id);
    await rejects(
      prisma.attendanceRecord.update({
        where: { id: record.id },
        data: { studentId: otherRecord },
      }),
      /cannot be moved/,
    );
    const otherGroup = (await createGroup(app)).id;
    await prisma.visitGroup.create({ data: { visitId, groupId: otherGroup } });
    await rejects(
      prisma.attendanceRecord.update({ where: { id: record.id }, data: { groupId: otherGroup } }),
      /cannot be moved/,
    );
    // A correction changes the status, not the identity.
    await prisma.attendanceRecord.update({
      where: { id: record.id },
      data: {
        status: 'LATE',
        minutesLate: 4,
        source: 'MANUAL',
        correctedAt: new Date(),
        correctionReason: 'Checked the sheet',
      },
    });
  });

  it('keeps attendance when someone tries to delete the visit or the student record', async () => {
    await prisma.attendanceRecord.create({ data: present() });
    await rejects(
      prisma.trainingVisit.delete({ where: { id: visitId } }),
      /Foreign key|foreign key|violates|constraint/i,
    );
    await rejects(
      prisma.studentProfile.delete({ where: { id: studentId } }),
      /Foreign key|foreign key|violates|constraint/i,
    );

    // Through the API, deleting an (unlinked) record with attendance is refused clearly.
    const unlinked = await createStudentRecord(app);
    await addToGroup(app, unlinked.id, groupId);
    await prisma.attendanceRecord.create({
      data: {
        visitId,
        studentId: unlinked.id,
        groupId,
        status: 'ABSENT',
        source: 'MANUAL',
        correctedAt: new Date(),
      },
    });
    const admin = await createUser(app, 'SUPER_ADMIN');
    const token = (await login(app, admin.email, admin.password!)).accessToken;
    const res = await request(app.getHttpServer())
      .delete(`/students/${unlinked.id}`)
      .set(bearer(token))
      .send({ reason: 'Duplicate record' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('STUDENT_HAS_ATTENDANCE');
  });

  it('binds a credential to its owner and key for good; revocation is final', async () => {
    const credential = await prisma.webAuthnCredential.create({
      data: {
        userId,
        credentialId: randomBytes(16).toString('base64url'),
        publicKey: randomBytes(77),
        name: 'Phone',
        multiDevice: false,
        backedUp: false,
      },
    });
    const admin = await createUser(app, 'SUPER_ADMIN');
    await rejects(
      prisma.webAuthnCredential.update({
        where: { id: credential.id },
        data: { userId: admin.id },
      }),
      /belongs to the account/,
    );
    await rejects(
      prisma.webAuthnCredential.update({
        where: { id: credential.id },
        data: { publicKey: randomBytes(77) },
      }),
      /belongs to the account/,
    );
    await rejects(
      prisma.webAuthnCredential.update({
        where: { id: credential.id },
        data: { revokeReason: 'Not revoked yet' },
      }),
      /webauthn_credentials_values/,
    );
    await rejects(
      prisma.webAuthnCredential.create({
        data: {
          userId,
          credentialId: 'not base64url!',
          publicKey: randomBytes(77),
          name: 'X',
          multiDevice: false,
          backedUp: false,
        },
      }),
      /webauthn_credentials_values/,
    );
    await prisma.webAuthnCredential.update({
      where: { id: credential.id },
      data: { revokedAt: new Date(), revokeReason: 'Lost' },
    });
    await rejects(
      prisma.webAuthnCredential.update({
        where: { id: credential.id },
        data: { revokedAt: null },
      }),
      /has been revoked/,
    );
  });

  it('ties registration and check-in challenges to an account, and check-in ones to a visit', async () => {
    const expiresAt = new Date(Date.now() + 300_000);
    await rejects(
      prisma.webAuthnChallenge.create({
        data: { purpose: 'CHECK_IN', challenge: 'c1', userId, expiresAt },
      }),
      /webauthn_challenges_binding/,
    );
    await rejects(
      prisma.webAuthnChallenge.create({
        data: { purpose: 'REGISTRATION', challenge: 'c2', expiresAt },
      }),
      /webauthn_challenges_binding/,
    );
    await rejects(
      prisma.webAuthnChallenge.create({
        data: { purpose: 'AUTHENTICATION', challenge: 'c3', visitId, expiresAt },
      }),
      /webauthn_challenges_binding/,
    );
    await rejects(
      prisma.webAuthnChallenge.create({
        data: { purpose: 'AUTHENTICATION', challenge: 'c4', expiresAt: new Date(0) },
      }),
      /webauthn_challenges_binding/,
    );
    await prisma.webAuthnChallenge.create({
      data: { purpose: 'CHECK_IN', challenge: 'c5', userId, visitId, expiresAt },
    });
  });

  it('exposes none of the new tables to the Supabase Data API roles', async () => {
    const rows = await prisma.$queryRaw<{ relname: string; relrowsecurity: boolean }[]>`
      SELECT relname, relrowsecurity FROM pg_class
      WHERE relname IN ('attendance_records', 'webauthn_credentials', 'webauthn_challenges')
      ORDER BY relname`;
    expect(rows).toEqual([
      { relname: 'attendance_records', relrowsecurity: true },
      { relname: 'webauthn_challenges', relrowsecurity: true },
      { relname: 'webauthn_credentials', relrowsecurity: true },
    ]);
  });
});
