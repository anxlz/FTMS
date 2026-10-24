import { PrismaService } from '../src/prisma/prisma.service';
import {
  addToGroup,
  bootTestApp,
  createGroup,
  createUser,
  recordOf,
  resetDatabase,
  type TestApp,
} from './helpers/test-app';

/** Phase 5 rules enforced by the database itself (§13, §14, §16.1), violated directly. */
describe('Ticket and group-swap database rules (real Postgres)', () => {
  let app: TestApp;
  let prisma: PrismaService;
  let userA: string;
  let userB: string;
  let a: string;
  let b: string;
  let c: string;
  let groupA: string;
  let groupB: string;
  let groupC: string;

  beforeAll(async () => {
    ({ app } = await bootTestApp());
    prisma = app.get(PrismaService);
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(async () => {
    await resetDatabase(app);
    groupA = (await createGroup(app, 'Group A')).id;
    groupB = (await createGroup(app, 'Group B')).id;
    groupC = (await createGroup(app, 'Group C')).id;
    const ua = await createUser(app, 'STUDENT');
    const ub = await createUser(app, 'STUDENT');
    const uc = await createUser(app, 'STUDENT');
    userA = ua.id;
    userB = ub.id;
    a = await recordOf(app, ua.id);
    b = await recordOf(app, ub.id);
    c = await recordOf(app, uc.id);
    await addToGroup(app, a, groupA);
    await addToGroup(app, b, groupB);
    await addToGroup(app, c, groupC);
  });

  const rejects = (promise: Promise<unknown>, pattern: RegExp) =>
    expect(promise).rejects.toThrow(pattern);

  const ticket = (studentId: string, createdById: string, category: 'COMPLAINT' | 'GROUP_SWAP') =>
    prisma.supportTicket.create({
      data: { studentId, createdById, category, subject: 'Subject', description: 'Description' },
    });

  /** A request from a (group A) to b (group B), with its ticket, in one transaction. */
  const swap = (
    over: Partial<{
      requesterId: string;
      counterpartId: string;
      userId: string;
      groups: [string, string];
    }> = {},
  ) =>
    prisma.$transaction(async (tx) => {
      const t = await tx.supportTicket.create({
        data: {
          studentId: over.requesterId ?? a,
          createdById: over.userId ?? userA,
          category: 'GROUP_SWAP',
          subject: 'Swap',
          description: 'Swap',
        },
      });
      return tx.groupSwapRequest.create({
        data: {
          ticketId: t.id,
          requesterId: over.requesterId ?? a,
          counterpartId: over.counterpartId ?? b,
          requesterGroupId: over.groups?.[0] ?? groupA,
          counterpartGroupId: over.groups?.[1] ?? groupB,
        },
      });
    });

  it('keeps messages, status changes, attachments and decisions as history', async () => {
    const t = await ticket(a, userA, 'COMPLAINT');
    const m = await prisma.ticketMessage.create({
      data: { ticketId: t.id, authorId: userA, authorRole: 'STUDENT', body: 'Hello' },
    });
    await rejects(
      prisma.ticketMessage.update({ where: { id: m.id }, data: { body: 'Edited' } }),
      /history/,
    );
    await rejects(prisma.ticketMessage.delete({ where: { id: m.id } }), /history/);
    const change = await prisma.ticketStatusChange.create({
      data: {
        ticketId: t.id,
        fromStatus: null,
        toStatus: 'OPEN',
        changedById: userA,
        changedByRole: 'STUDENT',
      },
    });
    await rejects(prisma.ticketStatusChange.delete({ where: { id: change.id } }), /history/);
    const file = await prisma.ticketAttachment.create({
      data: {
        ticketId: t.id,
        uploadedById: userA,
        bucket: 'ticket-attachments',
        storagePath: 'tickets/x/y.pdf',
        fileName: 'y.pdf',
        contentType: 'application/pdf',
        sizeBytes: 10,
      },
    });
    await rejects(prisma.ticketAttachment.delete({ where: { id: file.id } }), /history/);
    await rejects(prisma.supportTicket.delete({ where: { id: t.id } }), /history/);
  });

  it('checks ticket values and keeps who and what fixed', async () => {
    const t = await ticket(a, userA, 'COMPLAINT');
    await rejects(
      prisma.supportTicket.update({ where: { id: t.id }, data: { category: 'SUGGESTION' } }),
      /reassigned or recategorized/,
    );
    await rejects(
      prisma.supportTicket.update({ where: { id: t.id }, data: { studentId: b } }),
      /reassigned or recategorized/,
    );
    await rejects(
      prisma.supportTicket.update({ where: { id: t.id }, data: { status: 'CLOSED' } }),
      /support_tickets_values/,
    );
    await rejects(
      prisma.ticketMessage.create({
        data: { ticketId: t.id, authorId: userA, authorRole: 'STUDENT', body: 'x', internal: true },
      }),
      /ticket_messages_values/,
    );
    await rejects(
      prisma.ticketAttachment.create({
        data: {
          ticketId: t.id,
          uploadedById: userA,
          bucket: 'visit-documents',
          storagePath: 'tickets/x/z.exe',
          fileName: 'z.exe',
          contentType: 'application/octet-stream',
          sizeBytes: 10,
        },
      }),
      /ticket_attachments_values/,
    );
    // A group-swap ticket cannot exist without its request (checked at commit).
    await rejects(ticket(a, userA, 'GROUP_SWAP'), /has no request/);
  });

  it('refuses self swaps, same-group swaps and requests for groups the students are not in', async () => {
    await rejects(
      swap({ counterpartId: a, groups: [groupA, groupA] }),
      /group_swap_requests_parties/,
    );
    // b is in group B, not C; a is in A, not B.
    await rejects(swap({ groups: [groupA, groupC] }), /no longer in the groups/);
    await rejects(swap({ groups: [groupB, groupB] }), /no longer in the groups/);
  });

  it('lets a student take part in only one open request', async () => {
    await swap();
    await rejects(
      swap({ requesterId: c, counterpartId: b, groups: [groupC, groupB], userId: userB }),
      /already takes part/,
    );
    // The same pair cannot ask twice either.
    await rejects(swap(), /already takes part/);
  });

  it('follows the state machine and freezes decided requests', async () => {
    const r = await swap();
    // The faculty cannot decide before the counterpart.
    await rejects(
      prisma.groupSwapRequest.update({
        where: { id: r.id },
        data: {
          status: 'FACULTY_REJECTED',
          facultyDecidedAt: new Date(),
          facultyReason: 'No',
          closedAt: new Date(),
        },
      }),
      /cannot go from PENDING_COUNTERPART to FACULTY_REJECTED/,
    );
    await prisma.groupSwapRequest.update({
      where: { id: r.id },
      data: { status: 'PENDING_FACULTY', counterpartDecidedAt: new Date() },
    });
    // A faculty rejection needs its reason.
    await rejects(
      prisma.groupSwapRequest.update({
        where: { id: r.id },
        data: { status: 'FACULTY_REJECTED', facultyDecidedAt: new Date(), closedAt: new Date() },
      }),
      /group_swap_requests_decisions/,
    );
    await prisma.groupSwapRequest.update({
      where: { id: r.id },
      data: {
        status: 'FACULTY_REJECTED',
        facultyDecidedAt: new Date(),
        facultyReason: 'Full',
        closedAt: new Date(),
      },
    });
    await rejects(
      prisma.groupSwapRequest.update({
        where: { id: r.id },
        data: { status: 'PENDING_FACULTY', closedAt: null },
      }),
      /cannot go from FACULTY_REJECTED/,
    );
    await rejects(
      prisma.groupSwapRequest.update({ where: { id: r.id }, data: { facultyReason: 'Changed' } }),
      /decided and cannot change/,
    );
    await rejects(
      prisma.groupSwapRequest.update({ where: { id: r.id }, data: { counterpartId: c } }),
      /cannot change its students or groups/,
    );
    await rejects(prisma.groupSwapRequest.delete({ where: { id: r.id } }), /history/);
  });

  it('commits an approval only together with the complete exchange', async () => {
    const r = await swap();
    await prisma.groupSwapRequest.update({
      where: { id: r.id },
      data: { status: 'PENDING_FACULTY', counterpartDecidedAt: new Date() },
    });
    const approve = (tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0]) =>
      tx.groupSwapRequest.update({
        where: { id: r.id },
        data: { status: 'APPROVED', facultyDecidedAt: new Date(), closedAt: new Date() },
      });
    const move = async (
      tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0],
      studentId: string,
      groupId: string,
    ) => {
      await tx.groupMembership.updateMany({
        where: { studentId, endedAt: null },
        data: { endedAt: new Date() },
      });
      await tx.groupMembership.create({ data: { studentId, groupId, source: 'SWAP' } });
    };

    // Approved without moving anyone.
    await rejects(
      prisma.$transaction(async (tx) => {
        await approve(tx);
      }),
      /must exchange both students/,
    );
    // Only one of the two moved.
    await rejects(
      prisma.$transaction(async (tx) => {
        await approve(tx);
        await move(tx, a, groupB);
      }),
      /must exchange both students/,
    );
    expect((await prisma.groupSwapRequest.findUniqueOrThrow({ where: { id: r.id } })).status).toBe(
      'PENDING_FACULTY',
    );
    const active = async (studentId: string) =>
      (await prisma.groupMembership.findFirstOrThrow({ where: { studentId, endedAt: null } }))
        .groupId;
    expect([await active(a), await active(b)]).toEqual([groupA, groupB]);

    // Both moved: committed.
    await prisma.$transaction(async (tx) => {
      await approve(tx);
      await move(tx, a, groupB);
      await move(tx, b, groupA);
    });
    expect([await active(a), await active(b)]).toEqual([groupB, groupA]);
  });

  it('exposes none of the new tables to the Supabase Data API roles', async () => {
    const rows = await prisma.$queryRaw<{ relname: string; relrowsecurity: boolean }[]>`
      SELECT relname, relrowsecurity FROM pg_class
      WHERE relname IN ('support_tickets', 'ticket_messages', 'ticket_status_changes',
                        'ticket_attachments', 'group_swap_requests', 'group_swap_decisions')
      ORDER BY relname`;
    expect(rows).toHaveLength(6);
    expect(rows.every((r) => r.relrowsecurity)).toBe(true);
  });
});
