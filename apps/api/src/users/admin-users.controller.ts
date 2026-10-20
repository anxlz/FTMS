import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import {
  type CreateUserRequest,
  CreateUserRequestSchema,
  type ListUsersQuery,
  ListUsersQuerySchema,
  type ListUsersResponse,
  PERMISSION_KEYS,
  PERMISSIONS,
  ROLE_DEFAULT_PERMISSIONS,
  ROLES,
  type SetPermissionGrantsRequest,
  SetPermissionGrantsRequestSchema,
  type UpdateUserRoleRequest,
  UpdateUserRoleRequestSchema,
  type UpdateUserStatusRequest,
  UpdateUserStatusRequestSchema,
  type UserDetail,
} from '@ftms/core';
import { CurrentPrincipal, RequireAnyPermission, RequirePermissions } from '../auth/decorators';
import { type AuthPrincipal } from '../auth/principal';
import { Ctx, type RequestContext } from '../common/request-context';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { UsersService } from './users.service';

const uuid = new ParseUUIDPipe({ version: '7' });

@Controller('admin')
export class AdminUsersController {
  constructor(private readonly users: UsersService) {}

  @Get('users')
  @RequirePermissions('users.read')
  list(
    @Query(new ZodValidationPipe(ListUsersQuerySchema)) query: ListUsersQuery,
  ): Promise<ListUsersResponse> {
    return this.users.list(query);
  }

  @Get('users/:id')
  @RequirePermissions('users.read')
  detail(@Param('id', uuid) id: string): Promise<UserDetail> {
    return this.users.detail(id);
  }

  @Post('users')
  @RequireAnyPermission('users.manage', 'faculty.manage')
  create(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Body(new ZodValidationPipe(CreateUserRequestSchema)) body: CreateUserRequest,
    @Ctx() context: RequestContext,
  ): Promise<UserDetail> {
    return this.users.create(principal, body, context);
  }

  @Patch('users/:id/status')
  @RequireAnyPermission('users.manage', 'faculty.manage')
  setStatus(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Param('id', uuid) id: string,
    @Body(new ZodValidationPipe(UpdateUserStatusRequestSchema)) body: UpdateUserStatusRequest,
    @Ctx() context: RequestContext,
  ): Promise<UserDetail> {
    return this.users.setStatus(principal, id, body, context);
  }

  @Patch('users/:id/role')
  @RequirePermissions('users.manage')
  setRole(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Param('id', uuid) id: string,
    @Body(new ZodValidationPipe(UpdateUserRoleRequestSchema)) body: UpdateUserRoleRequest,
    @Ctx() context: RequestContext,
  ): Promise<UserDetail> {
    return this.users.setRole(principal, id, body, context);
  }

  @Put('users/:id/permissions')
  @RequirePermissions('permissions.manage')
  setGrants(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Param('id', uuid) id: string,
    @Body(new ZodValidationPipe(SetPermissionGrantsRequestSchema)) body: SetPermissionGrantsRequest,
    @Ctx() context: RequestContext,
  ): Promise<UserDetail> {
    return this.users.setGrants(principal, id, body, context);
  }

  /** Permission catalog and role defaults, for the admin UI. */
  @Get('permissions')
  @RequirePermissions('users.read')
  permissions() {
    return {
      permissions: PERMISSION_KEYS.map((key) => ({ key, ...PERMISSIONS[key] })),
      roleDefaults: Object.fromEntries(ROLES.map((role) => [role, ROLE_DEFAULT_PERMISSIONS[role]])),
    };
  }
}
