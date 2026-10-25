import { Controller, Get, Param, Query, Res, StreamableFile } from '@nestjs/common';
import {
  type AuditEntryDetail,
  type AuditExportQuery,
  AuditExportQuerySchema,
  type AuditFacetsResponse,
  AuditIdSchema,
  type FacultyActivityQuery,
  FacultyActivityQuerySchema,
  type FacultyActivityResponse,
  type ListAuditLogsQuery,
  ListAuditLogsQuerySchema,
  type ListAuditLogsResponse,
} from '@ftms/core';
import { type Response } from 'express';
import { CurrentPrincipal, RequirePermissions } from '../auth/decorators';
import { type AuthPrincipal } from '../auth/principal';
import { Ctx, type RequestContext } from '../common/request-context';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { contentDisposition } from '../storage/local-files.controller';
import { AuditLogService } from './audit-log.service';

/**
 * The Training Director's audit log (§15.3). Read-only: there is no route
 * that changes or removes an event (§15.4). Holders of `audit.read` only —
 * the Training Director and Super Admin by default, or an account the
 * Super Admin explicitly authorizes (that grant is itself recorded).
 */
@Controller('audit-logs')
export class AuditLogController {
  constructor(private readonly logs: AuditLogService) {}

  @Get()
  @RequirePermissions('audit.read')
  list(
    @Query(new ZodValidationPipe(ListAuditLogsQuerySchema)) query: ListAuditLogsQuery,
  ): Promise<ListAuditLogsResponse> {
    return this.logs.list(query);
  }

  @Get('facets')
  @RequirePermissions('audit.read')
  facets(): Promise<AuditFacetsResponse> {
    return this.logs.facets();
  }

  /** What each staff member did in a period (§15.1). */
  @Get('activity')
  @RequirePermissions('audit.read')
  activity(
    @Query(new ZodValidationPipe(FacultyActivityQuerySchema)) query: FacultyActivityQuery,
  ): Promise<FacultyActivityResponse> {
    return this.logs.activity(query);
  }

  /** The filtered log as a file; recorded as `audit.exported`. */
  @Get('export')
  @RequirePermissions('audit.read', 'reports.export')
  async export(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Query(new ZodValidationPipe(AuditExportQuerySchema)) query: AuditExportQuery,
    @Ctx() context: RequestContext,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const file = await this.logs.export(principal, query, context);
    res.setHeader('content-disposition', contentDisposition('attachment', file.fileName));
    res.setHeader('cache-control', 'no-store');
    return new StreamableFile(file.body, { type: file.contentType, length: file.body.length });
  }

  @Get(':id')
  @RequirePermissions('audit.read')
  detail(@Param('id', new ZodValidationPipe(AuditIdSchema)) id: string): Promise<AuditEntryDetail> {
    return this.logs.detail(id);
  }
}
