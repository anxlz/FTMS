import {
  type GroupRef,
  type GroupSwapRole,
  type GroupSwapStaffView,
  type GroupSwapStatus,
  type GroupSwapView,
  type NotificationType,
  OPEN_GROUP_SWAP_STATUSES,
  type Role,
  ticketStatusOfSwap,
} from '@ftms/core';
import { type AuditActor, type AuditService } from '../audit/audit.service';
import { type RequestContext } from '../common/request-context';
import {
  type GroupSwapDecisionKind,
  type GroupSwapDecisionValue,
  type GroupSwapRequest,
  type Prisma,
} from '../generated/prisma/client';
import { type NotificationsService } from '../notifications/notifications.service';

type Tx = Prisma.TransactionClient;

const PARTY = { select: { id: true, fullName: true, seatNumber: true, userId: true } } as const;
const GROUP = { select: { id: true, name: true } } as const;

export const SWAP_INCLUDE = {
  ticket: { select: { number: true } },
  requester: PARTY,
  counterpart: PARTY,
  requesterGroup: GROUP,
  counterpartGroup: GROUP,
} as const satisfies Prisma.GroupSwapRequestInclude;

export type SwapWithParties = Prisma.GroupSwapRequestGetPayload<{ include: typeof SWAP_INCLUDE }>;

/**
 * Adds the students, groups and ticket number to a request row with one query
 * at a time — inside interactive transactions Prisma's driver adapter must not
 * run the parallel relation queries an `include` produces.
 */
export async function withParties(
  db: Pick<Tx, 'supportTicket' | 'studentProfile' | 'trainingGroup'>,
  row: GroupSwapRequest,
): Promise<SwapWithParties> {
  const ticket = await db.supportTicket.findUniqueOrThrow({
    where: { id: row.ticketId },
    select: { number: true },
  });
  const requester = await db.studentProfile.findUniqueOrThrow({
    where: { id: row.requesterId },
    ...PARTY,
  });
  const counterpart = await db.studentProfile.findUniqueOrThrow({
    where: { id: row.counterpartId },
    ...PARTY,
  });
  const requesterGroup = await db.trainingGroup.findUniqueOrThrow({
    where: { id: row.requesterGroupId },
    ...GROUP,
  });
  const counterpartGroup = await db.trainingGroup.findUniqueOrThrow({
    where: { id: row.counterpartGroupId },
    ...GROUP,
  });
  return { ...row, ticket, requester, counterpart, requesterGroup, counterpartGroup };
}

const iso = (d: Date | null) => d?.toISOString() ?? null;

/** What a participating student sees — never who decided for the faculty (§13.3). */
export function toSwapView(r: SwapWithParties, role: GroupSwapRole | null): GroupSwapView {
  return {
    id: r.id,
    ticketId: r.ticketId,
    ticketNumber: r.ticket.number,
    status: r.status,
    role,
    requester: {
      fullName: r.requester.fullName,
      seatNumber: r.requester.seatNumber,
      group: r.requesterGroup,
    },
    counterpart: {
      fullName: r.counterpart.fullName,
      seatNumber: r.counterpart.seatNumber,
      group: r.counterpartGroup,
    },
    note: r.note,
    createdAt: r.createdAt.toISOString(),
    counterpartDecidedAt: iso(r.counterpartDecidedAt),
    facultyDecidedAt: iso(r.facultyDecidedAt),
    closedAt: iso(r.closedAt),
    rejectionReason:
      r.status === 'FACULTY_REJECTED'
        ? r.facultyReason
        : r.status === 'COUNTERPART_REJECTED'
          ? r.counterpartReason
          : null,
    cancelReason: r.cancelReason === 'GROUP_CHANGED' ? 'GROUP_CHANGED' : null,
  };
}

/** The faculty review view (§14.5): ids, current groups, and whether it is still valid. */
export function toSwapStaffView(
  r: SwapWithParties,
  current: ReadonlyMap<string, GroupRef>,
): GroupSwapStaffView {
  const base = toSwapView(r, null);
  const requesterNow = current.get(r.requesterId) ?? null;
  const counterpartNow = current.get(r.counterpartId) ?? null;
  return {
    ...base,
    requester: { ...base.requester, studentId: r.requesterId, currentGroup: requesterNow },
    counterpart: { ...base.counterpart, studentId: r.counterpartId, currentGroup: counterpartNow },
    stale:
      (OPEN_GROUP_SWAP_STATUSES as readonly string[]).includes(r.status) &&
      (requesterNow?.id !== r.requesterGroupId || counterpartNow?.id !== r.counterpartGroupId),
  };
}

/** Current groups of students (one active membership each, §5). */
export async function currentGroups(
  db: Tx | { groupMembership: Tx['groupMembership'] },
  studentIds: Iterable<string>,
): Promise<Map<string, GroupRef>> {
  const ids = [...new Set(studentIds)];
  if (ids.length === 0) return new Map();
  const rows = await db.groupMembership.findMany({
    where: { studentId: { in: ids }, endedAt: null },
    select: { studentId: true, group: { select: { id: true, name: true } } },
  });
  return new Map(rows.map((m) => [m.studentId, m.group]));
}

