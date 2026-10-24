import { Injectable } from '@nestjs/common';
import {
  type CreateGroupSwapRequest,
  type GroupSwapEvent,
  type GroupSwapHistoryEntry,
  type GroupSwapStaffView,
  type GroupSwapView,
  type ListGroupSwapHistoryResponse,
  type ListGroupSwapsQuery,
  type ListGroupSwapsResponse,
  type SwapTargetsResponse,
  nameConsistentWith,
  nextGroupSwapStatus,
  OPEN_GROUP_SWAP_STATUSES,
  PROGRAM_TIME_ZONE,
  zonedToUtc,
  addDays,
} from '@ftms/core';
import { AuditService } from '../audit/audit.service';
import { actorOf, type AuthPrincipal } from '../auth/principal';
import { Errors } from '../common/api-exception';
import { Clock } from '../common/clock';
import { dbViolation } from '../common/db-errors';
import { type RequestContext } from '../common/request-context';
import { type Prisma } from '../generated/prisma/client';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';
import { rateLimitKey, RateLimiter } from '../rate-limit/rate-limiter';
import { GroupsService } from '../students/groups.service';
import { StudentErrors } from '../students/student-errors';
import { RequestErrors } from './requests-errors';
import {
  currentGroups,
  lockStudents,
  notifySwap,
  recordDecision,
  SWAP_INCLUDE,
  type SwapWithParties,
  syncSwapTicket,
  toSwapStaffView,
  toSwapView,
  withParties,
} from './swap-steps';

type Tx = Prisma.TransactionClient;

/** Requests per student per hour (each attempt counts: no seat-number probing). */
const REQUEST_LIMIT = { limit: 10, windowSeconds: 3600 };

/**
 * Mutual group swaps (§14): a student asks a student of another group; the
 * counterpart consents or declines; a faculty member then approves — which
 * exchanges both groups in one transaction — or rejects with a reason. The
 * state machine lives in @ftms/core and is enforced again by the database.
 */
