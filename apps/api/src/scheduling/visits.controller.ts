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
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  type CalendarQuery,
  CalendarQuerySchema,
  type CalendarResponse,
  type CreateVisitRequest,
  CreateVisitRequestSchema,
  type OptionalReasonBody,
  OptionalReasonBodySchema,
  type ReasonOnly,
  ReasonOnlySchema,
  type UpdateVisitRequest,
  UpdateVisitRequestSchema,
  type UploadVisitFileRequest,
  UploadVisitFileRequestSchema,
  type VisitDetail,
  VISIT_FILE_MAX_BYTES,
  type VisitHistoryEntry,
  type VisitMutationResult,
} from '@ftms/core';
import { CurrentPrincipal, RequirePermissions, Roles } from '../auth/decorators';
import { type AuthPrincipal } from '../auth/principal';
import { Ctx, type RequestContext } from '../common/request-context';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { type UploadedVisitFile, VisitFilesService } from './visit-files.service';
import { VisitsService } from './visits.service';

const uuid = new ParseUUIDPipe({ version: '7' });

/** Calendars (§6.2, §9.4): staff see all visits; students their group's only. */
@Controller('calendar')
export class CalendarController {
  constructor(private readonly visits: VisitsService) {}

  @Get()
  calendar(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Query(new ZodValidationPipe(CalendarQuerySchema)) query: CalendarQuery,
  ): Promise<CalendarResponse> {
    return this.visits.calendar(principal, query);
  }
}

/** Training visits (§6.3–6.5, §10.2). */
@Controller('visits')
export class VisitsController {
  constructor(
    private readonly visits: VisitsService,
    private readonly files: VisitFilesService,
  ) {}

  @Post()
  @RequirePermissions('visits.manage')
  create(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Body(new ZodValidationPipe(CreateVisitRequestSchema)) body: CreateVisitRequest,
    @Ctx() context: RequestContext,
  ): Promise<VisitMutationResult> {
    return this.visits.create(principal, body, context);
  }

  /** Students: only visits of their current group (others answer 404). */
  @Get(':id')
  detail(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Param('id', uuid) id: string,
  ): Promise<VisitDetail> {
    return this.visits.detail(principal, id);
  }

  @Get(':id/history')
  @Roles('SUPER_ADMIN', 'TRAINING_DIRECTOR', 'FACULTY')
  history(@Param('id', uuid) id: string): Promise<VisitHistoryEntry[]> {
    return this.visits.history(id);
  }

  @Patch(':id')
  @RequirePermissions('visits.manage')
  update(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Param('id', uuid) id: string,
    @Body(new ZodValidationPipe(UpdateVisitRequestSchema)) body: UpdateVisitRequest,
    @Ctx() context: RequestContext,
  ): Promise<VisitMutationResult> {
    return this.visits.update(principal, id, body, context);
  }

  @Post(':id/cancel')
  @HttpCode(200)
  @RequirePermissions('visits.manage')
  cancel(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Param('id', uuid) id: string,
    @Body(new ZodValidationPipe(ReasonOnlySchema)) body: ReasonOnly,
    @Ctx() context: RequestContext,
  ): Promise<VisitMutationResult> {
    return this.visits.cancel(principal, id, body.reason, context);
  }

  @Post(':id/restore')
  @HttpCode(200)
  @RequirePermissions('visits.manage')
  restore(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Param('id', uuid) id: string,
    @Body(new ZodValidationPipe(OptionalReasonBodySchema)) body: OptionalReasonBody,
    @Ctx() context: RequestContext,
  ): Promise<VisitMutationResult> {
    return this.visits.restore(principal, id, body.reason, context);
  }

  @Post(':id/files')
  @RequirePermissions('visits.manage')
  @UseInterceptors(
    FileInterceptor('file', {
      // In memory only (no temp files on serverless); one file, bounded size; UTF-8 names.
      limits: { fileSize: VISIT_FILE_MAX_BYTES, files: 1, fields: 2, parts: 3 },
      defParamCharset: 'utf8',
    }),
  )
  upload(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Param('id', uuid) id: string,
    @Body(new ZodValidationPipe(UploadVisitFileRequestSchema)) body: UploadVisitFileRequest,
    @UploadedFile() file: UploadedVisitFile | undefined,
    @Ctx() context: RequestContext,
  ): Promise<VisitDetail> {
    return this.files.upload(principal, id, body.kind, file, context);
  }

  @Delete(':id/files/:fileId')
  @RequirePermissions('visits.manage')
  removeFile(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Param('id', uuid) id: string,
    @Param('fileId', uuid) fileId: string,
    @Ctx() context: RequestContext,
  ): Promise<VisitDetail> {
    return this.files.remove(principal, id, fileId, context);
  }
}
