import { Injectable } from '@nestjs/common';
import {
  type ListNotificationsQuery,
  type ListNotificationsResponse,
  type Notification,
  NOTIFICATION_TYPES,
  type NotificationType,
} from '@ftms/core';
import { Errors } from '../common/api-exception';
import { type Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';

type Db = Prisma.TransactionClient | PrismaService;

export interface NotificationInput {
  type: NotificationType;
  /** Parameters the reader's app turns into localized text (§18.1). */
  data: Record<string, unknown>;
  /** In-app path of the related visit, request or page. */
  link: string | null;
  /**
   * Identifies the event. With the recipient it is unique, so creating the same
   * notification again (a retried job, a repeated request) is a no-op (§12.1).
   */
  dedupeKey: string;
}

const isKnownType = (type: string): type is NotificationType =>
  (NOTIFICATION_TYPES as readonly string[]).includes(type);

const toNotification = (row: {
  id: string;
  type: string;
  data: Prisma.JsonValue;
  link: string | null;
  createdAt: Date;
  readAt: Date | null;
}): Notification | null =>
  isKnownType(row.type)
    ? {
        id: row.id,
        type: row.type,
        data: (row.data ?? {}) as Record<string, unknown>,
        link: row.link,
        createdAt: row.createdAt.toISOString(),
        readAt: row.readAt?.toISOString() ?? null,
      }
    : null;

/**
 * The single notification writer and reader (§6.4, §12). Feature services call
 * `notify` inside the transaction of the change they report, so a notification
 * exists exactly when the change does.
 */
@Injectable()
export class NotificationsService {
  constructor(private readonly prisma: PrismaService) {}

  /** Creates one notification per distinct recipient; returns how many were new. */
  async notify(db: Db, recipientIds: Iterable<string>, input: NotificationInput): Promise<number> {
    const recipients = [...new Set(recipientIds)];
    if (recipients.length === 0) return 0;
    const result = await db.notification.createMany({
      data: recipients.map((recipientId) => ({
        recipientId,
        type: input.type,
        data: input.data as Prisma.InputJsonObject,
        link: input.link,
        dedupeKey: input.dedupeKey,
      })),
      skipDuplicates: true,
    });
    return result.count;
  }

  /**
   * Student accounts currently in each group (§5: one active group per student).
   * Students without an account have nobody to notify yet.
   */
  async studentAccountsByGroup(db: Db, groupIds: Iterable<string>): Promise<Map<string, string[]>> {
    const ids = [...new Set(groupIds)];
    const byGroup = new Map<string, string[]>(ids.map((id) => [id, []]));
    if (ids.length === 0) return byGroup;
    const rows = await db.groupMembership.findMany({
      where: { groupId: { in: ids }, endedAt: null, student: { userId: { not: null } } },
      select: { groupId: true, student: { select: { userId: true } } },
    });
    for (const row of rows) {
      if (row.student.userId) byGroup.get(row.groupId)?.push(row.student.userId);
    }
    return byGroup;
  }

  async studentAccountsIn(db: Db, groupIds: Iterable<string>): Promise<string[]> {
    return [...(await this.studentAccountsByGroup(db, groupIds)).values()].flat();
  }

  async list(userId: string, query: ListNotificationsQuery): Promise<ListNotificationsResponse> {
    const where: Prisma.NotificationWhereInput = {
      recipientId: userId,
      ...(query.unread ? { readAt: null } : {}),
    };
    const [rows, total, unread] = await Promise.all([
      this.prisma.notification.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.prisma.notification.count({ where }),
      this.unreadCount(userId),
    ]);
    return {
      items: rows.map(toNotification).filter((n): n is Notification => n !== null),
      total,
      unread,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  unreadCount(userId: string): Promise<number> {
    return this.prisma.notification.count({ where: { recipientId: userId, readAt: null } });
  }

  /** Marks one of the caller's notifications as read. Someone else's is "not found". */
  async markRead(userId: string, id: string): Promise<Notification> {
    const updated = await this.prisma.notification.updateManyAndReturn({
      where: { id, recipientId: userId, readAt: null },
      data: { readAt: new Date() },
    });
    const row =
      updated[0] ??
      (await this.prisma.notification.findFirst({ where: { id, recipientId: userId } }));
    const notification = row ? toNotification(row) : null;
    if (!notification) throw Errors.notFound('Notification');
    return notification;
  }

  async markAllRead(userId: string): Promise<number> {
    const result = await this.prisma.notification.updateMany({
      where: { recipientId: userId, readAt: null },
      data: { readAt: new Date() },
    });
    return result.count;
  }
}
