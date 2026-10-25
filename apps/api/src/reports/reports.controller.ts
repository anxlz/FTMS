import { Controller, Get, Query, Res, StreamableFile } from '@nestjs/common';
import {
  type AttendanceSummaryQuery,
  AttendanceSummaryQuerySchema,
  type AttendanceSummaryResponse,
  type ReportExportQuery,
  ReportExportQuerySchema,
} from '@ftms/core';
import { type Response } from 'express';
import { CurrentPrincipal, RequirePermissions } from '../auth/decorators';
import { type AuthPrincipal } from '../auth/principal';
import { Ctx, type RequestContext } from '../common/request-context';
import { type ExportFile } from '../common/tabular-export';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { contentDisposition } from '../storage/local-files.controller';
import { ReportsService } from './reports.service';

const send = (res: Response, file: ExportFile): StreamableFile => {
  res.setHeader('content-disposition', contentDisposition('attachment', file.fileName));
  res.setHeader('cache-control', 'no-store');
  return new StreamableFile(file.body, { type: file.contentType, length: file.body.length });
};

/**
 * Training-wide reports, each restricted by its own permissions (§3.2, §15):
 * attendance standing needs `attendance.read` + `reports.export`; the faculty
 * activity report needs `audit.read` + `reports.export`.
 */
@Controller('reports')
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Get('attendance-summary')
  @RequirePermissions('attendance.read', 'reports.export')
  attendanceSummary(
    @Query(new ZodValidationPipe(AttendanceSummaryQuerySchema)) query: AttendanceSummaryQuery,
  ): Promise<AttendanceSummaryResponse> {
    return this.reports.attendanceSummary(query);
  }

  @Get('attendance-summary/export')
  @RequirePermissions('attendance.read', 'reports.export')
  async exportAttendanceSummary(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Query(new ZodValidationPipe(ReportExportQuerySchema)) query: ReportExportQuery,
    @Ctx() context: RequestContext,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    return send(res, await this.reports.exportAttendanceSummary(principal, query, context));
  }

  @Get('faculty-activity/export')
  @RequirePermissions('audit.read', 'reports.export')
  async exportFacultyActivity(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Query(new ZodValidationPipe(ReportExportQuerySchema)) query: ReportExportQuery,
    @Ctx() context: RequestContext,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    return send(res, await this.reports.exportFacultyActivity(principal, query, context));
  }
}