/** Locks both students' records in a fixed order (no deadlocks between requests). */
export async function lockStudents(tx: Tx, ids: string[]): Promise<void> {
  const sorted = [...new Set(ids)].sort();
  for (const id of sorted) {
    await tx.$queryRaw`SELECT 1 FROM "student_profiles" WHERE "id" = ${id}::uuid FOR UPDATE`;
  }
}

/** The ticket of a group swap follows its request (§13.3): open → in progress → closed. */
export async function syncSwapTicket(
  tx: Tx,
  ticketId: string,
  swapStatus: GroupSwapStatus,
  by: { userId: string; role: Role } | null,
  now: Date,
  resolution?: string | null,
): Promise<void> {
  const ticket = await tx.supportTicket.findUniqueOrThrow({
    where: { id: ticketId },
    select: { status: true },
  });
  const next = ticketStatusOfSwap(swapStatus);
  if (ticket.status !== next) {
    await tx.ticketStatusChange.create({
      data: {
        ticketId,
        fromStatus: ticket.status,
        toStatus: next,
        changedById: by?.userId ?? null,
        changedByRole: by?.role ?? null,
        createdAt: now,
      },
    });
  }
  await tx.supportTicket.update({
    where: { id: ticketId },
    data: {
      status: next,
      closedAt: next === 'CLOSED' ? now : null,
      lastActivityAt: now,
      ...(resolution !== undefined ? { resolution } : {}),
    },
  });
}

export async function recordDecision(
  tx: Tx,
  requestId: string,
  kind: GroupSwapDecisionKind,
  decision: GroupSwapDecisionValue,
  actor: AuditActor | null,
  reason: string | null,
  now: Date,
): Promise<void> {
  await tx.groupSwapDecision.create({
    data: {
      requestId,
      kind,
      decision,
      actorId: actor?.id ?? null,
      actorName: actor?.displayName ?? null,
      actorRole: actor?.role ?? null,
      reason,
      createdAt: now,
    },
  });
}

/** Parameters every swap notification carries (rendered in the reader's language). */
export const swapNotificationData = (r: SwapWithParties, extra: Record<string, unknown> = {}) => ({
  requestId: r.id,
  ticketNumber: r.ticket.number,
  requesterName: r.requester.fullName,
  requesterSeat: r.requester.seatNumber,
  counterpartName: r.counterpart.fullName,
  counterpartSeat: r.counterpart.seatNumber,
  requesterGroup: r.requesterGroup.name,
  counterpartGroup: r.counterpartGroup.name,
  ...extra,
});

export async function notifySwap(
  notifications: NotificationsService,
  tx: Tx,
  r: SwapWithParties,
  to: 'REQUESTER' | 'COUNTERPART',
  type: NotificationType,
  extra: Record<string, unknown> = {},
): Promise<void> {
  const userId = to === 'REQUESTER' ? r.requester.userId : r.counterpart.userId;
  if (!userId) return;
  await notifications.notify(tx, [userId], {
    type,
    data: swapNotificationData(r, extra),
    link: `/group-swaps/${r.id}`,
    dedupeKey: `${type}:${r.id}`,
  });
}

/**
 * Closes the open requests of a student whose group changed by any other
 * means (a faculty move, an import, a verification): they were made for groups
 * the student is no longer in (§14.2, "not already moved"). Both students are
 * told. Runs inside the transaction that changes the membership.
 */
export async function cancelOpenSwapsOf(
  tx: Tx,
  deps: { audit: AuditService; notifications: NotificationsService },
  params: { studentId: string; actor: AuditActor | null; context?: RequestContext | null },
): Promise<number> {
  const open = await tx.groupSwapRequest.findMany({
    where: {
      status: { in: [...OPEN_GROUP_SWAP_STATUSES] },
      OR: [{ requesterId: params.studentId }, { counterpartId: params.studentId }],
    },
  });
  const now = new Date();
  for (const row of open) {
    const r = await withParties(tx, row);
    await tx.groupSwapRequest.update({
      where: { id: r.id },
      data: { status: 'CANCELLED', cancelReason: 'GROUP_CHANGED', closedAt: now },
    });
    await syncSwapTicket(tx, r.ticketId, 'CANCELLED', null, now);
    await recordDecision(tx, r.id, 'SYSTEM', 'CANCELLED', null, 'GROUP_CHANGED', now);
    await deps.audit.record(
      {
        actor: params.actor,
        action: 'group_swap.cancelled',
        resourceType: 'group_swap',
        resourceId: r.id,
        outcome: 'SUCCESS',
        reason: 'GROUP_CHANGED',
        before: { status: r.status },
        after: { status: 'CANCELLED' },
        metadata: { studentWhoseGroupChanged: params.studentId },
        context: params.context ?? null,
      },
      tx,
    );
    for (const to of ['REQUESTER', 'COUNTERPART'] as const) {
      await notifySwap(deps.notifications, tx, r, to, 'group_swap.cancelled');
    }
  }
  return open.length;
}
