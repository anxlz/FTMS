import {
  CalendarResponseSchema,
  GroupSwapStaffViewSchema,
  GroupSwapViewSchema,
  ListGroupSwapHistoryResponseSchema,
  ListGroupSwapsResponseSchema,
  SwapTargetsResponseSchema,
  TicketDetailSchema,
} from '@ftms/core';
import request from 'supertest';
import { z } from 'zod';
import { BackgroundTasks } from '../src/common/background-tasks.service';
import { PrismaService } from '../src/prisma/prisma.service';
import {
  addToGroup,
  bearer,
  bootTestApp,
  cairoDate,
  createGroup,
  createProgram,
  createStudentRecord,
  createUser,
  createVisit,
  login,
  recordOf,
  resetDatabase,
  type SeededUser,
  type TestApp,
} from './helpers/test-app';

interface Student {
  user: SeededUser;
  token: string;
  recordId: string;
  seat: string;
}

describe('Mutual group swaps (§14, §20.4)', () => {
  let app: TestApp;
  let prisma: PrismaService;
  const http = () => request(app.getHttpServer());

  let director: SeededUser;
  let faculty: SeededUser;
  let directorToken: string;
  let facultyToken: string;
  let A: { id: string; name: string };
  let B: { id: string; name: string };
  let C: { id: string; name: string };
  let a1: Student;
  let a2: Student;
  let b1: Student;
  let b2: Student;
  let c1: Student;

  beforeAll(async () => {
    ({ app } = await bootTestApp());
    prisma = app.get(PrismaService);
  });
  afterAll(async () => {
    await app.close();
  });

  async function student(groupId: string | null): Promise<Student> {
    const user = await createUser(app, 'STUDENT');
    const recordId = await recordOf(app, user.id);
    if (groupId) await addToGroup(app, recordId, groupId);
    const token = (await login(app, user.email, user.password!)).accessToken;
    return { user, token, recordId, seat: user.seatNumber! };
  }

  beforeEach(async () => {
    await resetDatabase(app);
    director = await createUser(app, 'TRAINING_DIRECTOR');
    faculty = await createUser(app, 'FACULTY');
    directorToken = (await login(app, director.email, director.password!)).accessToken;
    facultyToken = (await login(app, faculty.email, faculty.password!)).accessToken;
    A = await createGroup(app, 'Group A');
    B = await createGroup(app, 'Group B');
    C = await createGroup(app, 'Group C');
    a1 = await student(A.id);
    a2 = await student(A.id);
    b1 = await student(B.id);
    b2 = await student(B.id);
    c1 = await student(C.id);
  });

  /* ─────────────────────────── helpers ─────────────────────────── */

  const ask = (from: Student, to: Student | string, target: { id: string }, name?: string) =>
    http()
      .post('/group-swaps')
      .set(bearer(from.token))
      .send({
        targetGroupId: target.id,
        counterpartSeatNumber: typeof to === 'string' ? to : to.seat,
        ...(name ? { counterpartName: name } : {}),
      });

  async function requested(from: Student, to: Student, target: { id: string }) {
    const res = await ask(from, to, target).expect(201);
    return GroupSwapViewSchema.parse(res.body);
  }

  const act = (who: Student | string, id: string, action: string, body: object = {}) =>
    http()
      .post(`/group-swaps/${id}/${action}`)
      .set(bearer(typeof who === 'string' ? who : who.token))
      .send(body);

  const groupOf = async (s: Student) =>
    (
      await prisma.groupMembership.findMany({
        where: { studentId: s.recordId, endedAt: null },
        select: { groupId: true },
      })
    ).map((m) => m.groupId);

  async function notificationsOf(s: Student) {
    await app.get(BackgroundTasks).drain();
    return prisma.notification.findMany({
      where: { recipientId: s.user.id },
      orderBy: { createdAt: 'asc' },
    });
  }

  const expectError = (res: request.Response, status: number, code: string) =>
    expect({ status: res.status, code: res.body?.code }).toEqual({ status, code });

  /* ─────────────────────────── §20.4 ─────────────────────────── */

  it('A→B: request, counterpart notified, acceptance sends it to faculty review without moving anyone', async () => {
    const swap = await requested(a1, b1, B);
    expect(swap).toMatchObject({
      status: 'PENDING_COUNTERPART',
      role: 'REQUESTER',
      requester: { seatNumber: a1.seat, group: A },
      counterpart: { seatNumber: b1.seat, group: B },
    });

    // The counterpart (identified by seat number) is told; nobody else is.
    const toB1 = await notificationsOf(b1);
    expect(toB1.map((n) => [n.type, n.link])).toEqual([
      ['group_swap.requested', `/group-swaps/${swap.id}`],
    ]);
    expect(toB1[0]!.data).toMatchObject({ requesterSeat: a1.seat, requesterGroup: 'Group A' });
    for (const other of [a1, a2, b2, c1]) expect(await notificationsOf(other)).toEqual([]);

    // The counterpart sees it among their requests and opens it.
    const mine = z
      .array(GroupSwapViewSchema)
      .parse((await http().get('/me/group-swaps').set(bearer(b1.token)).expect(200)).body);
    expect(mine.map((r) => [r.id, r.role])).toEqual([[swap.id, 'COUNTERPART']]);

    // The faculty cannot decide before the counterpart has consented.
    expectError(await act(facultyToken, swap.id, 'approve'), 409, 'SWAP_NOT_ALLOWED');

    const accepted = GroupSwapViewSchema.parse((await act(b1, swap.id, 'accept').expect(200)).body);
    expect(accepted).toMatchObject({ status: 'PENDING_FACULTY', role: 'COUNTERPART' });
    // Acceptance alone never changes a group.
    expect(await groupOf(a1)).toEqual([A.id]);
    expect(await groupOf(b1)).toEqual([B.id]);
    expect((await notificationsOf(a1)).map((n) => n.type)).toEqual(['group_swap.accepted']);
    expect((await notificationsOf(b1)).map((n) => n.type)).toEqual([
      'group_swap.requested',
      'group_swap.under_review',
    ]);

    // It is now in the faculty queue with both identities and current groups.
    const queue = ListGroupSwapsResponseSchema.parse(
      (
        await http()
          .get('/group-swaps?status=PENDING_FACULTY')
          .set(bearer(facultyToken))
          .expect(200)
      ).body,
    );
    expect(queue.items).toHaveLength(1);
    expect(queue.items[0]).toMatchObject({
      id: swap.id,
      stale: false,
      requester: { studentId: a1.recordId, currentGroup: A },
      counterpart: { studentId: b1.recordId, currentGroup: B },
    });
    const ticket = await prisma.supportTicket.findUniqueOrThrow({ where: { id: swap.ticketId } });
    expect(ticket).toMatchObject({ category: 'GROUP_SWAP', status: 'IN_PROGRESS' });
  });

  it('faculty approval exchanges both groups atomically, updates calendars and notifies both', async () => {
    const program = await createProgram(app);
    const visitA = await createVisit(app, program.id, [A.id], { title: 'Visit for A' });
    const visitB = await createVisit(app, program.id, [B.id], { title: 'Visit for B' });
    const swap = await requested(a1, b1, B);
    await act(b1, swap.id, 'accept').expect(200);

    const approved = GroupSwapStaffViewSchema.parse(
      (await act(facultyToken, swap.id, 'approve').expect(200)).body,
    );
    expect(approved).toMatchObject({
      status: 'APPROVED',
      requester: { currentGroup: B },
      counterpart: { currentGroup: A },
      stale: false,
    });
    expect(await groupOf(a1)).toEqual([B.id]);
    expect(await groupOf(b1)).toEqual([A.id]);
    // The previous memberships are history; the new ones say how they came about.
    const history = await prisma.groupMembership.findMany({
      where: { studentId: { in: [a1.recordId, b1.recordId] } },
      orderBy: { startedAt: 'asc' },
    });
    expect(history.filter((m) => m.endedAt === null).map((m) => m.source)).toEqual([
      'SWAP',
      'SWAP',
    ]);
    expect(history.filter((m) => m.endedAt !== null)).toHaveLength(2);

    // Future calendars follow the new groups.
    const calendar = async (s: Student) =>
      CalendarResponseSchema.parse(
        (
          await http()
            .get(`/calendar?from=${cairoDate(0)}&to=${cairoDate(30)}`)
            .set(bearer(s.token))
            .expect(200)
        ).body,
      ).visits.map((v) => v.id);
    expect(await calendar(a1)).toEqual([visitB.id]);
    expect(await calendar(b1)).toEqual([visitA.id]);

    // Both students are told, each with their new group.
    const approvedFor = async (s: Student) =>
      (await notificationsOf(s)).find((n) => n.type === 'group_swap.approved');
    expect((await approvedFor(a1))?.data).toMatchObject({ newGroup: 'Group B' });
    expect((await approvedFor(b1))?.data).toMatchObject({ newGroup: 'Group A' });
    expect(await notificationsOf(a2)).toEqual([]);

    // The ticket is closed; the audit log has the decision and both moves.
    const ticket = await prisma.supportTicket.findUniqueOrThrow({ where: { id: swap.ticketId } });
    expect(ticket.status).toBe('CLOSED');
    const decision = await prisma.auditLog.findFirstOrThrow({
      where: { action: 'group_swap.approved', resourceId: swap.id },
    });
    expect(decision).toMatchObject({ actorId: faculty.id, actorRole: 'FACULTY' });
    const moves = await prisma.auditLog.findMany({
      where: { action: 'group.member_moved', resourceId: { in: [a1.recordId, b1.recordId] } },
    });
    expect(moves).toHaveLength(2);
    for (const m of moves)
      expect(m.metadata).toMatchObject({ source: 'SWAP', swapRequestId: swap.id });
  });

  it('a counterpart rejection leaves both groups unchanged; the requester may ask again', async () => {
    const swap = await requested(a1, b2, B);
    const declined = GroupSwapViewSchema.parse(
      (await act(b2, swap.id, 'decline', { reason: 'I prefer my group' }).expect(200)).body,
    );
    expect(declined).toMatchObject({
      status: 'COUNTERPART_REJECTED',
      rejectionReason: 'I prefer my group',
    });
    expect(await groupOf(a1)).toEqual([A.id]);
    expect(await groupOf(b2)).toEqual([B.id]);
    const told = (await notificationsOf(a1)).find(
      (n) => n.type === 'group_swap.counterpart_rejected',
    );
    expect(told?.data).toMatchObject({ reason: 'I prefer my group' });
    // Decided: no further transitions.
    expectError(await act(b2, swap.id, 'accept'), 409, 'SWAP_NOT_ALLOWED');
    expectError(await act(facultyToken, swap.id, 'approve'), 409, 'SWAP_NOT_ALLOWED');
    // Rejected requests remain in history and do not block a new one.
    await requested(a1, b2, B);
    expect(await prisma.groupSwapRequest.count()).toBe(2);
  });

  it('a faculty rejection requires a reason, leaves groups unchanged and is shown to both students without the decider', async () => {
    const swap = await requested(a1, b1, B);
    await act(b1, swap.id, 'accept').expect(200);

    const missing = await act(facultyToken, swap.id, 'reject', {});
    expectError(missing, 400, 'VALIDATION_FAILED');
    expect(missing.body.details).toEqual({ reason: ['REASON_REQUIRED'] });
    expectError(
      await act(facultyToken, swap.id, 'reject', { reason: '  ' }),
      400,
      'VALIDATION_FAILED',
    );
    expect(
      (await prisma.groupSwapRequest.findUniqueOrThrow({ where: { id: swap.id } })).status,
    ).toBe('PENDING_FACULTY');

    const rejected = GroupSwapStaffViewSchema.parse(
      (await act(facultyToken, swap.id, 'reject', { reason: 'Group B is at capacity' }).expect(200))
        .body,
    );
    expect(rejected).toMatchObject({
      status: 'FACULTY_REJECTED',
      rejectionReason: 'Group B is at capacity',
    });
    expect(await groupOf(a1)).toEqual([A.id]);
    expect(await groupOf(b1)).toEqual([B.id]);
    for (const s of [a1, b1]) {
      const n = (await notificationsOf(s)).find((x) => x.type === 'group_swap.rejected');
      expect(n?.data).toMatchObject({ reason: 'Group B is at capacity' });
    }

    // Students see the outcome and the reason — never who decided (§13.3).
    const facultyRow = await prisma.user.findUniqueOrThrow({ where: { id: faculty.id } });
    const secrets = [facultyRow.displayName, facultyRow.email, facultyRow.id];
    for (const s of [a1, b1]) {
      const view = (await http().get(`/group-swaps/${swap.id}`).set(bearer(s.token)).expect(200))
        .body;
      expect(GroupSwapViewSchema.parse(view)).toMatchObject({
        status: 'FACULTY_REJECTED',
        rejectionReason: 'Group B is at capacity',
      });
      const list = (await http().get('/me/group-swaps').set(bearer(s.token)).expect(200)).body;
      const notes = (await http().get('/notifications').set(bearer(s.token)).expect(200)).body;
      for (const text of [JSON.stringify(view), JSON.stringify(list), JSON.stringify(notes)]) {
        for (const secret of secrets) expect(text).not.toContain(secret);
      }
    }
    const ticket = TicketDetailSchema.parse(
      (await http().get(`/tickets/${swap.ticketId}`).set(bearer(a1.token)).expect(200)).body,
    );
    expect(ticket).toMatchObject({
      status: 'CLOSED',
      resolution: 'Group B is at capacity',
      swap: { status: 'FACULTY_REJECTED', rejectionReason: 'Group B is at capacity' },
    });
    expect(ticket.history.filter((h) => h.by.kind === 'STAFF').map((h) => h.by.name)).toEqual([
      null,
    ]);
    for (const secret of secrets) expect(JSON.stringify(ticket)).not.toContain(secret);

    // The requester may submit a new request after a rejection.
    await requested(a1, b1, B);
  });

  it('conflicting pending requests cannot create invalid memberships', async () => {
    const first = await requested(a1, b1, B);
    // Neither student may join another open request — as requester or counterpart.
    expectError(await ask(a1, b2, B), 409, 'SWAP_CONFLICT');
    expectError(await ask(b2, a1, A), 409, 'SWAP_CONFLICT');
    expectError(await ask(c1, b1, B), 409, 'SWAP_CONFLICT');
    expectError(await ask(b1, c1, C), 409, 'SWAP_CONFLICT');

    // Two simultaneous requests for the same counterpart: one wins.
    const results = await Promise.all([ask(a2, b2, B), ask(c1, b2, B)]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(results.find((r) => r.status === 409)?.body.code).toBe('SWAP_CONFLICT');

    // Two faculty members approving at once: the exchange happens exactly once.
    await act(b1, first.id, 'accept').expect(200);
    const director2 = await createUser(app, 'TRAINING_DIRECTOR');
    const token2 = (await login(app, director2.email, director2.password!)).accessToken;
    const approvals = await Promise.all([
      act(facultyToken, first.id, 'approve'),
      act(token2, first.id, 'approve'),
    ]);
    expect(approvals.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await groupOf(a1)).toEqual([B.id]);
    expect(await groupOf(b1)).toEqual([A.id]);

    // Every student still has exactly one active group.
    for (const s of [a1, a2, b1, b2, c1]) expect(await groupOf(s)).toHaveLength(1);
  });

  it('closes a request when a student changes group by other means, and never applies it', async () => {
    const swap = await requested(a1, b1, B);
    await act(b1, swap.id, 'accept').expect(200);
    // The faculty moves b1 to group C before deciding.
    await http()
      .post(`/groups/${C.id}/members`)
      .set(bearer(facultyToken))
      .send({ studentIds: [b1.recordId], moveFromOtherGroup: true })
      .expect(200);
    const closed = await prisma.groupSwapRequest.findUniqueOrThrow({ where: { id: swap.id } });
    expect(closed).toMatchObject({ status: 'CANCELLED', cancelReason: 'GROUP_CHANGED' });
    for (const s of [a1, b1]) {
      expect((await notificationsOf(s)).map((n) => n.type)).toContain('group_swap.cancelled');
    }
    expectError(await act(facultyToken, swap.id, 'approve'), 409, 'SWAP_NOT_ALLOWED');
    expect(await groupOf(a1)).toEqual([A.id]);
    expect(await groupOf(b1)).toEqual([C.id]);
    // Both students are free again.
    await requested(a1, b2, B);
  });

  it('refuses an approval whose students moved behind its back (stale), and changes nothing', async () => {
    const swap = await requested(a1, b1, B);
    await act(b1, swap.id, 'accept').expect(200);
    // A change made outside the application (no hook ran): end b1's membership directly.
    await prisma.$transaction(async (tx) => {
      await tx.groupMembership.updateMany({
        where: { studentId: b1.recordId, endedAt: null },
        data: { endedAt: new Date() },
      });
      await tx.groupMembership.create({
        data: { studentId: b1.recordId, groupId: C.id, source: 'MANUAL' },
      });
    });
    const staff = GroupSwapStaffViewSchema.parse(
      (await http().get(`/group-swaps/${swap.id}`).set(bearer(facultyToken)).expect(200)).body,
    );
    expect(staff).toMatchObject({ stale: true, counterpart: { currentGroup: C } });
    expectError(await act(facultyToken, swap.id, 'approve'), 409, 'SWAP_STALE');
    expect(await groupOf(a1)).toEqual([A.id]);
    expect(await groupOf(b1)).toEqual([C.id]);
    expect(
      (await prisma.groupSwapRequest.findUniqueOrThrow({ where: { id: swap.id } })).status,
    ).toBe('CANCELLED');
  });

  it('the Training Director inspects the full decision history with identities', async () => {
    const approvedSwap = await requested(a1, b1, B);
    await act(b1, approvedSwap.id, 'accept').expect(200);
    await act(facultyToken, approvedSwap.id, 'approve').expect(200);
    const declined = await requested(a2, b2, B);
    await act(b2, declined.id, 'decline').expect(200);

    const res = await http().get('/group-swaps/history').set(bearer(directorToken)).expect(200);
    const history = ListGroupSwapHistoryResponseSchema.parse(res.body);
    expect(history.total).toBe(2);
    const entry = history.items.find((h) => h.id === approvedSwap.id)!;
    const facultyRow = await prisma.user.findUniqueOrThrow({ where: { id: faculty.id } });
    const b1Row = await prisma.user.findUniqueOrThrow({ where: { id: b1.user.id } });
    expect(entry).toMatchObject({
      status: 'APPROVED',
      requester: { seatNumber: a1.seat, group: A, currentGroup: B },
      counterpart: { seatNumber: b1.seat, group: B, currentGroup: A },
    });
    expect(entry.decisions.map((d) => [d.kind, d.decision, d.by?.name, d.by?.role])).toEqual([
      ['COUNTERPART', 'ACCEPTED', b1Row.displayName, 'STUDENT'],
      ['FACULTY', 'APPROVED', facultyRow.displayName, 'FACULTY'],
    ]);
    expect(entry.decisions.every((d) => !Number.isNaN(Date.parse(d.at)))).toBe(true);
    const other = history.items.find((h) => h.id === declined.id)!;
    expect(other.decisions.map((d) => [d.kind, d.decision])).toEqual([['COUNTERPART', 'REJECTED']]);

    // Filters: by seat number and status.
    const bySeat = ListGroupSwapHistoryResponseSchema.parse(
      (await http().get(`/group-swaps/history?q=${a2.seat}`).set(bearer(directorToken)).expect(200))
        .body,
    );
    expect(bySeat.items.map((h) => h.id)).toEqual([declined.id]);
    // Only holders of group_swaps.audit; students never.
    expectError(
      await http().get('/group-swaps/history').set(bearer(facultyToken)),
      403,
      'FORBIDDEN',
    );
    expectError(await http().get('/group-swaps/history').set(bearer(a1.token)), 403, 'FORBIDDEN');
  });

  /* ─────────────────────────── §14.2 validation ─────────────────────────── */

  it('offers the student the other active groups as targets', async () => {
    const res = await http().get('/me/group-swaps/groups').set(bearer(a1.token)).expect(200);
    expect(SwapTargetsResponseSchema.parse(res.body)).toEqual({ current: A, targets: [B, C] });
    const loner = await student(null);
    expect(
      (await http().get('/me/group-swaps/groups').set(bearer(loner.token)).expect(200)).body,
    ).toEqual({ current: null, targets: [] });
  });

  it('validates the request on the server', async () => {
    expectError(await ask(a1, a1, B), 400, 'SWAP_SELF');
    expectError(await ask(a1, a2, A), 400, 'SWAP_SAME_GROUP');
    // One answer for: a student of another group, an unknown seat, a wrong name,
    // a record without an account, a suspended account.
    const unlinked = await createStudentRecord(app, { seatNumber: 'NOACCOUNT-1' });
    await addToGroup(app, unlinked.id, B.id);
    const suspended = await student(B.id);
    await prisma.user.update({ where: { id: suspended.user.id }, data: { status: 'SUSPENDED' } });
    for (const res of [
      await ask(a1, c1, B),
      await ask(a1, 'ZZ-404', B),
      await ask(a1, b1, B, 'Somebody Else'),
      await ask(a1, 'NOACCOUNT-1', B),
      await ask(a1, suspended, B),
    ]) {
      expectError(res, 400, 'SWAP_COUNTERPART_NOT_FOUND');
      expect(res.body.details).toEqual({ counterpartSeatNumber: ['SWAP_COUNTERPART_NOT_FOUND'] });
    }
    expectError(
      await ask(a1, b1, { id: '01900000-0000-7000-8000-000000000000' }),
      404,
      'NOT_FOUND',
    );
    const loner = await student(null);
    expectError(await ask(loner, b1, B), 409, 'SWAP_NO_GROUP');
    expect(await prisma.groupSwapRequest.count()).toBe(0);

    // The optional name is a consistency check: two words in order suffice.
    const record = await prisma.studentProfile.update({
      where: { id: b1.recordId },
      data: { fullName: 'محمد أحمد علي حسن' },
    });
    expect(record.fullName).toBe('محمد أحمد علي حسن');
    expect((await ask(a1, b1, B, 'محمد حسن')).status).toBe(201);
  });

  it('lets only the right person act at each step', async () => {
    const swap = await requested(a1, b1, B);
    // Only the counterpart answers; others do not even see it.
    expectError(await act(a1, swap.id, 'accept'), 403, 'FORBIDDEN');
    expectError(await act(b2, swap.id, 'accept'), 404, 'NOT_FOUND');
    expectError(
      await http().get(`/group-swaps/${swap.id}`).set(bearer(c1.token)),
      404,
      'NOT_FOUND',
    );
    // Staff do not consent for students; students do not decide for faculty.
    expectError(await act(facultyToken, swap.id, 'accept'), 403, 'FORBIDDEN');
    await act(b1, swap.id, 'accept').expect(200);
    expectError(await act(b1, swap.id, 'approve'), 403, 'FORBIDDEN');
    // A faculty member denied group_swaps.decide cannot decide by calling the API.
    const denied = await createUser(app, 'FACULTY');
    await prisma.userPermissionGrant.create({
      data: {
        userId: denied.id,
        permissionKey: 'group_swaps.decide',
        effect: 'DENY',
        grantedById: director.id,
        reason: 'Not on the committee',
      },
    });
    const deniedToken = (await login(app, denied.email, denied.password!)).accessToken;
    expectError(await act(deniedToken, swap.id, 'approve'), 403, 'FORBIDDEN');
    expect(await groupOf(a1)).toEqual([A.id]);
  });

  it('lets the requester withdraw an open request, telling the counterpart', async () => {
    const swap = await requested(a1, b1, B);
    expectError(await act(b1, swap.id, 'withdraw'), 403, 'FORBIDDEN');
    const withdrawn = GroupSwapViewSchema.parse(
      (await act(a1, swap.id, 'withdraw').expect(200)).body,
    );
    expect(withdrawn.status).toBe('WITHDRAWN');
    expect((await notificationsOf(b1)).map((n) => n.type)).toEqual([
      'group_swap.requested',
      'group_swap.withdrawn',
    ]);
    expectError(await act(b1, swap.id, 'accept'), 409, 'SWAP_NOT_ALLOWED');
    await requested(b1, a1, A);
  });

  it('limits how many requests a student can send', async () => {
    for (let i = 0; i < 10; i += 1) {
      expectError(await ask(a1, `ZZ-${i}`, B), 400, 'SWAP_COUNTERPART_NOT_FOUND');
    }
    expectError(await ask(a1, b1, B), 429, 'AUTH_RATE_LIMITED');
  });
});
