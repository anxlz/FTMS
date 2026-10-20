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
  type CreateStudentRequest,
  CreateStudentRequestSchema,
  type ListStudentsQuery,
  ListStudentsQuerySchema,
  type ListStudentsResponse,
  type ReasonRequest,
  ReasonRequestSchema,
  type SetStudentGroupRequest,
  SetStudentGroupRequestSchema,
  type StudentDetail,
  type UpdateStudentRequest,
  UpdateStudentRequestSchema,
} from '@ftms/core';
import { CurrentPrincipal, RequirePermissions } from '../auth/decorators';
import { type AuthPrincipal } from '../auth/principal';
import { Ctx, type RequestContext } from '../common/request-context';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { GroupsService } from './groups.service';
import { StudentsService } from './students.service';

const uuid = new ParseUUIDPipe({ version: '7' });

/** Student records (§4.1, §4.4) — staff only; students use `/me/...`. */
@Controller('students')
export class StudentsController {
  constructor(
    private readonly students: StudentsService,
    private readonly groups: GroupsService,
  ) {}

  @Get()
  @RequirePermissions('students.read')
  list(
    @Query(new ZodValidationPipe(ListStudentsQuerySchema)) query: ListStudentsQuery,
  ): Promise<ListStudentsResponse> {
    return this.students.list(query);
  }

  @Post()
  @RequirePermissions('students.manage')
  create(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Body(new ZodValidationPipe(CreateStudentRequestSchema)) body: CreateStudentRequest,
    @Ctx() context: RequestContext,
  ): Promise<StudentDetail> {
    return this.students.create(principal, body, context);
  }

  @Get(':id')
  @RequirePermissions('students.read')
  detail(@Param('id', uuid) id: string): Promise<StudentDetail> {
    return this.students.detail(id);
  }

  @Patch(':id')
  @RequirePermissions('students.manage')
  update(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Param('id', uuid) id: string,
    @Body(new ZodValidationPipe(UpdateStudentRequestSchema)) body: UpdateStudentRequest,
    @Ctx() context: RequestContext,
  ): Promise<StudentDetail> {
    return this.students.update(principal, id, body, context);
  }

  /** Only records without a linked account; the reason is kept in the audit log. */
  @Delete(':id')
  @HttpCode(204)
  @RequirePermissions('students.manage')
  async remove(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Param('id', uuid) id: string,
    @Body(new ZodValidationPipe(ReasonRequestSchema)) body: ReasonRequest,
    @Ctx() context: RequestContext,
  ): Promise<void> {
    await this.students.remove(principal, id, body.reason, context);
  }

  /** Puts the student in a group (moving them if needed) or, with `null`, in none. */
  @Put(':id/group')
  @RequirePermissions('groups.manage')
  async setGroup(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Param('id', uuid) id: string,
    @Body(new ZodValidationPipe(SetStudentGroupRequestSchema)) body: SetStudentGroupRequest,
    @Ctx() context: RequestContext,
  ): Promise<StudentDetail> {
    await this.groups.setStudentGroup(principal, id, body.groupId, body.reason, context);
    return this.students.detail(id);
  }

  /** Correction tool for a wrong link: the account returns to pending verification. */
  @Post(':id/unlink-account')
  @HttpCode(200)
  @RequirePermissions('students.manage')
  unlink(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Param('id', uuid) id: string,
    @Body(new ZodValidationPipe(ReasonRequestSchema)) body: ReasonRequest,
    @Ctx() context: RequestContext,
  ): Promise<StudentDetail> {
    return this.students.unlinkAccount(principal, id, body.reason, context);
  }
}
