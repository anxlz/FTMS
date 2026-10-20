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
  Query,
} from '@nestjs/common';
import {
  type CreateScheduleExceptionRequest,
  CreateScheduleExceptionRequestSchema,
  type CreateScheduleRequest,
  CreateScheduleRequestSchema,
  type ExceptionChangeResult,
  type ListSchedulesQuery,
  ListSchedulesQuerySchema,
  type ReasonOnly,
  ReasonOnlySchema,
  type Schedule,
  type ScheduleChangeResult,
  type ScheduleException,
  type UpdateScheduleRequest,
  UpdateScheduleRequestSchema,
} from '@ftms/core';
import { CurrentPrincipal, RequireAnyPermission, Roles } from '../auth/decorators';
import { type AuthPrincipal } from '../auth/principal';
import { Ctx, type RequestContext } from '../common/request-context';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { SchedulesService } from './schedules.service';

const uuid = new ParseUUIDPipe({ version: '7' });
const STAFF = ['SUPER_ADMIN', 'TRAINING_DIRECTOR', 'FACULTY'] as const;

/**
 * Recurring schedules (§6.1, §11.2). Writes need `schedule.manage` or
 * `schedule.group.manage`; the service decides which schedules each covers.
 */
@Controller('schedules')
export class SchedulesController {
  constructor(private readonly schedules: SchedulesService) {}

  @Get()
  @Roles(...STAFF)
  list(
    @Query(new ZodValidationPipe(ListSchedulesQuerySchema)) query: ListSchedulesQuery,
  ): Promise<Schedule[]> {
    return this.schedules.list(query.includeEnded);
  }

  @Post()
  @RequireAnyPermission('schedule.manage', 'schedule.group.manage')
  create(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Body(new ZodValidationPipe(CreateScheduleRequestSchema)) body: CreateScheduleRequest,
    @Ctx() context: RequestContext,
  ): Promise<ScheduleChangeResult> {
    return this.schedules.create(principal, body, context);
  }

  @Patch(':id')
  @RequireAnyPermission('schedule.manage', 'schedule.group.manage')
  update(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Param('id', uuid) id: string,
    @Body(new ZodValidationPipe(UpdateScheduleRequestSchema)) body: UpdateScheduleRequest,
    @Ctx() context: RequestContext,
  ): Promise<ScheduleChangeResult> {
    return this.schedules.update(principal, id, body, context);
  }

  @Post(':id/end')
  @HttpCode(200)
  @RequireAnyPermission('schedule.manage', 'schedule.group.manage')
  end(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Param('id', uuid) id: string,
    @Body(new ZodValidationPipe(ReasonOnlySchema)) body: ReasonOnly,
    @Ctx() context: RequestContext,
  ): Promise<ScheduleChangeResult> {
    return this.schedules.end(principal, id, body.reason, context);
  }
}

/** Days without training (§6.1). */
@Controller('schedule-exceptions')
export class ScheduleExceptionsController {
  constructor(private readonly schedules: SchedulesService) {}

  @Get()
  @Roles(...STAFF)
  list(): Promise<ScheduleException[]> {
    return this.schedules.listExceptions();
  }

  @Post()
  @RequireAnyPermission('schedule.manage', 'schedule.group.manage')
  create(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Body(new ZodValidationPipe(CreateScheduleExceptionRequestSchema))
    body: CreateScheduleExceptionRequest,
    @Ctx() context: RequestContext,
  ): Promise<ExceptionChangeResult> {
    return this.schedules.createException(principal, body, context);
  }

  @Delete(':id')
  @RequireAnyPermission('schedule.manage', 'schedule.group.manage')
  remove(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Param('id', uuid) id: string,
    @Ctx() context: RequestContext,
  ): Promise<ExceptionChangeResult> {
    return this.schedules.removeException(principal, id, context);
  }
}
