import { Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import {
  type ListNotificationsQuery,
  ListNotificationsQuerySchema,
  type ListNotificationsResponse,
  type Notification,
  type UnreadCount,
} from '@ftms/core';
import { AllowPendingVerification, CurrentPrincipal } from '../auth/decorators';
import { type AuthPrincipal } from '../auth/principal';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { NotificationsService } from './notifications.service';

const uuid = new ParseUUIDPipe({ version: '7' });

/**
 * The caller's own notification center (§12). Every route is scoped to the
 * session's account; no recipient id is ever taken from the client. Accounts
 * waiting for verification may read theirs (the outcome of their review).
 */
@Controller('notifications')
@AllowPendingVerification()
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  list(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Query(new ZodValidationPipe(ListNotificationsQuerySchema)) query: ListNotificationsQuery,
  ): Promise<ListNotificationsResponse> {
    return this.notifications.list(principal.userId, query);
  }

  @Get('unread-count')
  async unreadCount(@CurrentPrincipal() principal: AuthPrincipal): Promise<UnreadCount> {
    return { unread: await this.notifications.unreadCount(principal.userId) };
  }

  @Post('read-all')
  @HttpCode(200)
  async readAll(@CurrentPrincipal() principal: AuthPrincipal): Promise<UnreadCount> {
    await this.notifications.markAllRead(principal.userId);
    return { unread: 0 };
  }

  @Post(':id/read')
  @HttpCode(200)
  read(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Param('id', uuid) id: string,
  ): Promise<Notification> {
    return this.notifications.markRead(principal.userId, id);
  }
}
