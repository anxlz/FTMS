import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import {
  type CreateGroupSwapRequest,
  CreateGroupSwapRequestSchema,
  type GroupSwapStaffView,
  type GroupSwapView,
  type ListGroupSwapHistoryResponse,
  type ListGroupSwapsQuery,
  ListGroupSwapsQuerySchema,
  type ListGroupSwapsResponse,
  type OptionalReasonRequest,
  OptionalReasonRequestSchema,
  type RejectGroupSwapRequest,
  RejectGroupSwapRequestSchema,
  type SwapTargetsResponse,
} from '@ftms/core';
import {
  CurrentPrincipal,
  RequireAnyPermission,
  RequirePermissions,
  Roles,
} from '../auth/decorators';
import { type AuthPrincipal } from '../auth/principal';
import { Errors } from '../common/api-exception';
import { Ctx, type RequestContext } from '../common/request-context';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { GroupSwapsService } from './group-swaps.service';

const uuid = new ParseUUIDPipe({ version: '7' });

/** Mutual group swaps (§14): students request and consent; faculty decide. */
@Controller('group-swaps')
export class GroupSwapsController {
  constructor(private readonly swaps: GroupSwapsService) {}

  @Post()
  @Roles('STUDENT')
  create(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Body(new ZodValidationPipe(CreateGroupSwapRequestSchema)) body: CreateGroupSwapRequest,
    @Ctx() context: RequestContext,
  ): Promise<GroupSwapView> {
    return this.swaps.create(principal, body, context);
  }

  /** The faculty review queue and list (§14.5). */
  @Get()
  @RequireAnyPermission('group_swaps.decide', 'group_swaps.audit')
  list(
    @Query(new ZodValidationPipe(ListGroupSwapsQuerySchema)) query: ListGroupSwapsQuery,
  ): Promise<ListGroupSwapsResponse> {
    return this.swaps.list(query);
  }

  /** Every decision and who made it — the Training Director's audit (§14.7). */
  @Get('history')
  @RequirePermissions('group_swaps.audit')
  history(
    @Query(new ZodValidationPipe(ListGroupSwapsQuerySchema)) query: ListGroupSwapsQuery,
  ): Promise<ListGroupSwapHistoryResponse> {
    return this.swaps.history(query);
  }

  /** A participating student's view, or the staff review view. */
  @Get(':id')
  get(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Param('id', uuid) id: string,
  ): Promise<GroupSwapView | GroupSwapStaffView> {
    if (principal.role === 'STUDENT') return this.swaps.studentView(principal, id);
    if (
      !principal.permissions.has('group_swaps.decide') &&
      !principal.permissions.has('group_swaps.audit')
    ) {
      throw Errors.forbidden();
    }
    return this.swaps.staffView(id);
  }

  @Post(':id/accept')
  @HttpCode(200)
  @Roles('STUDENT')
  accept(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Param('id', uuid) id: string,
    @Ctx() context: RequestContext,
  ): Promise<GroupSwapView> {
    return this.swaps.accept(principal, id, context);
  }

  @Post(':id/decline')
  @HttpCode(200)
  @Roles('STUDENT')
  decline(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Param('id', uuid) id: string,
    @Body(new ZodValidationPipe(OptionalReasonRequestSchema)) body: OptionalReasonRequest,
    @Ctx() context: RequestContext,
  ): Promise<GroupSwapView> {
    return this.swaps.decline(principal, id, body.reason, context);
  }

  @Post(':id/withdraw')
  @HttpCode(200)
  @Roles('STUDENT')
  withdraw(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Param('id', uuid) id: string,
    @Body(new ZodValidationPipe(OptionalReasonRequestSchema)) body: OptionalReasonRequest,
    @Ctx() context: RequestContext,
  ): Promise<GroupSwapView> {
    return this.swaps.withdraw(principal, id, body.reason, context);
  }

  @Post(':id/approve')
  @HttpCode(200)
  @RequirePermissions('group_swaps.decide')
  approve(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Param('id', uuid) id: string,
    @Ctx() context: RequestContext,
  ): Promise<GroupSwapStaffView> {
    return this.swaps.approve(principal, id, context);
  }

  @Post(':id/reject')
  @HttpCode(200)
  @RequirePermissions('group_swaps.decide')
  reject(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Param('id', uuid) id: string,
    @Body(new ZodValidationPipe(RejectGroupSwapRequestSchema)) body: RejectGroupSwapRequest,
    @Ctx() context: RequestContext,
  ): Promise<GroupSwapStaffView> {
    return this.swaps.reject(principal, id, body.reason, context);
  }
}

/** The student's own requests, sent and received. */
@Controller('me/group-swaps')
@Roles('STUDENT')
export class MyGroupSwapsController {
  constructor(private readonly swaps: GroupSwapsService) {}

  @Get()
  list(@CurrentPrincipal() principal: AuthPrincipal): Promise<GroupSwapView[]> {
    return this.swaps.listOwn(principal);
  }

  /** The groups the student may ask to move to (§14.1). */
  @Get('groups')
  targets(@CurrentPrincipal() principal: AuthPrincipal): Promise<SwapTargetsResponse> {
    return this.swaps.targets(principal);
  }
}
