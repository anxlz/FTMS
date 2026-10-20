import { Body, Controller, Get, Patch, Post } from '@nestjs/common';
import {
  type CreateProgramRequest,
  CreateProgramRequestSchema,
  type Program,
  type ProgramState,
  type SettingsChange,
  type UpdateProgramRequest,
  UpdateProgramRequestSchema,
} from '@ftms/core';
import {
  CurrentPrincipal,
  RequireAnyPermission,
  RequirePermissions,
  Roles,
} from '../auth/decorators';
import { type AuthPrincipal } from '../auth/principal';
import { Ctx, type RequestContext } from '../common/request-context';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { ProgramService } from './program.service';

/** Training program settings (§11). */
@Controller('program')
export class ProgramController {
  constructor(private readonly programs: ProgramService) {}

  /** Staff see the settings that shape every visit they create. */
  @Get()
  @Roles('SUPER_ADMIN', 'TRAINING_DIRECTOR', 'FACULTY')
  get(): Promise<ProgramState> {
    return this.programs.get();
  }

  /** First configuration: both the schedule and the attendance defaults. */
  @Post()
  @RequirePermissions('schedule.manage', 'attendance.settings.defaults')
  create(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Body(new ZodValidationPipe(CreateProgramRequestSchema)) body: CreateProgramRequest,
    @Ctx() context: RequestContext,
  ): Promise<Program> {
    return this.programs.create(principal, body, context);
  }

  /** Each field group is checked against its own permission in the service. */
  @Patch()
  @RequireAnyPermission('schedule.manage', 'attendance.settings.defaults')
  update(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Body(new ZodValidationPipe(UpdateProgramRequestSchema)) body: UpdateProgramRequest,
    @Ctx() context: RequestContext,
  ): Promise<Program> {
    return this.programs.update(principal, body, context);
  }

  @Get('history')
  @RequireAnyPermission('schedule.manage', 'attendance.settings.defaults', 'audit.read')
  history(): Promise<SettingsChange[]> {
    return this.programs.history();
  }
}