@Injectable()
export class GroupSwapsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    private readonly groups: GroupsService,
    private readonly limiter: RateLimiter,
    private readonly clock: Clock,
  ) {}

  private async ownRecord(principal: AuthPrincipal, db: Tx | PrismaService = this.prisma) {
    const record = await db.studentProfile.findUnique({
      where: { userId: principal.userId },
      select: { id: true, fullName: true, seatNumber: true },
    });
    if (!record) throw Errors.forbidden();
    return record;
  }

  /* ─────────────────────────── step 1: submit (§14.3) ─────────────────────────── */

  async create(
    principal: AuthPrincipal,
    input: CreateGroupSwapRequest,
    context: RequestContext,
  ): Promise<GroupSwapView> {
    const key = rateLimitKey('swap-request-user', principal.userId);
    const hit = await this.limiter.hit(key, REQUEST_LIMIT.windowSeconds);
    if (hit.count > REQUEST_LIMIT.limit) {
      throw Errors.rateLimited(hit.resetInSeconds || REQUEST_LIMIT.windowSeconds);
    }

    const now = this.clock.now();
    let id: string;
    try {
      id = await this.prisma.$transaction(async (tx) => {
        const me = await this.ownRecord(principal, tx);
        const membership = await tx.groupMembership.findFirst({
          where: { studentId: me.id, endedAt: null },
        });
        if (!membership) throw RequestErrors.noGroup();
        const myMembership = {
          groupId: membership.groupId,
          group: await tx.trainingGroup.findUniqueOrThrow({ where: { id: membership.groupId } }),
        };

        const target = await tx.trainingGroup.findUnique({ where: { id: input.targetGroupId } });
        if (!target) throw Errors.notFound('Group');
        if (target.archivedAt) throw StudentErrors.groupArchived();
        if (target.id === myMembership.groupId) throw RequestErrors.sameGroup();
        if (input.counterpartSeatNumber === me.seatNumber) throw RequestErrors.self();

        // The counterpart: a student with an active account, now in the target group.
        // One query at a time inside the transaction (no relation includes).
        const counterpart = await tx.studentProfile.findUnique({
          where: { seatNumber: input.counterpartSeatNumber },
          select: { id: true, fullName: true, userId: true },
        });
        const account = counterpart?.userId
          ? await tx.user.findUnique({
              where: { id: counterpart.userId },
              select: { status: true },
            })
          : null;
        const theirMembership = counterpart
          ? await tx.groupMembership.findFirst({
              where: { studentId: counterpart.id, endedAt: null },
              select: { groupId: true },
            })
          : null;
        const valid =
          counterpart !== null &&
          account?.status === 'ACTIVE' &&
          theirMembership?.groupId === target.id &&
          (!input.counterpartName ||
            nameConsistentWith(input.counterpartName, counterpart.fullName));
        if (!valid || !counterpart) throw RequestErrors.counterpartNotFound();

        // Neither student may be in another open request (§14.2); locked first.
        await lockStudents(tx, [me.id, counterpart.id]);
        const busy = await tx.groupSwapRequest.count({
          where: {
            status: { in: [...OPEN_GROUP_SWAP_STATUSES] },
            OR: [
              { requesterId: { in: [me.id, counterpart.id] } },
              { counterpartId: { in: [me.id, counterpart.id] } },
            ],
          },
        });
        if (busy > 0) throw RequestErrors.conflict();

        const ticket = await tx.supportTicket.create({
          data: {
            studentId: me.id,
            createdById: principal.userId,
            category: 'GROUP_SWAP',
            subject: `${myMembership.group.name} ⇄ ${target.name}`,
            description: input.note ?? `${myMembership.group.name} ⇄ ${target.name}`,
            status: 'OPEN',
            lastActivityAt: now,
            createdAt: now,
          },
        });
        await tx.ticketStatusChange.create({
          data: {
            ticketId: ticket.id,
            fromStatus: null,
            toStatus: 'OPEN',
            changedById: principal.userId,
            changedByRole: principal.role,
            createdAt: now,
          },
        });
        const created = await withParties(
          tx,
          await tx.groupSwapRequest.create({
            data: {
              ticketId: ticket.id,
              requesterId: me.id,
              requesterGroupId: myMembership.groupId,
              counterpartId: counterpart.id,
              counterpartGroupId: target.id,
              note: input.note ?? null,
              createdAt: now,
            },
          }),
        );
        await this.audit.record(
          {
            actor: actorOf(principal),
            action: 'group_swap.requested',
            resourceType: 'group_swap',
            resourceId: created.id,
            outcome: 'SUCCESS',
            after: {
              ticketNumber: ticket.number,
              requester: { seatNumber: me.seatNumber, group: myMembership.group.name },
              counterpart: { seatNumber: input.counterpartSeatNumber, group: target.name },
              nameChecked: Boolean(input.counterpartName),
            },
            context,
          },
          tx,
        );
        await notifySwap(this.notifications, tx, created, 'COUNTERPART', 'group_swap.requested');
        return created.id;
      });
    } catch (error) {
      throw this.mapViolation(error);
    }
    return this.studentView(principal, id);
  }

  /** A trigger refusal raced past the up-front checks: answer with the same codes. */
  private mapViolation(error: unknown): unknown {
    const violation = dbViolation(error);
    if (violation?.kind !== 'check') return error;
    if (/already takes part/.test(violation.message ?? '')) return RequestErrors.conflict();
    if (/no longer in the groups|archived/.test(violation.message ?? ''))
      return RequestErrors.stale();
    return error;
  }

  /* ─────────────────────────── reading ─────────────────────────── */

  private async load(db: Tx | PrismaService, id: string): Promise<SwapWithParties> {
    const r = await db.groupSwapRequest.findUnique({ where: { id } });
    if (!r) throw Errors.notFound('Request');
    return withParties(db, r);
  }

  /** A participant's view; anyone else gets 404 (requests of others do not exist for them). */
  async studentView(principal: AuthPrincipal, id: string): Promise<GroupSwapView> {
    const me = await this.ownRecord(principal);
    const r = await this.load(this.prisma, id);
    if (r.requesterId === me.id) return toSwapView(r, 'REQUESTER');
    if (r.counterpartId === me.id) return toSwapView(r, 'COUNTERPART');
    throw Errors.notFound('Request');
  }

  async staffView(id: string): Promise<GroupSwapStaffView> {
    const r = await this.load(this.prisma, id);
    const current = await currentGroups(this.prisma, [r.requesterId, r.counterpartId]);
    return toSwapStaffView(r, current);
  }

  /** The requester's group and the active groups they may ask for (§14.1). */
  async targets(principal: AuthPrincipal): Promise<SwapTargetsResponse> {
    const me = await this.ownRecord(principal);
    const membership = await this.prisma.groupMembership.findFirst({
      where: { studentId: me.id, endedAt: null },
      select: { group: { select: { id: true, name: true } } },
    });
    if (!membership) return { current: null, targets: [] };
    const targets = await this.prisma.trainingGroup.findMany({
      where: { archivedAt: null, id: { not: membership.group.id } },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    });
    return { current: membership.group, targets };
  }

  /** The student's requests, sent and received, newest first. */
  async listOwn(principal: AuthPrincipal): Promise<GroupSwapView[]> {
    const me = await this.ownRecord(principal);
    const rows = await this.prisma.groupSwapRequest.findMany({
      where: { OR: [{ requesterId: me.id }, { counterpartId: me.id }] },
      include: SWAP_INCLUDE,
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    return rows.map((r) => toSwapView(r, r.requesterId === me.id ? 'REQUESTER' : 'COUNTERPART'));
  }

  private where(query: ListGroupSwapsQuery): Prisma.GroupSwapRequestWhereInput {
    const where: Prisma.GroupSwapRequestWhereInput = {};
    if (query.status) where.status = query.status;
    if (query.from || query.to) {
      where.createdAt = {
        ...(query.from ? { gte: zonedToUtc(query.from, '00:00', PROGRAM_TIME_ZONE) } : {}),
        ...(query.to ? { lt: zonedToUtc(addDays(query.to, 1), '00:00', PROGRAM_TIME_ZONE) } : {}),
      };
    }
    const q = query.q?.trim();
    if (q) {
      const match: Prisma.StudentProfileWhereInput = {
        OR: [
          { seatNumber: { contains: q.toUpperCase() } },
          { fullName: { contains: q, mode: 'insensitive' } },
        ],
      };
      where.OR = [{ requester: match }, { counterpart: match }];
    }
    return where;
  }

  /** The faculty queue and list (§14.5). */
  async list(query: ListGroupSwapsQuery): Promise<ListGroupSwapsResponse> {
    const where = this.where(query);
    const [total, rows] = await Promise.all([
      this.prisma.groupSwapRequest.count({ where }),
      this.prisma.groupSwapRequest.findMany({
        where,
        include: SWAP_INCLUDE,
        orderBy: { createdAt: query.status === 'PENDING_FACULTY' ? 'asc' : 'desc' },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
    ]);
    const current = await currentGroups(
      this.prisma,
      rows.flatMap((r) => [r.requesterId, r.counterpartId]),
    );
    return {
      items: rows.map((r) => toSwapStaffView(r, current)),
      total,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  /** The Training Director's audit view (§14.7): every decision and who made it. */
  async history(query: ListGroupSwapsQuery): Promise<ListGroupSwapHistoryResponse> {
    const where = this.where(query);
    const [total, rows] = await Promise.all([
      this.prisma.groupSwapRequest.count({ where }),
      this.prisma.groupSwapRequest.findMany({
        where,
        include: { ...SWAP_INCLUDE, decisions: { orderBy: { createdAt: 'asc' } } },
        orderBy: { createdAt: 'desc' },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
    ]);
    const current = await currentGroups(
      this.prisma,
      rows.flatMap((r) => [r.requesterId, r.counterpartId]),
    );
    const items: GroupSwapHistoryEntry[] = rows.map((r) => ({
      ...toSwapStaffView(r, current),
      decisions: r.decisions.map((d) => ({
        kind: d.kind,
        decision: d.decision,
        by:
          d.actorName || d.actorId ? { id: d.actorId, name: d.actorName, role: d.actorRole } : null,
        reason: d.reason,
        at: d.createdAt.toISOString(),
      })),
    }));
    return { items, total, page: query.page, pageSize: query.pageSize };
  }

  /* ─────────────────────────── transitions ─────────────────────────── */

  /**
   * Runs one transition under a row lock. When a student's group changed since
   * the request (a race the membership hook did not see), the request is closed
   * as CANCELLED and the caller gets SWAP_STALE.
   */
  private async transition(
    principal: AuthPrincipal,
    id: string,
    event: GroupSwapEvent,
    who: 'REQUESTER' | 'COUNTERPART' | 'FACULTY',
    apply: (tx: Tx, r: SwapWithParties, now: Date) => Promise<void>,
  ): Promise<void> {
    const me = who === 'FACULTY' ? null : await this.ownRecord(principal);
    const now = this.clock.now();
    let stale = false;
    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT 1 FROM "group_swap_requests" WHERE "id" = ${id}::uuid FOR UPDATE`;
        const r = await this.load(tx, id);
        if (me) {
          const party =
            r.requesterId === me.id
              ? 'REQUESTER'
              : r.counterpartId === me.id
                ? 'COUNTERPART'
                : null;
          if (!party) throw Errors.notFound('Request');
          if (party !== who) throw Errors.forbidden();
        }
        if (!nextGroupSwapStatus(r.status, event)) throw RequestErrors.notAllowed(r.status);

        if (event === 'COUNTERPART_ACCEPT' || event === 'FACULTY_APPROVE') {
          await lockStudents(tx, [r.requesterId, r.counterpartId]);
          const current = await currentGroups(tx, [r.requesterId, r.counterpartId]);
          const archived = await tx.trainingGroup.count({
            where: {
              id: { in: [r.requesterGroupId, r.counterpartGroupId] },
              archivedAt: { not: null },
            },
          });
          if (
            current.get(r.requesterId)?.id !== r.requesterGroupId ||
            current.get(r.counterpartId)?.id !== r.counterpartGroupId ||
            archived > 0
          ) {
            await this.invalidate(tx, r, principal, now);
            stale = true;
            return;
          }
        }
        await apply(tx, r, now);
      });
    } catch (error) {
      throw this.mapViolation(error);
    }
    if (stale) throw RequestErrors.stale();
  }

  private async invalidate(tx: Tx, r: SwapWithParties, principal: AuthPrincipal, now: Date) {
    await tx.groupSwapRequest.update({
      where: { id: r.id },
      data: { status: 'CANCELLED', cancelReason: 'GROUP_CHANGED', closedAt: now },
    });
    await syncSwapTicket(tx, r.ticketId, 'CANCELLED', null, now);
    await recordDecision(tx, r.id, 'SYSTEM', 'CANCELLED', null, 'GROUP_CHANGED', now);
    await this.audit.record(
      {
        actor: actorOf(principal),
        action: 'group_swap.cancelled',
        resourceType: 'group_swap',
        resourceId: r.id,
        outcome: 'SUCCESS',
        reason: 'GROUP_CHANGED',
        before: { status: r.status },
        after: { status: 'CANCELLED' },
      },
      tx,
    );
    for (const to of ['REQUESTER', 'COUNTERPART'] as const) {
      await notifySwap(this.notifications, tx, r, to, 'group_swap.cancelled');
    }
  }

  private auditTransition(
    tx: Tx,
    principal: AuthPrincipal,
    r: SwapWithParties,
    action: string,
    after: string,
    context: RequestContext,
    reason: string | null = null,
    extra: Record<string, unknown> = {},
  ) {
    return this.audit.record(
      {
        actor: actorOf(principal),
        action,
        resourceType: 'group_swap',
        resourceId: r.id,
        outcome: 'SUCCESS',
        reason,
        before: { status: r.status },
        after: { status: after, ...extra },
        metadata: {
          ticketNumber: r.ticket.number,
          requester: { seatNumber: r.requester.seatNumber, group: r.requesterGroup.name },
          counterpart: { seatNumber: r.counterpart.seatNumber, group: r.counterpartGroup.name },
        },
        context,
      },
      tx,
    );
  }

  /* ─────────────────────────── step 2: the counterpart (§14.4) ─────────────────────────── */

  /** Consent: the request goes to the faculty; nobody moves yet. */
  async accept(
    principal: AuthPrincipal,
    id: string,
    context: RequestContext,
  ): Promise<GroupSwapView> {
    await this.transition(
      principal,
      id,
      'COUNTERPART_ACCEPT',
      'COUNTERPART',
      async (tx, r, now) => {
        await tx.groupSwapRequest.update({
          where: { id },
          data: { status: 'PENDING_FACULTY', counterpartDecidedAt: now },
        });
        await syncSwapTicket(tx, r.ticketId, 'PENDING_FACULTY', principal, now);
        await recordDecision(tx, id, 'COUNTERPART', 'ACCEPTED', actorOf(principal), null, now);
        await this.auditTransition(
          tx,
          principal,
          r,
          'group_swap.counterpart_accepted',
          'PENDING_FACULTY',
          context,
        );
        await notifySwap(this.notifications, tx, r, 'REQUESTER', 'group_swap.accepted');
        await notifySwap(this.notifications, tx, r, 'COUNTERPART', 'group_swap.under_review');
      },
    );
    return this.studentView(principal, id);
  }

  async decline(
    principal: AuthPrincipal,
    id: string,
    reason: string | undefined,
    context: RequestContext,
  ): Promise<GroupSwapView> {
    await this.transition(
      principal,
      id,
      'COUNTERPART_REJECT',
      'COUNTERPART',
      async (tx, r, now) => {
        await tx.groupSwapRequest.update({
          where: { id },
          data: {
            status: 'COUNTERPART_REJECTED',
            counterpartDecidedAt: now,
            counterpartReason: reason ?? null,
            closedAt: now,
          },
        });
        await syncSwapTicket(tx, r.ticketId, 'COUNTERPART_REJECTED', principal, now);
        await recordDecision(
          tx,
          id,
          'COUNTERPART',
          'REJECTED',
          actorOf(principal),
          reason ?? null,
          now,
        );
        await this.auditTransition(
          tx,
          principal,
          r,
          'group_swap.counterpart_rejected',
          'COUNTERPART_REJECTED',
          context,
          reason ?? null,
        );
        await notifySwap(
          this.notifications,
          tx,
          r,
          'REQUESTER',
          'group_swap.counterpart_rejected',
          {
            reason: reason ?? null,
          },
        );
      },
    );
    return this.studentView(principal, id);
  }

  /** The requester takes the request back while it is still open. */
  async withdraw(
    principal: AuthPrincipal,
    id: string,
    reason: string | undefined,
    context: RequestContext,
  ): Promise<GroupSwapView> {
    await this.transition(principal, id, 'WITHDRAW', 'REQUESTER', async (tx, r, now) => {
      await tx.groupSwapRequest.update({
        where: { id },
        data: { status: 'WITHDRAWN', closedAt: now },
      });
      await syncSwapTicket(tx, r.ticketId, 'WITHDRAWN', principal, now);
      await recordDecision(
        tx,
        id,
        'REQUESTER',
        'WITHDRAWN',
        actorOf(principal),
        reason ?? null,
        now,
      );
      await this.auditTransition(
        tx,
        principal,
        r,
        'group_swap.withdrawn',
        'WITHDRAWN',
        context,
        reason ?? null,
      );
      await notifySwap(this.notifications, tx, r, 'COUNTERPART', 'group_swap.withdrawn');
    });
    return this.studentView(principal, id);
  }

  /* ─────────────────────────── step 3: the faculty (§14.5) ─────────────────────────── */

  /**
   * Re-checks both memberships under lock and exchanges the two groups in one
   * transaction; the database refuses to commit an approval without the
   * complete exchange.
   */
  async approve(
    principal: AuthPrincipal,
    id: string,
    context: RequestContext,
  ): Promise<GroupSwapStaffView> {
    await this.transition(principal, id, 'FACULTY_APPROVE', 'FACULTY', async (tx, r, now) => {
      await tx.groupSwapRequest.update({
        where: { id },
        data: {
          status: 'APPROVED',
          facultyDecidedAt: now,
          facultyDecidedById: principal.userId,
          closedAt: now,
        },
      });
      const actor = actorOf(principal);
      await this.groups.moveInTx(tx, {
        studentId: r.requesterId,
        groupId: r.counterpartGroupId,
        source: 'SWAP',
        actor,
        context,
        metadata: { swapRequestId: id },
      });
      await this.groups.moveInTx(tx, {
        studentId: r.counterpartId,
        groupId: r.requesterGroupId,
        source: 'SWAP',
        actor,
        context,
        metadata: { swapRequestId: id },
      });
      await syncSwapTicket(tx, r.ticketId, 'APPROVED', principal, now, null);
      await recordDecision(tx, id, 'FACULTY', 'APPROVED', actor, null, now);
      await this.auditTransition(
        tx,
        principal,
        r,
        'group_swap.approved',
        'APPROVED',
        context,
        null,
        {
          requesterGroup: r.counterpartGroup.name,
          counterpartGroup: r.requesterGroup.name,
        },
      );
      await notifySwap(this.notifications, tx, r, 'REQUESTER', 'group_swap.approved', {
        newGroup: r.counterpartGroup.name,
      });
      await notifySwap(this.notifications, tx, r, 'COUNTERPART', 'group_swap.approved', {
        newGroup: r.requesterGroup.name,
      });
    });
    return this.staffView(id);
  }

  /** Rejection keeps both groups; the mandatory reason is shown to both students. */
  async reject(
    principal: AuthPrincipal,
    id: string,
    reason: string,
    context: RequestContext,
  ): Promise<GroupSwapStaffView> {
    await this.transition(principal, id, 'FACULTY_REJECT', 'FACULTY', async (tx, r, now) => {
      await tx.groupSwapRequest.update({
        where: { id },
        data: {
          status: 'FACULTY_REJECTED',
          facultyDecidedAt: now,
          facultyDecidedById: principal.userId,
          facultyReason: reason,
          closedAt: now,
        },
      });
      await syncSwapTicket(tx, r.ticketId, 'FACULTY_REJECTED', principal, now, reason);
      await recordDecision(tx, id, 'FACULTY', 'REJECTED', actorOf(principal), reason, now);
      await this.auditTransition(
        tx,
        principal,
        r,
        'group_swap.rejected',
        'FACULTY_REJECTED',
        context,
        reason,
      );
      for (const to of ['REQUESTER', 'COUNTERPART'] as const) {
        await notifySwap(this.notifications, tx, r, to, 'group_swap.rejected', { reason });
      }
    });
    return this.staffView(id);
  }
}
