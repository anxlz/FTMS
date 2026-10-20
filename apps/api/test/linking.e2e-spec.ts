import {
  AuthResponseSchema,
  OwnStudentProfileSchema,
  OwnVerificationSchema,
  SignupResponseSchema,
  VerificationReviewDetailSchema,
} from '@ftms/core';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import {
  bearer,
  bootTestApp,
  createGroup,
  createStudentRecord,
  createUser,
  login,
  type Mailbox,
  resetDatabase,
  type TestApp,
} from './helpers/test-app';

const PASSWORD = 'olive grove morning 41';
const NAME = { firstName: 'محمد', fatherName: 'أحمد', grandfatherName: 'علي', familyName: 'حسن' };

describe('Account linking: first login and signup (§4.2, §4.3, §20.1)', () => {
  let app: TestApp;
  let mailbox: Mailbox;
  let prisma: PrismaService;
  let reviewer: { id: string; token: string };
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    ({ app, mailbox } = await bootTestApp());
    prisma = app.get(PrismaService);
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(async () => {
    await resetDatabase(app);
    mailbox.clear();
    const f = await createUser(app, 'FACULTY');
    reviewer = { id: f.id, token: (await login(app, f.email, f.password!)).accessToken };
  });

  async function setPassword(token: string): Promise<void> {
    await http()
      .post('/auth/password/change')
      .set(bearer(token))
      .send({ newPassword: PASSWORD })
      .expect(204);
  }

  async function signup(email: string, seatNumber: string, name = NAME) {
    await http()
      .post('/auth/signup/request')
      .send({ email, seatNumber, ...name })
      .expect(202);
    const code = await mailbox.latestCode(email.trim().toLowerCase());
    expect(code).not.toBeNull();
    const res = await http()
      .post('/auth/signup/verify')
      .send({ email, seatNumber, ...name, code })
      .expect(200);
    return SignupResponseSchema.parse(res.body);
  }

  /* ───────────────────── §4.3 first login of an imported student ───────────────────── */

  it('first login by email code links the imported record — no duplicate, no re-entry (DoD)', async () => {
    const record = await createStudentRecord(app, {
      seatNumber: '2024-0001',
      parts: ['سارة', 'محمود', 'سالم', 'سعيد'],
      universityEmail: 'sara@agr.asu.edu.eg',
    });
    await http().post('/auth/code/request').send({ email: 'Sara@AGR.asu.edu.eg' }).expect(202);
    const code = await mailbox.latestCode('sara@agr.asu.edu.eg');
    expect(code).toMatch(/^\d{6}$/);

    const res = await http()
      .post('/auth/code/verify')
      .send({ email: 'sara@agr.asu.edu.eg', code })
      .expect(200);
    const session = AuthResponseSchema.parse(res.body);
    expect(session.user).toMatchObject({
      email: 'sara@agr.asu.edu.eg',
      role: 'STUDENT',
      status: 'ACTIVE',
      displayName: 'سارة محمود سالم سعيد',
      passwordSetupRequired: true,
      hasPassword: false,
      studentProfile: { seatNumber: '2024-0001', fullName: 'سارة محمود سالم سعيد' },
    });

    // Exactly one record, now linked; the student creates a password and then
    // signs in with the email or the seat number.
    expect(await prisma.studentProfile.count()).toBe(1);
    const linked = await prisma.studentProfile.findUniqueOrThrow({ where: { id: record.id } });
    expect(linked.userId).toBe(session.user.id);
    await http().get('/me/student').set(bearer(session.accessToken)).expect(403); // password first
    await setPassword(session.accessToken);
    const bySeat = await login(app, '2024-0001', PASSWORD);
    const own = OwnStudentProfileSchema.parse(
      (await http().get('/me/student').set(bearer(bySeat.accessToken)).expect(200)).body,
    );
    expect(own).toMatchObject({ seatNumber: '2024-0001', firstName: 'سارة', familyName: 'سعيد' });

    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { action: 'student.account_linked' },
    });
    expect(audit).toMatchObject({
      resourceId: record.id,
      metadata: { method: 'first_login_email_code' },
    });
  });

  it('answers code requests the same way for unknown emails, and sends nothing', async () => {
    await createStudentRecord(app, { universityEmail: 'known@agr.asu.edu.eg' });
    const unknown = await http()
      .post('/auth/code/request')
      .send({ email: 'nobody@agr.asu.edu.eg' })
      .expect(202);
    const known = await http()
      .post('/auth/code/request')
      .send({ email: 'known@agr.asu.edu.eg' })
      .expect(202);
    expect(unknown.body).toEqual(known.body);
    expect(await mailbox.latestCode('nobody@agr.asu.edu.eg')).toBeNull();
    expect(await mailbox.latestCode('known@agr.asu.edu.eg')).not.toBeNull();
  });

  it('a student without a password cannot sign in with the seat number', async () => {
    await createStudentRecord(app, {
      seatNumber: 'NOPASS-1',
      universityEmail: 'np@agr.asu.edu.eg',
    });
    const res = await http()
      .post('/auth/login')
      .send({ identifier: 'NOPASS-1', password: 'anything at all here' })
      .expect(401);
    expect(res.body.code).toBe('AUTH_INVALID_CREDENTIALS');
  });

  /* ─────────────────────────── §4.2 Case A ─────────────────────────── */

  it('signup matching an imported record without email links it (names may differ in spelling)', async () => {
    const record = await createStudentRecord(app, {
      seatNumber: '2024-0100',
      fullName: 'محمد احمد على حسن', // as faculty typed it
    });
    const result = await signup('Mohamed.Hassan@AGR.asu.edu.eg', '٢٠٢٤-٠١٠٠');
    expect(result.linked).toBe(true);
    expect(result.user).toMatchObject({
      status: 'ACTIVE',
      email: 'mohamed.hassan@agr.asu.edu.eg',
      displayName: 'محمد احمد على حسن', // the authoritative record wins
      studentProfile: { seatNumber: '2024-0100' },
    });
    const linked = await prisma.studentProfile.findUniqueOrThrow({ where: { id: record.id } });
    expect(linked).toMatchObject({
      userId: result.user.id,
      universityEmail: 'mohamed.hassan@agr.asu.edu.eg',
    });
    expect(await prisma.studentProfile.count()).toBe(1);
    expect(await prisma.studentVerificationRequest.count()).toBe(0);
  });

  it('signup matching a record that already carries this email links it', async () => {
    await createStudentRecord(app, {
      seatNumber: 'E-100',
      fullName: 'Different Spelling',
      universityEmail: 'e100@agr.asu.edu.eg',
    });
    const result = await signup('e100@agr.asu.edu.eg', 'E-100');
    expect(result.linked).toBe(true);
  });

  it('never creates a second account for an email in another capitalization', async () => {
    await createUser(app, 'STUDENT', { email: 'existing@agr.asu.edu.eg' });
    await http()
      .post('/auth/signup/request')
      .send({ email: 'EXISTING@agr.asu.edu.eg', seatNumber: 'X-1', ...NAME })
      .expect(202);
    expect(await mailbox.latestCode('existing@agr.asu.edu.eg')).toBeNull(); // waits for mail
    const message = mailbox.messages.find((m) => m.to === 'existing@agr.asu.edu.eg');
    expect(message?.subject).toContain('You already have an account');
    expect(await prisma.user.count({ where: { email: 'existing@agr.asu.edu.eg' } })).toBe(1);
  });

  it('only university addresses can sign up', async () => {
    const res = await http()
      .post('/auth/signup/request')
      .send({ email: 'student@gmail.com', seatNumber: 'G-1', ...NAME })
      .expect(400);
    expect(res.body).toMatchObject({
      code: 'EMAIL_NOT_UNIVERSITY',
      details: { email: ['EMAIL_NOT_UNIVERSITY'] },
    });
  });

  it('a wrong or reused signup code creates nothing', async () => {
    await http()
      .post('/auth/signup/request')
      .send({ email: 'w@agr.asu.edu.eg', seatNumber: 'W-1', ...NAME })
      .expect(202);
    const bad = await http()
      .post('/auth/signup/verify')
      .send({ email: 'w@agr.asu.edu.eg', seatNumber: 'W-1', ...NAME, code: '000000' })
      .expect(400);
    expect(bad.body.code).toBe('AUTH_CODE_INVALID');
    expect(await prisma.user.count({ where: { email: 'w@agr.asu.edu.eg' } })).toBe(0);
  });

  /* ─────────────────────────── §4.2 Case B ─────────────────────────── */

  it('signup without a matching record waits for review, with no access to academic data', async () => {
    const result = await signup('new.student@agr.asu.edu.eg', 'NEW-500');
    expect(result.linked).toBe(false);
    expect(result.user).toMatchObject({
      status: 'PENDING_VERIFICATION',
      studentProfile: null,
      passwordSetupRequired: true,
    });
    await setPassword(result.accessToken);
    const token = (await login(app, 'new.student@agr.asu.edu.eg', PASSWORD)).accessToken;

    const blocked = await http().get('/me/student').set(bearer(token)).expect(403);
    expect(blocked.body.code).toBe('AUTH_ACCOUNT_PENDING');
    await http().get('/me/profile-changes').set(bearer(token)).expect(403);
    // A seat-number login is impossible: no record carries the seat yet.
    await http()
      .post('/auth/login')
      .send({ identifier: 'NEW-500', password: PASSWORD })
      .expect(401);

    const mine = OwnVerificationSchema.parse(
      (await http().get('/me/verification').set(bearer(token)).expect(200)).body,
    );
    expect(mine).toMatchObject({
      state: 'PENDING',
      request: { status: 'PENDING', submitted: { seatNumber: 'NEW-500' } },
    });

    // The reviewer creates the record from the submitted details, into a group.
    const group = await createGroup(app, 'G');
    const queue = (
      await http()
        .get('/student-verifications?status=PENDING')
        .set(bearer(reviewer.token))
        .expect(200)
    ).body;
    expect(queue.items).toHaveLength(1);
    expect(queue.items[0]).toMatchObject({
      issue: 'NO_RECORD',
      account: { email: 'new.student@agr.asu.edu.eg' },
    });
    await http()
      .post(`/student-verifications/${queue.items[0].id}/approve`)
      .set(bearer(reviewer.token))
      .send({ mode: 'CREATE', groupId: group.id })
      .expect(200);

    const own = OwnStudentProfileSchema.parse(
      (await http().get('/me/student').set(bearer(token)).expect(200)).body,
    );
    expect(own).toMatchObject({
      seatNumber: 'NEW-500',
      fullName: 'محمد أحمد علي حسن',
      group: { id: group.id },
    });
    await login(app, 'NEW-500', PASSWORD);
    const message = mailbox.messages.find((m) => m.subject.includes('verified'));
    expect(message?.to).toBe('new.student@agr.asu.edu.eg');
    expect(message?.text).not.toContain(reviewer.id);
  });

  it('does not trust a seat number whose record has a different email, or is taken', async () => {
    const other = await createStudentRecord(app, {
      seatNumber: 'S-1',
      universityEmail: 'real.owner@agr.asu.edu.eg',
    });
    const impostor = await signup('impostor@agr.asu.edu.eg', 'S-1');
    expect(impostor.linked).toBe(false);
    expect(
      (await prisma.studentProfile.findUniqueOrThrow({ where: { id: other.id } })).userId,
    ).toBeNull();

    const linkedStudent = await createUser(app, 'STUDENT', { seatNumber: 'S-2' });
    const second = await signup('second@agr.asu.edu.eg', 'S-2');
    expect(second.linked).toBe(false);
    const issues = await prisma.studentVerificationRequest.findMany({
      orderBy: { createdAt: 'asc' },
    });
    expect(issues.map((r) => r.issue)).toEqual(['DETAILS_MISMATCH', 'SEAT_ALREADY_LINKED']);
    expect(
      (await prisma.studentProfile.findUniqueOrThrow({ where: { seatNumber: 'S-2' } })).userId,
    ).toBe(linkedStudent.id);
  });

  it('a record without email is not claimed when the name does not match', async () => {
    await createStudentRecord(app, { seatNumber: 'N-1', fullName: 'فاطمة الزهراء محمد علي' });
    const result = await signup('n1@agr.asu.edu.eg', 'N-1');
    expect(result.linked).toBe(false);
    expect((await prisma.studentVerificationRequest.findFirstOrThrow()).issue).toBe(
      'DETAILS_MISMATCH',
    );
  });

  it('two people racing for one record: exactly one is linked, the other waits for review', async () => {
    await createStudentRecord(app, { seatNumber: 'RACE-1', fullName: 'محمد أحمد علي حسن' });
    for (const email of ['racer1@agr.asu.edu.eg', 'racer2@agr.asu.edu.eg']) {
      await http()
        .post('/auth/signup/request')
        .send({ email, seatNumber: 'RACE-1', ...NAME })
        .expect(202);
    }
    const codes = await Promise.all(
      ['racer1@agr.asu.edu.eg', 'racer2@agr.asu.edu.eg'].map((e) => mailbox.latestCode(e)),
    );
    const results = await Promise.all(
      ['racer1@agr.asu.edu.eg', 'racer2@agr.asu.edu.eg'].map((email, i) =>
        http()
          .post('/auth/signup/verify')
          .send({ email, seatNumber: 'RACE-1', ...NAME, code: codes[i] }),
      ),
    );
    expect(results.map((r) => r.status)).toEqual([200, 200]);
    expect(results.map((r) => (r.body as { linked: boolean }).linked).sort()).toEqual([
      false,
      true,
    ]);
    expect(await prisma.studentProfile.count()).toBe(1);
    expect(await prisma.user.count({ where: { role: 'STUDENT', status: 'ACTIVE' } })).toBe(1);
  });

  it('a pending student fixing a typo is linked automatically on resubmission', async () => {
    const record = await createStudentRecord(app, {
      seatNumber: 'T-200',
      fullName: 'محمد أحمد علي حسن',
    });
    const result = await signup('typo@agr.asu.edu.eg', 'T-2OO'); // letter O instead of zero
    expect(result.linked).toBe(false);
    await setPassword(result.accessToken);
    const token = (await login(app, 'typo@agr.asu.edu.eg', PASSWORD)).accessToken;

    // One open request at a time.
    const again = await http()
      .post('/me/verification')
      .set(bearer(token))
      .send({ seatNumber: 'T-200', ...NAME })
      .expect(409);
    expect(again.body.code).toBe('VERIFICATION_PENDING');
    const request = await prisma.studentVerificationRequest.findFirstOrThrow();
    await http()
      .post(`/student-verifications/${request.id}/reject`)
      .set(bearer(reviewer.token))
      .send({ reason: 'No student with seat number T-2OO; check your seat card.' })
      .expect(200);

    const mine = OwnVerificationSchema.parse(
      (await http().get('/me/verification').set(bearer(token))).body,
    );
    expect(mine).toMatchObject({
      state: 'REJECTED',
      request: { decisionReason: 'No student with seat number T-2OO; check your seat card.' },
    });
    expect(JSON.stringify(mine)).not.toContain(reviewer.id);

    const fixed = await http()
      .post('/me/verification')
      .set(bearer(token))
      .send({ seatNumber: 'T-200', ...NAME })
      .expect(200);
    expect(fixed.body).toEqual({ linked: true });
    expect(
      (await prisma.studentProfile.findUniqueOrThrow({ where: { id: record.id } })).userId,
    ).toBe(result.user.id);
    await http().get('/me/student').set(bearer(token)).expect(200);
  });

  it('reviewers see candidates and can link to an existing record, replacing its email', async () => {
    const record = await createStudentRecord(app, {
      seatNumber: 'L-1',
      fullName: 'محمد أحمد علي حسن',
      universityEmail: 'old.address@agr.asu.edu.eg',
    });
    const result = await signup('new.address@agr.asu.edu.eg', 'L-1');
    expect(result.linked).toBe(false);
    const request = await prisma.studentVerificationRequest.findFirstOrThrow();
    const detail = VerificationReviewDetailSchema.parse(
      (
        await http()
          .get(`/student-verifications/${request.id}`)
          .set(bearer(reviewer.token))
          .expect(200)
      ).body,
    );
    expect(detail.candidates).toHaveLength(1);
    expect(detail.candidates[0]).toMatchObject({ id: record.id, reasons: ['SEAT_NUMBER', 'NAME'] });

    const approved = await http()
      .post(`/student-verifications/${request.id}/approve`)
      .set(bearer(reviewer.token))
      .send({ mode: 'LINK', studentId: record.id, comment: 'Confirmed with registrar' })
      .expect(200);
    expect(approved.body).toMatchObject({
      status: 'APPROVED',
      linkedStudentId: record.id,
      decidedBy: { name: expect.any(String) },
    });
    expect(
      await prisma.studentProfile.findUniqueOrThrow({ where: { id: record.id } }),
    ).toMatchObject({
      userId: result.user.id,
      universityEmail: 'new.address@agr.asu.edu.eg',
    });
    const twice = await http()
      .post(`/student-verifications/${request.id}/reject`)
      .set(bearer(reviewer.token))
      .send({ reason: 'too late' })
      .expect(409);
    expect(twice.body.code).toBe('REQUEST_ALREADY_DECIDED');
    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { action: 'student.verification.approved' },
    });
    expect(audit).toMatchObject({ actorId: reviewer.id, reason: 'Confirmed with registrar' });
    // The decision also reaches the student's notification center (§12).
    expect(
      await prisma.notification.findMany({
        where: { recipientId: request.userId },
        select: { type: true, link: true },
      }),
    ).toEqual([{ type: 'verification.approved', link: '/dashboard' }]);
  });

  it('an admin cannot activate an unverified account; reactivation returns it to review', async () => {
    const result = await signup('pending.admin@agr.asu.edu.eg', 'PA-1');
    const sa = await createUser(app, 'SUPER_ADMIN');
    const token = (await login(app, sa.email, sa.password!)).accessToken;
    const activate = await http()
      .patch(`/admin/users/${result.user.id}/status`)
      .set(bearer(token))
      .send({ status: 'ACTIVE', reason: 'trying a shortcut' })
      .expect(409);
    expect(activate.body.code).toBe('AUTH_ACCOUNT_PENDING');
    await http()
      .patch(`/admin/users/${result.user.id}/status`)
      .set(bearer(token))
      .send({ status: 'SUSPENDED', reason: 'duplicate account' })
      .expect(200);
    const back = await http()
      .patch(`/admin/users/${result.user.id}/status`)
      .set(bearer(token))
      .send({ status: 'ACTIVE', reason: 'mistake' })
      .expect(200);
    expect(back.body.status).toBe('PENDING_VERIFICATION');
  });

  it('rejection needs a reason', async () => {
    await signup('reason@agr.asu.edu.eg', 'RS-1');
    const request = await prisma.studentVerificationRequest.findFirstOrThrow();
    const res = await http()
      .post(`/student-verifications/${request.id}/reject`)
      .set(bearer(reviewer.token))
      .send({})
      .expect(400);
    expect(res.body.code).toBe('VALIDATION_FAILED');
  });
});
