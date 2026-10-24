import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import {
  type CreateTicketRequest,
  type ListTicketsQuery,
  type ListTicketsResponse,
  type Role,
  TICKET_FILE_MAX_BYTES,
  TICKET_FILE_TYPES,
  TICKET_FILES_PER_POST,
  TICKET_MAX_FILES,
  type TicketActor,
  type TicketAttachment,
  type TicketDetail,
  type TicketMessageRequest,
  type TicketStatus,
  type TicketSummary,
  type UpdateTicketStatusRequest,
} from '@ftms/core';
import { AuditService } from '../audit/audit.service';
import { actorOf, type AuthPrincipal } from '../auth/principal';
import { Errors } from '../common/api-exception';
import { BackgroundTasks } from '../common/background-tasks.service';
import { Clock } from '../common/clock';
import { type RequestContext } from '../common/request-context';
import { type Prisma } from '../generated/prisma/client';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';
import { rateLimitKey, RateLimiter } from '../rate-limit/rate-limiter';
import { cleanFileName, sniffFileType } from '../scheduling/file-sniffing';
import { SchedulingErrors } from '../scheduling/scheduling-errors';
import { STORAGE_BUCKETS } from '../storage/buckets';
import { FileStore } from '../storage/file-store';
import { StudentErrors } from '../students/student-errors';
import { RequestErrors } from './requests-errors';
import { SWAP_INCLUDE, toSwapView } from './swap-steps';

type Tx = Prisma.TransactionClient;

export interface UploadedTicketFile {
  originalname: string;
  size: number;
  buffer: Buffer;
}

interface CheckedFile {
  file: UploadedTicketFile;
  contentType: string;
  extension: string;
}

const LIMITS = {
  create: { limit: 10, windowSeconds: 3600 },
  message: { limit: 60, windowSeconds: 3600 },
};

const BUCKET = STORAGE_BUCKETS.ticketAttachments.id;

const SUMMARY_INCLUDE = {
  student: {
    select: {
      id: true,
      fullName: true,
      seatNumber: true,
      memberships: {
        where: { endedAt: null },
        select: { group: { select: { id: true, name: true } } },
      },
    },
  },
  groupSwap: { select: { status: true } },
} as const satisfies Prisma.SupportTicketInclude;

const DETAIL_INCLUDE = {
  ...SUMMARY_INCLUDE,
  messages: {
    orderBy: { createdAt: 'asc' },
    include: { author: { select: { displayName: true } } },
  },
  attachments: { orderBy: { createdAt: 'asc' } },
  statusChanges: {
    orderBy: { createdAt: 'asc' },
    include: { changedBy: { select: { displayName: true } } },
  },
  groupSwap: { include: SWAP_INCLUDE },
} as const satisfies Prisma.SupportTicketInclude;

type TicketWithSummary = Prisma.SupportTicketGetPayload<{ include: typeof SUMMARY_INCLUDE }>;
type TicketWithDetail = Prisma.SupportTicketGetPayload<{ include: typeof DETAIL_INCLUDE }>;

/**
 * Support tickets (§13): complaints, suggestions and questions, with a
 * conversation, attachments in private storage and a status history. A
 * student reads only their own tickets and never learns which staff member
 * answered or decided (§13.3); staff need `tickets.process`.
 */
