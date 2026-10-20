import { GroupDetailSchema, ListStudentsResponseSchema, StudentDetailSchema } from '@ftms/core';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import {
  addToGroup,
  bearer,
  bootTestApp,
  createGroup,
  createStudentRecord,
  createUser,
  login,
  type Mailbox,
  recordOf,
  resetDatabase,
  type TestApp,
} from './helpers/test-app';

describe('Student records and training groups (§4.1, §5, §16.1)', () => {
  let app: TestApp;
  let mailbox: Mailbox;
  let prisma: PrismaService;
  let faculty: string;
  let director: string;
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
    faculty = (await login(app, f.email, f.password!)).accessToken;
    const d = await createUser(app, 'TRAINING_DIRECTOR');
    director = (await login(app, d.email, d.password!)).accessToken;
  });

  /* ───────────────── one active group per student, in the database ───────────────── */

  describe('database constraints', () => {
    it('rejects a second active membership for the same student (DoD: violated directly)', async () => {
      const student = await createStudentRecord(app);
      const a = await createGroup(app, 'A');
      const b = await createGroup(app, 'B');
      await addToGroup(app, student.id, a.id);

      // Straight through Prisma, bypassing every service check.
      await expect(
        prisma.groupMembership.create({
          data: { studentId: student.id, groupId: b.id, source: 'MANUAL' },
        }),
      ).rejects.toThrow(/group_memberships_one_active_per_student|Unique constraint/);
      // And with raw SQL.
      await expect(
        prisma.$executeRawUnsafe(
          `INSERT INTO group_memberships (id, student_id, group_id, source)
           VALUES (gen_random_uuid(), $1::uuid, $2::uuid, 'MANUAL')`,
          student.id,
          b.id,
        ),
      ).rejects.toThrow(/group_memberships_one_active_per_student/);
      // Even the same group twice.
      await expect(
        prisma.groupMembership.create({
          data: { studentId: student.id, groupId: a.id, source: 'MANUAL' },
        }),
      ).rejects.toThrow();

      expect(await prisma.groupMembership.count({ where: { studentId: student.id } })).toBe(1);
    });

    it('allows any number of ended memberships (history) next to one active one', async () => {
      const student = await createStudentRecord(app);
      const a = await createGroup(app);
      const b = await createGroup(app);
      const old = await prisma.groupMembership.create({
        data: { studentId: student.id, groupId: a.id, source: 'MANUAL' },
      });
      await prisma.groupMembership.update({ where: { id: old.id }, data: { endedAt: new Date() } });
      await prisma.groupMembership.create({
        data: { studentId: student.id, groupId: b.id, source: 'MANUAL' },
      });
      expect(await prisma.groupMembership.count({ where: { studentId: student.id } })).toBe(2);
    });

    it('keeps ended memberships immutable and never reassigns a membership', async () => {
      const student = await createStudentRecord(app);
      const a = await createGroup(app);
      const b = await createGroup(app);
      const m = await prisma.groupMembership.create({
        data: { studentId: student.id, groupId: a.id, source: 'MANUAL' },
      });
      await expect(
        prisma.groupMembership.update({ where: { id: m.id }, data: { groupId: b.id } }),
      ).rejects.toThrow(/cannot be reassigned/);
      await prisma.groupMembership.update({ where: { id: m.id }, data: { endedAt: new Date() } });
      await expect(
        prisma.groupMembership.update({ where: { id: m.id }, data: { endedAt: null } }),
      ).rejects.toThrow(/history/);
    });

    it('refuses members in archived groups and archiving groups that have members', async () => {
      const student = await createStudentRecord(app);
      const archived = await createGroup(app);
      await prisma.trainingGroup.update({
        where: { id: archived.id },
        data: { archivedAt: new Date() },
      });
      await expect(
        prisma.groupMembership.create({
          data: { studentId: student.id, groupId: archived.id, source: 'MANUAL' },
        }),
      ).rejects.toThrow(/archived/);

      const busy = await createGroup(app);
      await addToGroup(app, student.id, busy.id);
      await expect(
        prisma.trainingGroup.update({ where: { id: busy.id }, data: { archivedAt: new Date() } }),
      ).rejects.toThrow(/still has members/);
    });

    it('makes group names unique regardless of case and spacing', async () => {
      await createGroup(app, 'Group A');
      await expect(prisma.trainingGroup.create({ data: { name: 'group  a' } })).rejects.toThrow(
        /training_groups_name_key|Unique constraint/,
      );
      await expect(prisma.trainingGroup.create({ data: { name: ' padded ' } })).rejects.toThrow();
    });

    it('keeps an ACTIVE student account linked to a record (checked at commit)', async () => {
      await expect(
        prisma.user.create({
          data: {
            email: 'loose@agr.asu.edu.eg',
            role: 'STUDENT',
            status: 'ACTIVE',
            displayName: 'x',
          },
        }),
      ).rejects.toThrow(/must be linked to a student record/);
      const student = await createUser(app, 'STUDENT');
      await expect(
        prisma.studentProfile.update({ where: { userId: student.id }, data: { userId: null } }),
      ).rejects.toThrow(/must be linked to a student record/);
      await expect(
        prisma.user.create({
          data: {
            email: 'staff-pending@agr.asu.edu.eg',
            role: 'FACULTY',
            status: 'PENDING_VERIFICATION',
            displayName: 'x',
          },
        }),
      ).rejects.toThrow(/users_pending_only_students|check constraint/);
    });

    it('derives the name search key in the database (Arabic spelling variants)', async () => {
      const record = await createStudentRecord(app, { fullName: 'أحمد مُحمّد عبد الله' });
      const row = await prisma.studentProfile.findUniqueOrThrow({ where: { id: record.id } });
      expect(row.nameKey).toBe('احمدمحمدعبدالله');
      await prisma.studentProfile.update({ where: { id: record.id }, data: { nameKey: 'forged' } });
      expect(
        (await prisma.studentProfile.findUniqueOrThrow({ where: { id: record.id } })).nameKey,
      ).toBe('احمدمحمدعبدالله');
    });
  });

  /* ─────────────────────────────── groups API ─────────────────────────────── */

  describe('groups', () => {
    it('creates, renames and refuses duplicate names (any capitalization)', async () => {
      const created = await http()
        .post('/groups')
        .set(bearer(faculty))
        .send({ name: '  المجموعة   الأولى ', description: 'صباحية' })
        .expect(201);
      expect(created.body).toMatchObject({ name: 'المجموعة الأولى', memberCount: 0 });

      await http().post('/groups').set(bearer(faculty)).send({ name: 'Group B' }).expect(201);
      const dup = await http()
        .patch(`/groups/${created.body.id}`)
        .set(bearer(faculty))
        .send({ name: 'GROUP b' })
        .expect(409);
      expect(dup.body.code).toBe('GROUP_NAME_EXISTS');

      const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: 'group.created' } });
      expect(audit.after).toMatchObject({ name: 'المجموعة الأولى' });
    });

    it('assigns students; refuses to move one from another group unless asked, atomically', async () => {
      const a = await createGroup(app, 'A');
      const b = await createGroup(app, 'B');
      const s1 = await createStudentRecord(app);
      const s2 = await createStudentRecord(app);
      await addToGroup(app, s2.id, a.id);

      // s2 is in A: the whole request is refused, s1 is not added either.
      const refused = await http()
        .post(`/groups/${b.id}/members`)
        .set(bearer(faculty))
        .send({ studentIds: [s1.id, s2.id] })
        .expect(409);
      expect(refused.body).toMatchObject({
        code: 'STUDENT_IN_OTHER_GROUP',
        details: { studentIds: [s2.id] },
      });
      expect(await prisma.groupMembership.count({ where: { groupId: b.id } })).toBe(0);

      const moved = await http()
        .post(`/groups/${b.id}/members`)
        .set(bearer(faculty))
        .send({ studentIds: [s1.id, s2.id], moveFromOtherGroup: true, reason: 'rebalancing' })
        .expect(200);
      expect(moved.body).toEqual({ added: 1, moved: 1, alreadyMembers: 0 });

      const detail = GroupDetailSchema.parse(
        (await http().get(`/groups/${b.id}`).set(bearer(faculty)).expect(200)).body,
      );
      expect(detail.members.map((m) => m.studentId).sort()).toEqual([s1.id, s2.id].sort());

      const history = StudentDetailSchema.parse(
        (await http().get(`/students/${s2.id}`).set(bearer(faculty)).expect(200)).body,
      );
      expect(history.group).toEqual({ id: b.id, name: 'B' });
      expect(history.memberships.map((m) => [m.group.name, m.endedAt === null])).toEqual([
        ['B', true],
        ['A', false],
      ]);
      const audit = await prisma.auditLog.findFirstOrThrow({
        where: { action: 'group.member_moved', resourceId: s2.id },
      });
      expect(audit).toMatchObject({
        reason: 'rebalancing',
        before: { group: { id: a.id, name: 'A' } },
        after: { group: { id: b.id, name: 'B' } },
      });
    });

    it('serializes concurrent moves: a student never ends up in two groups', async () => {
      const groups = await Promise.all([createGroup(app), createGroup(app), createGroup(app)]);
      const student = await createStudentRecord(app);
      const results = await Promise.all(
        groups.map((g) =>
          http().put(`/students/${student.id}/group`).set(bearer(faculty)).send({ groupId: g.id }),
        ),
      );
      for (const res of results) expect([200, 409]).toContain(res.status);
      expect(
        await prisma.groupMembership.count({ where: { studentId: student.id, endedAt: null } }),
      ).toBe(1);
    });

    it('removes members, and archives only empty groups', async () => {
      const g = await createGroup(app);
      const s = await createStudentRecord(app);
      await addToGroup(app, s.id, g.id);
      const busy = await http()
        .put(`/groups/${g.id}/archived`)
        .set(bearer(faculty))
        .send({ archived: true })
        .expect(409);
      expect(busy.body.code).toBe('GROUP_NOT_EMPTY');

      await http()
        .delete(`/groups/${g.id}/members/${s.id}`)
        .set(bearer(faculty))
        .send({})
        .expect(204);
      await http()
        .put(`/groups/${g.id}/archived`)
        .set(bearer(faculty))
        .send({ archived: true })
        .expect(200);
      const closed = await http()
        .post(`/groups/${g.id}/members`)
        .set(bearer(faculty))
        .send({ studentIds: [s.id] })
        .expect(409);
      expect(closed.body.code).toBe('GROUP_ARCHIVED');
      const list = (await http().get('/groups').set(bearer(faculty)).expect(200)).body;
      expect(list).toEqual([]);
      const all = (await http().get('/groups?includeArchived=true').set(bearer(faculty))).body;
      expect(all).toHaveLength(1);
    });

    it('a faculty member denied groups.manage cannot change membership (API-enforced)', async () => {
      const f = await createUser(app, 'FACULTY');
      const sa = await createUser(app, 'SUPER_ADMIN');
      const saToken = (await login(app, sa.email, sa.password!)).accessToken;
      await http()
        .put(`/admin/users/${f.id}/permissions`)
        .set(bearer(saToken))
        .send({
          grants: [{ permission: 'groups.manage', effect: 'DENY' }],
          reason: 'read-only role',
        })
        .expect(200);
      const token = (await login(app, f.email, f.password!)).accessToken;
      const g = await createGroup(app);
      const s = await createStudentRecord(app);
      await http()
        .post(`/groups/${g.id}/members`)
        .set(bearer(token))
        .send({ studentIds: [s.id] })
        .expect(403);
      await http().get(`/groups/${g.id}`).set(bearer(token)).expect(200);
      // Creating a student straight into a group needs groups.manage too.
      await http()
        .post('/students')
        .set(bearer(token))
        .send({
          seatNumber: 'G-1',
          name: { firstName: 'سارة', familyName: 'محمود' },
          groupId: g.id,
        })
        .expect(403);
    });
  });

  /* ─────────────────────────────── records API ─────────────────────────────── */

  describe('student records', () => {
    it('creates a record from name parts, normalizing seat, email and phone', async () => {
      const g = await createGroup(app, 'G1');
      const res = await http()
        .post('/students')
        .set(bearer(faculty))
        .send({
          seatNumber: '٢٠٢٤-٧',
          name: {
            firstName: ' محمد ',
            fatherName: 'أحمد',
            grandfatherName: 'علي',
            familyName: 'حسن',
          },
          universityEmail: 'Mohamed.Hassan@AGR.asu.edu.eg',
          phone: '٠١٠ ١٢٣٤ ٥٦٧٨',
          groupId: g.id,
        })
        .expect(201);
      expect(StudentDetailSchema.parse(res.body)).toMatchObject({
        seatNumber: '2024-7',
        fullName: 'محمد أحمد علي حسن',
        universityEmail: 'mohamed.hassan@agr.asu.edu.eg',
        phone: '01012345678',
        group: { id: g.id, name: 'G1' },
        account: null,
      });
      const audit = await prisma.auditLog.findFirstOrThrow({
        where: { action: 'student.created' },
      });
      expect(audit.after).toMatchObject({ seatNumber: '2024-7', fullName: 'محمد أحمد علي حسن' });
    });

    it('refuses duplicates (seat, email in any case) and non-university emails', async () => {
      const existing = await createStudentRecord(app, { universityEmail: 'taken@agr.asu.edu.eg' });
      const body = (over: object) => ({
        seatNumber: 'NEW-1',
        name: { firstName: 'سارة', familyName: 'محمود' },
        ...over,
      });
      const seat = await http()
        .post('/students')
        .set(bearer(faculty))
        .send(body({ seatNumber: existing.seatNumber.toLowerCase() }))
        .expect(409);
      expect(seat.body.code).toBe('SEAT_NUMBER_ALREADY_EXISTS');
      const email = await http()
        .post('/students')
        .set(bearer(faculty))
        .send(body({ universityEmail: 'TAKEN@agr.asu.edu.eg' }))
        .expect(409);
      expect(email.body.code).toBe('EMAIL_ALREADY_EXISTS');
      const domain = await http()
        .post('/students')
        .set(bearer(faculty))
        .send(body({ universityEmail: 'someone@gmail.com' }))
        .expect(400);
      expect(domain.body).toMatchObject({
        code: 'EMAIL_NOT_UNIVERSITY',
        details: { universityEmail: ['EMAIL_NOT_UNIVERSITY'] },
      });
      const short = await http()
        .post('/students')
        .set(bearer(faculty))
        .send({ seatNumber: 'NEW-2', name: { firstName: 'سارة' } })
        .expect(400);
      expect(short.body.details).toHaveProperty(['name.fatherName']);
    });

    it('edits authoritative fields with before/after audit, and locks a linked email', async () => {
      const student = await createUser(app, 'STUDENT');
      const id = await recordOf(app, student.id);
      const renamed = await http()
        .patch(`/students/${id}`)
        .set(bearer(faculty))
        .send({ name: { firstName: 'منى', familyName: 'سعيد' }, reason: 'registrar correction' })
        .expect(200);
      expect(renamed.body.fullName).toBe('منى سعيد');
      // The account shows the authoritative name.
      expect((await prisma.user.findUniqueOrThrow({ where: { id: student.id } })).displayName).toBe(
        'منى سعيد',
      );
      const audit = await prisma.auditLog.findFirstOrThrow({
        where: { action: 'student.updated' },
      });
      expect(audit).toMatchObject({
        reason: 'registrar correction',
        after: { fullName: 'منى سعيد' },
      });

      const locked = await http()
        .patch(`/students/${id}`)
        .set(bearer(faculty))
        .send({ universityEmail: 'other@agr.asu.edu.eg' })
        .expect(409);
      expect(locked.body.code).toBe('EMAIL_LOCKED_BY_ACCOUNT');
      const nothing = await http()
        .patch(`/students/${id}`)
        .set(bearer(faculty))
        .send({ phone: null })
        .expect(409);
      expect(nothing.body.code).toBe('NO_CHANGES');
    });

    it('deletes only unlinked records, keeping a snapshot in the audit log', async () => {
      const student = await createUser(app, 'STUDENT');
      const linked = await recordOf(app, student.id);
      const refused = await http()
        .delete(`/students/${linked}`)
        .set(bearer(faculty))
        .send({ reason: 'duplicate' })
        .expect(409);
      expect(refused.body.code).toBe('STUDENT_LINKED_TO_ACCOUNT');

      const record = await createStudentRecord(app, { fullName: 'سجل مكرر للحذف' });
      await http().delete(`/students/${record.id}`).set(bearer(faculty)).send({}).expect(400);
      await http()
        .delete(`/students/${record.id}`)
        .set(bearer(faculty))
        .send({ reason: 'imported twice' })
        .expect(204);
      const audit = await prisma.auditLog.findFirstOrThrow({
        where: { action: 'student.deleted' },
      });
      expect(audit).toMatchObject({
        resourceId: record.id,
        reason: 'imported twice',
        before: { seatNumber: record.seatNumber, fullName: 'سجل مكرر للحذف' },
      });
    });

    it('searches names whatever the spelling, and filters by group and account', async () => {
      const g = await createGroup(app);
      const ahmed = await createStudentRecord(app, { fullName: 'أحمد عبد الله إبراهيم' });
      await createStudentRecord(app, { fullName: 'فاطمة علي' });
      await addToGroup(app, ahmed.id, g.id);
      const student = await createUser(app, 'STUDENT');

      const search = async (q: string) =>
        ListStudentsResponseSchema.parse(
          (
            await http()
              .get(`/students?q=${encodeURIComponent(q)}`)
              .set(bearer(faculty))
              .expect(200)
          ).body,
        ).items.map((s) => s.id);
      expect(await search('احمد عبدالله')).toEqual([ahmed.id]);
      expect(await search('ابراهيم')).toEqual([ahmed.id]);
      expect(await search(ahmed.seatNumber.toLowerCase())).toEqual([ahmed.id]);

      const list = async (query: string) =>
        ListStudentsResponseSchema.parse(
          (await http().get(`/students?${query}`).set(bearer(faculty)).expect(200)).body,
        );
      expect((await list(`group=${g.id}`)).items.map((s) => s.id)).toEqual([ahmed.id]);
      expect((await list('group=none')).total).toBe(2);
      expect((await list('account=linked')).items.map((s) => s.account?.userId)).toEqual([
        student.id,
      ]);
    });

    it('unlinks a wrongly linked account: back to pending, sessions revoked', async () => {
      const student = await createUser(app, 'STUDENT');
      const token = (await login(app, student.email, student.password!)).accessToken;
      const id = await recordOf(app, student.id);
      const res = await http()
        .post(`/students/${id}/unlink-account`)
        .set(bearer(director))
        .send({ reason: 'linked to the wrong person' })
        .expect(200);
      expect(res.body.account).toBeNull();
      await http().get('/auth/me').set(bearer(token)).expect(401);
      const account = await prisma.user.findUniqueOrThrow({ where: { id: student.id } });
      expect(account.status).toBe('PENDING_VERIFICATION');

      // Signing in again works, but only the verification page is reachable.
      const again = (await login(app, student.email, student.password!)).accessToken;
      const me = await http().get('/auth/me').set(bearer(again)).expect(200);
      expect(me.body).toMatchObject({ status: 'PENDING_VERIFICATION', studentProfile: null });
      const blocked = await http().get('/me/student').set(bearer(again)).expect(403);
      expect(blocked.body.code).toBe('AUTH_ACCOUNT_PENDING');
      expect((await http().get('/me/verification').set(bearer(again)).expect(200)).body.state).toBe(
        'NONE',
      );
    });
  });
});
