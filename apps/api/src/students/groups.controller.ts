import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import {
  type AssignMembersRequest,
  AssignMembersRequestSchema,
  type AssignMembersResponse,
  type CreateGroupRequest,
  CreateGroupRequestSchema,
  type Group,
  type GroupDetail,
  type ListGroupsQuery,
  ListGroupsQuerySchema,
  type RemoveMemberRequest,
  RemoveMemberRequestSchema,
  type SetGroupArchivedRequest,
  SetGroupArchivedRequestSchema,
  type UpdateGroupRequest,
  UpdateGroupRequestSchema,
} from '@ftms/core';
import { CurrentPrincipal, RequireAnyPermission, RequirePermissions } from '../auth/decorators';
import { type AuthPrincipal } from '../auth/principal';
import { Ctx, type RequestContext } from '../common/request-context';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { GroupsService } from './groups.service';

const uuid = new ParseUUIDPipe({ version: '7' });

/** Training groups and membership (§5). */
@Controller('groups')
export class GroupsController {
  constructor(private readonly groups: GroupsService) {}

  /** Group names are needed wherever students are shown or filtered. */
  @Get()
  @RequireAnyPermission('students.read', 'groups.manage')
  list(
    @Query(new ZodValidationPipe(ListGroupsQuerySchema)) query: ListGroupsQuery,
  ): Promise<Group[]> {
    return this.groups.list(query.includeArchived);
  }

  @Post()
  @RequirePermissions('groups.manage')
  create(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Body(new ZodValidationPipe(CreateGroupRequestSchema)) body: CreateGroupRequest,
    @Ctx() context: RequestContext,
  ): Promise<Group> {
    return this.groups.create(principal, body, context);
  }

  @Get(':id')
  @RequireAnyPermission('students.read', 'groups.manage')
  detail(@Param('id', uuid) id: string): Promise<GroupDetail> {
    return this.groups.detail(id);
  }

  @Patch(':id')
  @RequirePermissions('groups.manage')
  update(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Param('id', uuid) id: string,
    @Body(new ZodValidationPipe(UpdateGroupRequestSchema)) body: UpdateGroupRequest,
    @Ctx() context: RequestContext,
  ): Promise<Group> {
    return this.groups.update(principal, id, body, context);
  }

  @Put(':id/archived')
  @RequirePermissions('groups.manage')
  setArchived(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Param('id', uuid) id: string,
    @Body(new ZodValidationPipe(SetGroupArchivedRequestSchema)) body: SetGroupArchivedRequest,
    @Ctx() context: RequestContext,
  ): Promise<Group> {
    return this.groups.setArchived(principal, id, body.archived, context);
  }

  @Post(':id/members')
  @HttpCode(200)
  @RequirePermissions('groups.manage')
  assign(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Param('id', uuid) id: string,
    @Body(new ZodValidationPipe(AssignMembersRequestSchema)) body: AssignMembersRequest,
    @Ctx() context: RequestContext,
  ): Promise<AssignMembersResponse> {
    return this.groups.assign(principal, id, body, context);
  }

  @Delete(':id/members/:studentId')
  @HttpCode(204)
  @RequirePermissions('groups.manage')
  async remove(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Param('id', uuid) id: string,
    @Param('studentId', uuid) studentId: string,
    @Body(new ZodValidationPipe(RemoveMemberRequestSchema)) body: RemoveMemberRequest,
    @Ctx() context: RequestContext,
  ): Promise<void> {
    await this.groups.removeMember(principal, id, studentId, body, context);
  }
}