@Injectable()
export class TicketsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    private readonly store: FileStore,
    private readonly background: BackgroundTasks,
    private readonly limiter: RateLimiter,
    private readonly clock: Clock,
  ) {}

  /* ─────────────────────────── helpers ─────────────────────────── */

  private async limit(principal: AuthPrincipal, kind: keyof typeof LIMITS): Promise<void> {
    const { limit, windowSeconds } = LIMITS[kind];
    const state = await this.limiter.hit(
      rateLimitKey(`ticket-${kind}-user`, principal.userId),
      windowSeconds,
    );
    if (state.count > limit) throw Errors.rateLimited(state.resetInSeconds || windowSeconds);
  }

  private async ownRecordId(principal: AuthPrincipal): Promise<string> {
    const record = await this.prisma.studentProfile.findUnique({
      where: { userId: principal.userId },
      select: { id: true },
    });
    if (!record) throw Errors.forbidden();
    return record.id;
  }

  /** Content-checked, bounded files (§16.3); nothing is stored yet. */
  private checkFiles(files: UploadedTicketFile[] | undefined): CheckedFile[] {
    const list = (files ?? []).filter((f) => f.size > 0);
    if (list.length > TICKET_FILES_PER_POST)
      throw SchedulingErrors.tooManyFiles(TICKET_FILES_PER_POST);
    return list.map((file) => {
      if (file.size > TICKET_FILE_MAX_BYTES) throw StudentErrors.fileTooLarge();
      const type = sniffFileType(file.buffer);
      if (!type || !TICKET_FILE_TYPES.includes(type.contentType)) {
        throw SchedulingErrors.fileTypeNotAllowed();
      }
      return { file, contentType: type.contentType, extension: type.extension };
    });
  }

  /** Objects are named here, never by the client: `tickets/<folder>/<random>.<ext>`. */
  private async storeFiles(folder: string, files: CheckedFile[]) {
    if (files.length > 0 && !this.store.driver) throw SchedulingErrors.storageUnavailable();
    const stored: { path: string; checked: CheckedFile }[] = [];
    try {
      for (const checked of files) {
        const path = `tickets/${folder}/${randomUUID()}.${checked.extension}`;
        await this.store.put(BUCKET, path, checked.file.buffer, checked.contentType);
        stored.push({ path, checked });
      }
    } catch (error) {
      this.removeLater(stored.map((s) => s.path));
      throw error;
    }
    return stored;
  }

  private removeLater(paths: string[]): void {
    if (paths.length === 0) return;
    this.background.run('remove ticket files', () => this.store.remove(BUCKET, paths));
  }

  private async createAttachments(
    tx: Tx,
    ticketId: string,
    messageId: string | null,
    uploadedById: string,
    stored: { path: string; checked: CheckedFile }[],
  ): Promise<void> {
    if (stored.length === 0) return;
    const existing = await tx.ticketAttachment.count({ where: { ticketId } });
    if (existing + stored.length > TICKET_MAX_FILES)
      throw SchedulingErrors.tooManyFiles(TICKET_MAX_FILES);
    await tx.ticketAttachment.createMany({
      data: stored.map(({ path, checked }) => ({
        ticketId,
        messageId,
        uploadedById,
        bucket: BUCKET,
        storagePath: path,
        fileName: cleanFileName(checked.file.originalname, `file.${checked.extension}`),
        contentType: checked.contentType,
        sizeBytes: checked.file.size,
      })),
    });
  }

  private actor(role: Role | null, name: string | null, forStudent: boolean): TicketActor {
    if (role === null) return { kind: 'SYSTEM', name: null };
    if (role === 'STUDENT') return { kind: 'STUDENT', name };
    return { kind: 'STAFF', name: forStudent ? null : name };
  }

  private toSummary(t: TicketWithSummary, staff: boolean): TicketSummary {
    return {
      id: t.id,
      number: t.number,
      category: t.category,
      subject: t.subject,
      status: t.status,
      createdAt: t.createdAt.toISOString(),
      lastActivityAt: t.lastActivityAt.toISOString(),
      student: staff
        ? {
            id: t.student.id,
            fullName: t.student.fullName,
            seatNumber: t.student.seatNumber,
            group: t.student.memberships[0]?.group ?? null,
          }
        : null,
      swapStatus: t.groupSwap?.status ?? null,
    };
  }

  private async link(a: TicketWithDetail['attachments'][number]): Promise<TicketAttachment> {
    return {
      id: a.id,
      fileName: a.fileName,
      contentType: a.contentType,
      sizeBytes: a.sizeBytes,
      url: this.store.driver
        ? await this.store.link(BUCKET, a.storagePath, a.contentType, a.fileName)
        : '',
    };
  }

  private async toDetail(t: TicketWithDetail, staff: boolean): Promise<TicketDetail> {
    const forStudent = !staff;
    const messages = t.messages.filter((m) => staff || !m.internal);
    const visibleMessageIds = new Set(messages.map((m) => m.id));
    const attachments = t.attachments.filter(
      (a) => a.messageId === null || visibleMessageIds.has(a.messageId),
    );
    const links = new Map(
      await Promise.all(attachments.map(async (a) => [a.id, await this.link(a)] as const)),
    );
    const summary = t as unknown as TicketWithSummary;
    return {
      ...this.toSummary(
        { ...summary, groupSwap: t.groupSwap ? { status: t.groupSwap.status } : null },
        staff,
      ),
      description: t.description,
      attachments: attachments.filter((a) => a.messageId === null).map((a) => links.get(a.id)!),
      messages: messages.map((m) => ({
        id: m.id,
        author: this.actor(m.authorRole, m.author.displayName, forStudent),
        body: m.body,
        internal: m.internal,
        createdAt: m.createdAt.toISOString(),
        attachments: attachments.filter((a) => a.messageId === m.id).map((a) => links.get(a.id)!),
      })),
      history: t.statusChanges.map((c) => ({
        at: c.createdAt.toISOString(),
        from: c.fromStatus,
        to: c.toStatus,
        note: c.note,
        by: this.actor(c.changedByRole, c.changedBy?.displayName ?? null, forStudent),
      })),
      resolution: t.resolution,
      swap: t.groupSwap ? toSwapView(t.groupSwap, staff ? null : 'REQUESTER') : null,
    };
  }

  /**
   * The ticket as the caller may see it: its owner, or staff with
   * `tickets.process`. Anyone else gets 404 (others' tickets do not exist).
   */
  private async loadFor(
    principal: AuthPrincipal,
    id: string,
  ): Promise<{ ticket: TicketWithDetail; staff: boolean }> {
    const ticket = await this.prisma.supportTicket.findUnique({
      where: { id },
      include: DETAIL_INCLUDE,
    });
    if (!ticket) throw Errors.notFound('Ticket');
    if (principal.role === 'STUDENT') {
      if (ticket.studentId !== (await this.ownRecordId(principal))) throw Errors.notFound('Ticket');
      return { ticket, staff: false };
    }
    if (!principal.permissions.has('tickets.process')) throw Errors.forbidden();
    return { ticket, staff: true };
  }

  /* ─────────────────────────── students ─────────────────────────── */

  async create(
    principal: AuthPrincipal,
    input: CreateTicketRequest,
    files: UploadedTicketFile[] | undefined,
    context: RequestContext,
  ): Promise<TicketDetail> {
    await this.limit(principal, 'create');
    const studentId = await this.ownRecordId(principal);
    const checked = this.checkFiles(files);
    const stored = await this.storeFiles(randomUUID(), checked);
    const now = this.clock.now();
    let id: string;
    try {
      id = await this.prisma.$transaction(async (tx) => {
        const ticket = await tx.supportTicket.create({
          data: {
            studentId,
            createdById: principal.userId,
            category: input.category,
            subject: input.subject,
            description: input.description,
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
        await this.createAttachments(tx, ticket.id, null, principal.userId, stored);
        await this.audit.record(
          {
            actor: actorOf(principal),
            action: 'ticket.created',
            resourceType: 'ticket',
            resourceId: ticket.id,
            outcome: 'SUCCESS',
            after: {
              number: ticket.number,
              category: input.category,
              subject: input.subject,
              attachments: stored.length,
            },
            context,
          },
          tx,
        );
        return ticket.id;
      });
    } catch (error) {
      this.removeLater(stored.map((s) => s.path));
      throw error;
    }
    return this.detail(principal, id);
  }

  async listOwn(principal: AuthPrincipal, query: ListTicketsQuery): Promise<ListTicketsResponse> {
    const studentId = await this.ownRecordId(principal);
    return this.page({ ...this.filters(query), studentId }, query, false);
  }

  /* ─────────────────────────── staff ─────────────────────────── */

  private filters(query: ListTicketsQuery): Prisma.SupportTicketWhereInput {
    const where: Prisma.SupportTicketWhereInput = {};
    if (query.category) where.category = query.category;
    if (query.status) {
      where.status = query.status === 'ACTIVE' ? { in: ['OPEN', 'IN_PROGRESS'] } : query.status;
    }
    return where;
  }

  async list(query: ListTicketsQuery): Promise<ListTicketsResponse> {
    const where = this.filters(query);
    const q = query.q?.trim();
    if (q) {
      const number = /^#?(\d{1,9})$/.exec(q);
      where.OR = [
        ...(number ? [{ number: Number(number[1]) }] : []),
        { subject: { contains: q, mode: 'insensitive' } },
        {
          student: {
            OR: [
              { seatNumber: { contains: q.toUpperCase() } },
              { fullName: { contains: q, mode: 'insensitive' } },
            ],
          },
        },
      ];
    }
    return this.page(where, query, true);
  }

  private async page(
    where: Prisma.SupportTicketWhereInput,
    query: ListTicketsQuery,
    staff: boolean,
  ): Promise<ListTicketsResponse> {
    const [total, rows] = await Promise.all([
      this.prisma.supportTicket.count({ where }),
      this.prisma.supportTicket.findMany({
        where,
        include: SUMMARY_INCLUDE,
        orderBy: [{ lastActivityAt: 'desc' }, { number: 'desc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
    ]);
    return {
      items: rows.map((t) => this.toSummary(t, staff)),
      total,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  async detail(principal: AuthPrincipal, id: string): Promise<TicketDetail> {
    const { ticket, staff } = await this.loadFor(principal, id);
    return this.toDetail(ticket, staff);
  }

  /* ─────────────────────────── conversation ─────────────────────────── */

  /**
   * A reply from the student or the staff, or an internal staff note. A student
   * reply reopens a resolved ticket; the first staff reply marks it in
   * progress. Closed tickets take no messages (staff can reopen them).
   */
  async addMessage(
    principal: AuthPrincipal,
    id: string,
    input: TicketMessageRequest,
    files: UploadedTicketFile[] | undefined,
    context: RequestContext,
  ): Promise<TicketDetail> {
    await this.limit(principal, 'message');
    const { ticket, staff } = await this.loadFor(principal, id);
    if (input.internal && !staff) throw Errors.forbidden();
    if (ticket.status === 'CLOSED') throw RequestErrors.ticketClosed();
    const checked = this.checkFiles(files);
    const stored = await this.storeFiles(id, checked);
    const now = this.clock.now();
    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT 1 FROM "support_tickets" WHERE "id" = ${id}::uuid FOR UPDATE`;
        const current = await tx.supportTicket.findUniqueOrThrow({ where: { id } });
        if (current.status === 'CLOSED') throw RequestErrors.ticketClosed();
        const message = await tx.ticketMessage.create({
          data: {
            ticketId: id,
            authorId: principal.userId,
            authorRole: principal.role,
            body: input.body,
            internal: input.internal,
            createdAt: now,
          },
        });
        await this.createAttachments(tx, id, message.id, principal.userId, stored);

        let next: TicketStatus = current.status;
        if (current.category !== 'GROUP_SWAP' && !input.internal) {
          if (!staff && current.status === 'RESOLVED') next = 'OPEN';
          if (staff && current.status === 'OPEN') next = 'IN_PROGRESS';
        }
        if (next !== current.status) {
          await tx.ticketStatusChange.create({
            data: {
              ticketId: id,
              fromStatus: current.status,
              toStatus: next,
              changedById: principal.userId,
              changedByRole: principal.role,
              createdAt: now,
            },
          });
        }
        await tx.supportTicket.update({
          where: { id },
          data: {
            status: next,
            lastActivityAt: now,
            ...(next === 'OPEN' && current.status === 'RESOLVED' ? { resolution: null } : {}),
          },
        });
        await this.audit.record(
          {
            actor: actorOf(principal),
            action: input.internal ? 'ticket.note_added' : 'ticket.replied',
            resourceType: 'ticket',
            resourceId: id,
            outcome: 'SUCCESS',
            before: next !== current.status ? { status: current.status } : null,
            after: {
              messageId: message.id,
              attachments: stored.length,
              length: input.body.length,
              ...(next !== current.status ? { status: next } : {}),
            },
            metadata: { number: current.number },
            context,
          },
          tx,
        );
        if (staff && !input.internal) {
          const owner = await tx.studentProfile.findUnique({
            where: { id: current.studentId },
            select: { userId: true },
          });
          if (owner?.userId) {
            await this.notifications.notify(tx, [owner.userId], {
              type: 'ticket.replied',
              data: { ticketId: id, number: current.number, subject: current.subject },
              link: `/tickets/${id}`,
              dedupeKey: `ticket.replied:${message.id}`,
            });
          }
        }
      });
    } catch (error) {
      this.removeLater(stored.map((s) => s.path));
      throw error;
    }
    return this.detail(principal, id);
  }

  /**
   * Staff set the status (§13.4); resolving or closing records the outcome the
   * student sees. A group-swap ticket follows its request instead.
   */
  async setStatus(
    principal: AuthPrincipal,
    id: string,
    input: UpdateTicketStatusRequest,
    context: RequestContext,
  ): Promise<TicketDetail> {
    const now = this.clock.now();
    await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1 FROM "support_tickets" WHERE "id" = ${id}::uuid FOR UPDATE`;
      const current = await tx.supportTicket.findUnique({ where: { id } });
      if (!current) throw Errors.notFound('Ticket');
      if (current.category === 'GROUP_SWAP') throw RequestErrors.managedBySwap();
      if (current.status === input.status) throw StudentErrors.noChanges();
      const closing = input.status === 'RESOLVED' || input.status === 'CLOSED';
      const change = await tx.ticketStatusChange.create({
        data: {
          ticketId: id,
          fromStatus: current.status,
          toStatus: input.status,
          changedById: principal.userId,
          changedByRole: principal.role,
          note: input.note ?? null,
          createdAt: now,
        },
      });
      await tx.supportTicket.update({
        where: { id },
        data: {
          status: input.status,
          closedAt: input.status === 'CLOSED' ? now : null,
          resolution: closing ? (input.note ?? current.resolution) : null,
          lastActivityAt: now,
        },
      });
      await this.audit.record(
        {
          actor: actorOf(principal),
          action: 'ticket.status_changed',
          resourceType: 'ticket',
          resourceId: id,
          outcome: 'SUCCESS',
          reason: input.note ?? null,
          before: { status: current.status },
          after: { status: input.status },
          metadata: { number: current.number },
          context,
        },
        tx,
      );
      const owner = await tx.studentProfile.findUnique({
        where: { id: current.studentId },
        select: { userId: true },
      });
      if (owner?.userId) {
        await this.notifications.notify(tx, [owner.userId], {
          type: 'ticket.status_changed',
          data: {
            ticketId: id,
            number: current.number,
            subject: current.subject,
            status: input.status,
            note: input.note ?? null,
          },
          link: `/tickets/${id}`,
          dedupeKey: `ticket.status_changed:${change.id}`,
        });
      }
    });
    return this.detail(principal, id);
  }
}
