import {
  type AuditAction,
  AuditEntryDetailSchema,
  AuditFacetsResponseSchema,
  FacultyActivityResponseSchema,
  ListAuditLogsResponseSchema,
  WebAuthnOptionsResponseSchema,
} from '@ftms/core';
import request from 'supertest';
import { WebAuthnSettings } from '../src/auth/biometrics/webauthn';
import { BackgroundTasks } from '../src/common/background-tasks.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { SoftAuthenticator } from './helpers/authenticator';
import {
  addToGroup,
  bearer,
  bootTestApp,
  buildWorkbook,
  cairoDate,
  createProgram,
  createUser,
  createVisit,
  login,
  type Mailbox,
  recordOf,
  resetDatabase,
  type SeededUser,
  type TestApp,
  TEMPLATE_HEADERS,
} from './helpers/test-app';

const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/**
 * §20.5 against the real application and database: faculty operations are
 * recorded with who, what, when and before/after; attendance corrections keep
 * the previous status and lateness; swap decisions name every responsible
 * party; the Training Director filters and inspects; students and ordinary
 * faculty are refused; nothing can erase the log; no secret is ever in it.
 */
describe('Training Director audit log (§15, §20.5)', () => {
  let app: TestApp;
  let mailbox: Mailbox;
  let prisma: PrismaService;
  const http = () => request(app.getHttpServer());

  let superAdmin: SeededUser;
  let director: SeededUser;
  let faculty: SeededUser;
  let otherFaculty: SeededUser;
  let s1: SeededUser;
  let s2: SeededUser;
  const tokens: Record<string, string> = {};
  const secrets: string[] = [];
  const ids: Record<string, string> = {};

  const facultyName = async (id: string) =>
    (await prisma.user.findUniqueOrThrow({ where: { id } })).displayName;

  /** The log as the Training Director sees it. */
  async function log(query: string, token = tokens.director!) {
    const res = await http()
      .get(`/audit-logs?pageSize=100&${query}`)
      .set(bearer(token))
      .expect(200);
    return ListAuditLogsResponseSchema.parse(res.body);
  }
  const actionsOf = async (query: string) => (await log(query)).items.map((e) => e.action);

  /** The whole audit table as text. */
  const auditText = async () =>
    JSON.stringify(await prisma.auditLog.findMany(), (_k, v: unknown) =>
      typeof v === 'bigint' ? String(v) : v,
    );

  async function signIn(user: SeededUser): Promise<string> {
    const auth = await login(app, user.email, user.password!);
    secrets.push(auth.accessToken, auth.refreshToken);
    return auth.accessToken;
  }

  beforeAll(async () => {
    ({ app, mailbox } = await bootTestApp());
    prisma = app.get(PrismaService);
    await resetDatabase(app);

    superAdmin = await createUser(app, 'SUPER_ADMIN');
    director = await createUser(app, 'TRAINING_DIRECTOR');
    faculty = await createUser(app, 'FACULTY');
    otherFaculty = await createUser(app, 'FACULTY');
    s1 = await createUser(app, 'STUDENT');
    s2 = await createUser(app, 'STUDENT');
    for (const u of [superAdmin, director, faculty, otherFaculty, s1, s2])
      secrets.push(u.password!);
    tokens.superAdmin = await signIn(superAdmin);
    tokens.director = await signIn(director);
    tokens.faculty = await signIn(faculty);
    tokens.otherFaculty = await signIn(otherFaculty);
    tokens.s1 = await signIn(s1);
    tokens.s2 = await signIn(s2);
    const t = tokens.faculty;

    // ── Faculty operations (§15.1) ──
    const A = (await http().post('/groups').set(bearer(t)).send({ name: 'Audit A' }).expect(201))
      .body as { id: string };
    const B = (await http().post('/groups').set(bearer(t)).send({ name: 'Audit B' }).expect(201))
      .body as { id: string };
    ids.groupA = A.id;
    ids.groupB = B.id;
    await http().patch(`/groups/${A.id}`).set(bearer(t)).send({ name: 'Audit A1' }).expect(200);

    const record = (
      await http()
        .post('/students')
        .set(bearer(t))
        .send({ seatNumber: 'AUD-1', name: { firstName: 'سارة', familyName: 'محمود' } })
        .expect(201)
    ).body as { id: string };
    ids.record = record.id;
    await http()
      .patch(`/students/${record.id}`)
      .set(bearer(t))
      .send({ phone: '01012345678' })
      .expect(200);
    await http()
      .post(`/groups/${A.id}/members`)
      .set(bearer(t))
      .send({ studentIds: [record.id] })
      .expect(200);
    await http().delete(`/groups/${A.id}/members/${record.id}`).set(bearer(t)).send({}).expect(204);
    await http()
      .delete(`/students/${record.id}`)
      .set(bearer(t))
      .send({ reason: 'Duplicate record' })
      .expect(204);

    const file = await buildWorkbook(TEMPLATE_HEADERS, [
      ['AUD-IMP-1', 'منى', 'أحمد', 'علي', 'حسن', '', '', ''],
    ]);
    const preview = (
      await http()
        .post('/student-imports')
        .set(bearer(t))
        .attach('file', file, { filename: 'audit.xlsx', contentType: XLSX })
        .expect(201)
    ).body as { id: string; planDigest: string };
    ids.import = preview.id;
    await http()
      .post(`/student-imports/${preview.id}/commit`)
      .set(bearer(t))
      .send({ planDigest: preview.planDigest, applyUpdates: false, skipInvalidRows: false })
      .expect(200);

    const program = await createProgram(app);
    await http()
      .patch('/program')
      .set(bearer(tokens.director))
      .send({ allowedAbsences: 3, reason: 'Board decision' })
      .expect(200);
    const visit = (
      await http()
        .post('/visits')
        .set(bearer(t))
        .send({ title: 'Audit visit', date: cairoDate(7), startTime: '10:00', groupIds: [A.id] })
        .expect(201)
    ).body as { visit: { id: string } };
    ids.visit = visit.visit.id;
    await http()
      .patch(`/visits/${ids.visit}`)
      .set(bearer(t))
      .send({ title: 'Audit visit 2' })
      .expect(200);
    await http()
      .post(`/visits/${ids.visit}/cancel`)
      .set(bearer(t))
      .send({ reason: 'Heavy rain' })
      .expect(200);
    await http().post(`/visits/${ids.visit}/restore`).set(bearer(t)).send({}).expect(200);

    // Attendance: corrected twice on yesterday's visit.
    const r1 = await recordOf(app, s1.id);
    const r2 = await recordOf(app, s2.id);
    ids.r1 = r1;
    await addToGroup(app, r1, A.id);
    await addToGroup(app, r2, B.id);
    const past = await createVisit(app, program.id, [A.id], { date: cairoDate(-1), title: 'Past' });
    ids.pastVisit = past.id;
    await http()
      .put(`/visits/${past.id}/attendance/${r1}`)
      .set(bearer(t))
      .send({ status: 'LATE', minutesLate: 7, reason: 'Bus delay' })
      .expect(200);
    await http()
      .put(`/visits/${past.id}/attendance/${r1}`)
      .set(bearer(t))
      .send({ status: 'PRESENT', reason: 'Arrived on time after all' })
      .expect(200);
    await http().get('/attendance/export?format=csv').set(bearer(t)).expect(200);

    // A ticket processed by the faculty member.
    const ticket = (
      await http()
        .post('/tickets')
        .set(bearer(tokens.s1))
        .field('category', 'COMPLAINT')
        .field('subject', 'Audit ticket')
        .field('description', 'Something to process')
        .expect(201)
    ).body as { id: string };
    ids.ticket = ticket.id;
    await http()
      .post(`/tickets/${ticket.id}/messages`)
      .set(bearer(t))
      .field('body', 'On it')
      .expect(201);
    await http()
      .post(`/tickets/${ticket.id}/status`)
      .set(bearer(t))
      .send({ status: 'RESOLVED', note: 'Fixed' })
      .expect(200);

    // A group swap: requested by s1, accepted by s2, approved by the faculty member.
    const swap = (
      await http()
        .post('/group-swaps')
        .set(bearer(tokens.s1))
        .send({ targetGroupId: B.id, counterpartSeatNumber: s2.seatNumber })
        .expect(201)
    ).body as { id: string };
    ids.swap = swap.id;
    await http().post(`/group-swaps/${swap.id}/accept`).set(bearer(tokens.s2)).send({}).expect(200);
    await http().post(`/group-swaps/${swap.id}/approve`).set(bearer(t)).send({}).expect(200);

    // A failed sign-in by the faculty member.
    await http()
      .post('/auth/login')
      .send({ identifier: faculty.email, password: 'not the password at all' })
      .expect(401);

    // ── Secret-bearing flows (§15.2) ──
    // Password change.
    const changed = 'new staff passphrase 2026';
    secrets.push(changed);
    await http()
      .post('/auth/password/change')
      .set(bearer(tokens.otherFaculty))
      .send({ currentPassword: otherFaculty.password, newPassword: changed })
      .expect(204);
    // First sign-in by emailed code (an account without a password), password setup, refresh.
    const newcomer = await createUser(app, 'STUDENT', { password: null });
    await app.get(BackgroundTasks).drain();
    await http().post('/auth/code/request').send({ email: newcomer.email }).expect(202);
    const loginCode = (await mailbox.latestCode(newcomer.email))!;
    expect(loginCode).toMatch(/^\d{6}$/);
    secrets.push(loginCode);
    const byCode = (
      await http()
        .post('/auth/code/verify')
        .send({ email: newcomer.email, code: loginCode })
        .expect(200)
    ).body as { accessToken: string; refreshToken: string };
    secrets.push(byCode.accessToken, byCode.refreshToken);
    const first = 'first student passphrase 11';
    secrets.push(first);
    await http()
      .post('/auth/password/change')
      .set(bearer(byCode.accessToken))
      .send({ newPassword: first })
      .expect(204);
    const again = await login(app, newcomer.email, first);
    secrets.push(again.accessToken, again.refreshToken);
    const refreshed = (
      await http().post('/auth/refresh').send({ refreshToken: again.refreshToken }).expect(200)
    ).body as { accessToken: string; refreshToken: string };
    secrets.push(refreshed.accessToken, refreshed.refreshToken);
    // Password reset by emailed code.
    await app.get(BackgroundTasks).drain();
    await http().post('/auth/password/forgot').send({ email: director.email }).expect(202);
    const resetCode = (await mailbox.latestCode(director.email))!;
    const reset = 'director reset phrase 77';
    secrets.push(resetCode, reset);
    await http()
      .post('/auth/password/reset')
      .send({ email: director.email, code: resetCode, newPassword: reset })
      .expect(204);
    director.password = reset;
    tokens.director = await signIn(director);
    // Biometric enrollment and sign-in.
    const device = new SoftAuthenticator(app.get(WebAuthnSettings).origin);
    const options = WebAuthnOptionsResponseSchema.parse(
      (await http().post('/auth/biometric/credentials/options').set(bearer(tokens.s1)).expect(200))
        .body,
    );
    secrets.push(options.options.challenge as string);
    await http()
      .post('/auth/biometric/credentials')
      .set(bearer(tokens.s1))
      .send({
        challengeId: options.challengeId,
        name: 'Audit phone',
        response: device.register(options.options),
      })
      .expect(201);
    secrets.push(device.id);
    const loginOptions = WebAuthnOptionsResponseSchema.parse(
      (await http().post('/auth/biometric/login/options').expect(200)).body,
    );
    secrets.push(loginOptions.options.challenge as string);
    const bio = (
      await http()
        .post('/auth/biometric/login')
        .send({
          challengeId: loginOptions.challengeId,
          response: device.assert(loginOptions.options),
        })
        .expect(200)
    ).body as { accessToken: string; refreshToken: string };
    secrets.push(bio.accessToken, bio.refreshToken);

    // ── Access change: the Super Admin authorizes another faculty member (§15.3, §15.4) ──
    await http()
      .put(`/admin/users/${otherFaculty.id}/permissions`)
      .set(bearer(tokens.superAdmin))
      .send({ grants: [{ permission: 'audit.read', effect: 'ALLOW' }], reason: 'Quality review' })
      .expect(200);
    tokens.otherFaculty = await signIn({ ...otherFaculty, password: changed });
    await app.get(BackgroundTasks).drain();
  });

  afterAll(async () => {
    await app.close();
  });

  it('records every faculty operation with who did it, as they were then, and what it touched', async () => {
    const entries = (await log(`actor=${faculty.id}`)).items;
    const name = await facultyName(faculty.id);
    for (const e of entries) expect(e.actor).toEqual({ id: faculty.id, name, role: 'FACULTY' });
    const did = new Set(entries.map((e) => e.action));
    const expected: AuditAction[] = [
      'group.created',
      'group.updated',
      'student.created',
      'student.updated',
      'group.member_added',
      'group.member_removed',
      'student.deleted',
      'student_import.previewed',
      'student_import.committed',
      'visit.created',
      'visit.updated',
      'visit.cancelled',
      'visit.restored',
      'attendance.corrected',
      'attendance.exported',
      'ticket.replied',
      'ticket.status_changed',
      'group_swap.approved',
      'group.member_moved',
      'auth.login',
    ];
    for (const action of expected) expect([action, did.has(action)]).toEqual([action, true]);

    const one = (action: AuditAction) => entries.find((e) => e.action === action)!;
    expect(one('group.updated')).toMatchObject({
      resourceType: 'group',
      resourceId: ids.groupA,
      before: { name: 'Audit A' },
      after: { name: 'Audit A1' },
    });
    expect(one('visit.updated')).toMatchObject({
      resourceId: ids.visit,
      before: { title: 'Audit visit' },
      after: { title: 'Audit visit 2' },
    });
    expect(one('visit.cancelled')).toMatchObject({ resourceId: ids.visit, reason: 'Heavy rain' });
    // A deletion keeps what was deleted and by whom.
    expect(one('student.deleted')).toMatchObject({
      resourceId: ids.record,
      reason: 'Duplicate record',
      before: { seatNumber: 'AUD-1' },
    });
    expect(one('student_import.committed').resourceId).toBe(ids.import);
    expect(one('ticket.status_changed')).toMatchObject({
      resourceId: ids.ticket,
      before: { status: 'IN_PROGRESS' },
      after: { status: 'RESOLVED' },
    });
    expect(entries.filter((e) => e.action === 'group.member_moved')).toHaveLength(2);

    // Settings changes by the Training Director keep previous and new values (§11.3).
    const settings = (await log(`actor=${director.id}&category=SETTINGS`)).items;
    expect(settings).toHaveLength(1);
    expect(settings[0]).toMatchObject({
      action: 'program.updated',
      reason: 'Board decision',
      before: { allowedAbsences: 2 },
      after: { allowedAbsences: 3 },
    });
  });

  it('keeps the previous status and lateness of every attendance correction', async () => {
    const corrections = (await log(`action=attendance.corrected`)).items;
    expect(corrections).toHaveLength(2);
    const [second, first] = corrections; // newest first
    expect(first).toMatchObject({ reason: 'Bus delay', after: { status: 'LATE', minutesLate: 7 } });
    expect(second).toMatchObject({
      reason: 'Arrived on time after all',
      before: { status: 'LATE', minutesLate: 7 },
      after: { status: 'PRESENT', minutesLate: 0 },
    });
    const detail = AuditEntryDetailSchema.parse(
      (await http().get(`/audit-logs/${second!.id}`).set(bearer(tokens.director!)).expect(200))
        .body,
    );
    expect(detail.changes.filter((c) => c.changed)).toEqual(
      expect.arrayContaining([
        { field: 'status', before: 'LATE', after: 'PRESENT', changed: true },
        { field: 'minutesLate', before: 7, after: 0, changed: true },
      ]),
    );
    // The affected record is still available, with its visit.
    expect(detail.resource).toMatchObject({
      type: 'attendance',
      exists: true,
      visitId: ids.pastVisit,
    });
    expect(detail.related.map((r) => r.id)).toContain(first!.id);
  });

  it('identifies every party to a group-swap decision', async () => {
    const swap = (await log(`resourceType=group_swap&resourceId=${ids.swap}`)).items;
    const by = (action: AuditAction) => swap.find((e) => e.action === action)?.actor;
    expect(by('group_swap.requested')).toMatchObject({ id: s1.id, role: 'STUDENT' });
    expect(by('group_swap.counterpart_accepted')).toMatchObject({ id: s2.id, role: 'STUDENT' });
    expect(by('group_swap.approved')).toEqual({
      id: faculty.id,
      name: await facultyName(faculty.id),
      role: 'FACULTY',
    });
    // The decision history shows decisions only — of every kind.
    const decisions = new Set(await actionsOf('decisions=true'));
    expect([...decisions].sort()).toEqual(
      [
        'attendance.corrected',
        'group_swap.approved',
        'group_swap.counterpart_accepted',
        'ticket.status_changed',
        'user.permissions_changed',
      ].sort(),
    );
  });

  it('lets the Training Director search, filter and inspect', async () => {
    expect(new Set(await actionsOf('category=VISITS'))).toEqual(
      new Set(['visit.created', 'visit.updated', 'visit.cancelled', 'visit.restored']),
    );
    expect(await actionsOf('action=visit.cancelled')).toEqual(['visit.cancelled']);
    expect(await actionsOf('q=Duplicate')).toEqual(['student.deleted']);
    expect(await actionsOf(`resourceType=visit&resourceId=${ids.visit}`)).toHaveLength(4);
    const failures = (await log('outcome=FAILURE')).items;
    expect(failures.map((e) => [e.action, e.actor?.id])).toEqual([['auth.login', faculty.id]]);
    // Scopes: staff, students, everyone.
    const staff = (await log('scope=staff')).items;
    expect(staff.every((e) => e.actor && e.actor.role !== 'STUDENT')).toBe(true);
    const students = (await log('scope=students')).items;
    expect(students.length).toBeGreaterThan(0);
    expect(students.every((e) => e.actor?.role === 'STUDENT')).toBe(true);
    // Dates are Cairo days.
    expect((await log(`from=${cairoDate(0)}&to=${cairoDate(0)}`)).total).toBeGreaterThan(30);
    expect((await log(`to=${cairoDate(-1)}`)).total).toBe(0);
    const bad = await http()
      .get(`/audit-logs?from=${cairoDate(0)}&to=${cairoDate(-1)}`)
      .set(bearer(tokens.director!));
    expect(bad.status).toBe(400);
    expect(bad.body.details).toEqual({ to: ['END_BEFORE_START'] });
    expect(
      (await http().get('/audit-logs?action=visit.vanished').set(bearer(tokens.director!))).status,
    ).toBe(400);
    // Pagination.
    const page1 = (
      await http().get('/audit-logs?pageSize=5').set(bearer(tokens.director!)).expect(200)
    ).body;
    const page2 = (
      await http().get('/audit-logs?pageSize=5&page=2').set(bearer(tokens.director!)).expect(200)
    ).body;
    expect(page1.items).toHaveLength(5);
    expect(page2.items[0].id).not.toBe(page1.items[0].id);

    // One event in detail: comparison, context and the record as it is now.
    const updated = (await log(`action=visit.updated`)).items[0]!;
    const detail = AuditEntryDetailSchema.parse(
      (await http().get(`/audit-logs/${updated.id}`).set(bearer(tokens.director!)).expect(200))
        .body,
    );
    expect(detail.changes).toContainEqual({
      field: 'title',
      before: 'Audit visit',
      after: 'Audit visit 2',
      changed: true,
    });
    expect(detail.resource).toMatchObject({
      exists: true,
      label: expect.stringContaining('Audit visit 2'),
    });
    expect(detail.related).toHaveLength(3);
    // A deleted record: the history stays, the record is gone.
    const deleted = (await log('action=student.deleted')).items[0]!;
    const gone = AuditEntryDetailSchema.parse(
      (await http().get(`/audit-logs/${deleted.id}`).set(bearer(tokens.director!)).expect(200))
        .body,
    );
    expect(gone.resource).toMatchObject({ type: 'student', exists: false });
    expect(gone.related.map((r) => r.action)).toEqual(
      expect.arrayContaining(['student.created', 'student.updated']),
    );
    await http().get('/audit-logs/999999999').set(bearer(tokens.director!)).expect(404);
    await http().get('/audit-logs/not-a-number').set(bearer(tokens.director!)).expect(400);

    // Filter values.
    const facets = AuditFacetsResponseSchema.parse(
      (await http().get('/audit-logs/facets').set(bearer(tokens.director!)).expect(200)).body,
    );
    expect(facets.actors.map((a) => a.id)).toEqual(
      expect.arrayContaining([superAdmin.id, director.id, faculty.id, otherFaculty.id]),
    );
    expect(facets.actors.some((a) => a.role === 'STUDENT')).toBe(false);
    expect(facets.actions).toContain('group_swap.approved');
    expect(facets.resourceTypes).toContain('visit');
  });

  it('summarizes each staff member’s activity, including those who did nothing', async () => {
    const activity = FacultyActivityResponseSchema.parse(
      (await http().get('/audit-logs/activity').set(bearer(tokens.director!)).expect(200)).body,
    );
    expect(activity.to).toBe(cairoDate(0));
    expect(activity.from).toBe(cairoDate(-29));
    const row = activity.rows.find((r) => r.actor.id === faculty.id)!;
    const own = (await log(`actor=${faculty.id}`)).total;
    expect(row.total).toBe(own);
    expect(row.failures).toBe(1);
    expect(row.decisions).toBe(4); // two corrections, a ticket outcome, a swap approval
    expect(row.categories.VISITS).toBe(4);
    expect(row.categories.GROUPS).toBe(7);
    expect(row.lastActionAt).not.toBeNull();
    expect(activity.rows.map((r) => r.actor.id)).toEqual(
      expect.arrayContaining([superAdmin.id, director.id, otherFaculty.id]),
    );
    expect(activity.rows.some((r) => r.actor.role === 'STUDENT')).toBe(false);
    // An empty period.
    const before = FacultyActivityResponseSchema.parse(
      (
        await http()
          .get(`/audit-logs/activity?from=${cairoDate(-60)}&to=${cairoDate(-31)}`)
          .set(bearer(tokens.director!))
          .expect(200)
      ).body,
    );
    expect(before.totals).toEqual({ actions: 0, failures: 0, decisions: 0, activeStaff: 0 });
  });

  it('refuses students and ordinary faculty; an explicit grant is itself recorded', async () => {
    const routes = [
      '/audit-logs',
      '/audit-logs/facets',
      '/audit-logs/activity',
      '/audit-logs/export?format=csv',
      '/audit-logs/1',
      '/reports/faculty-activity/export?format=csv',
    ];
    for (const route of routes) {
      for (const token of [tokens.s1!, tokens.s2!, tokens.faculty!]) {
        const res = await http().get(route).set(bearer(token));
        expect([route, res.status, res.body.code]).toEqual([route, 403, 'FORBIDDEN']);
      }
      expect((await http().get(route)).status).toBe(401);
    }
    // The faculty member the Super Admin authorized can read the log...
    await http().get('/audit-logs').set(bearer(tokens.otherFaculty!)).expect(200);
    // ...and that authorization is in the log with before and after.
    const grant = (await log('action=user.permissions_changed')).items[0]!;
    expect(grant).toMatchObject({
      actor: { id: superAdmin.id, role: 'SUPER_ADMIN' },
      resourceId: otherFaculty.id,
      reason: 'Quality review',
      before: { grants: [] },
      after: { grants: [{ permission: 'audit.read', effect: 'ALLOW' }] },
    });
  });

  it('cannot be erased or rewritten through the application or the database', async () => {
    const count = await prisma.auditLog.count();
    const first = (await prisma.auditLog.findFirstOrThrow({ orderBy: { id: 'asc' } })).id;
    // No route changes or removes an event.
    for (const method of ['delete', 'patch', 'put', 'post'] as const) {
      const res = await http()[method](`/audit-logs/${first}`).set(bearer(tokens.superAdmin!));
      expect([method, res.status]).toEqual([method, 404]);
    }
    // The database refuses it too.
    await expect(
      prisma.auditLog.update({ where: { id: first }, data: { reason: 'rewritten' } }),
    ).rejects.toThrow(/append-only/);
    await expect(prisma.auditLog.delete({ where: { id: first } })).rejects.toThrow(/append-only/);
    await expect(prisma.auditLog.deleteMany({ where: { actorId: faculty.id } })).rejects.toThrow(
      /append-only/,
    );
    await expect(prisma.$executeRawUnsafe('TRUNCATE audit_logs')).rejects.toThrow(/append-only/);
    expect(await prisma.auditLog.count()).toBe(count);
  });

  it('never contains passwords, codes, tokens, hashes or biometric key material', async () => {
    const text = await auditText();
    const users = await prisma.user.findMany({ select: { passwordHash: true } });
    const credential = await prisma.webAuthnCredential.findFirstOrThrow();
    const challenges = await prisma.authChallenge.findMany({ select: { codeHash: true } });
    const sessions = await prisma.authSession.findMany({ select: { currentRefreshHash: true } });
    const all = [
      ...secrets,
      ...users.map((u) => u.passwordHash).filter((h): h is string => h !== null),
      ...challenges.map((c) => c.codeHash),
      ...sessions.map((s) => s.currentRefreshHash),
      credential.credentialId,
      Buffer.from(credential.publicKey).toString('base64'),
      Buffer.from(credential.publicKey).toString('base64url'),
      Buffer.from(credential.publicKey).toString('hex'),
    ];
    expect(all.length).toBeGreaterThan(25);
    for (const secret of all) expect(text.includes(secret)).toBe(false);
    // The flows that handle them were recorded nonetheless.
    const recorded = new Set(
      (await prisma.auditLog.findMany({ select: { action: true } })).map((r) => r.action),
    );
    for (const action of [
      'auth.password.changed',
      'auth.login_code.requested',
      'auth.password_reset.completed',
      'auth.biometric_enabled',
    ]) {
      expect([action, recorded.has(action)]).toEqual([action, true]);
    }
  });

  it('exports the filtered log and records the export', async () => {
    const res = await http()
      .get(`/audit-logs/export?format=csv&locale=en&actor=${faculty.id}&category=VISITS`)
      .set(bearer(tokens.director!))
      .expect(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.headers['content-disposition']).toMatch(/ftms-audit-\d{12}\.csv/);
    const text = res.text;
    expect(text.charCodeAt(0)).toBe(0xfeff);
    const lines = text.trim().split('\r\n');
    expect(lines[0]).toContain('Performed by');
    expect(lines).toHaveLength(5); // header + four visit events
    expect(text).toContain('visit.cancelled');
    expect(text).toContain('Heavy rain');
    expect(text).toContain('title: Audit visit → Audit visit 2');
    const xlsx = await http()
      .get('/audit-logs/export?format=xlsx&category=VISITS')
      .set(bearer(tokens.director!))
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      })
      .expect(200);
    expect((xlsx.body as Buffer).subarray(0, 2).toString()).toBe('PK');
    const exported = (await log('action=audit.exported')).items;
    expect(exported).toHaveLength(2);
    expect(exported[1]).toMatchObject({
      actor: { id: director.id },
      metadata: { format: 'csv', rows: 4 },
    });
    // Exporting needs reports.export as well as audit.read.
    await prisma.userPermissionGrant.create({
      data: {
        userId: director.id,
        permissionKey: 'reports.export',
        effect: 'DENY',
        reason: 'test',
      },
    });
    const denied = await http().get('/audit-logs/export?format=csv').set(bearer(tokens.director!));
    expect(denied.status).toBe(403);
    await prisma.userPermissionGrant.deleteMany({ where: { userId: director.id } });
  });
});
