import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  Res,
  StreamableFile,
} from '@nestjs/common';
import {
  type AttendanceOverview,
  type CheckInContext,
  type CheckInOptionsRequest,
  CheckInOptionsRequestSchema,
  type CheckInRequest,
  CheckInRequestSchema,
  type CheckInResult,
  type CorrectAttendanceRequest,
  CorrectAttendanceRequestSchema,
  type ExportQuery,
  ExportQuerySchema,
  type OwnAttendanceResponse,
  type VisitAttendanceQuery,
  VisitAttendanceQuerySchema,
  type VisitAttendanceResponse,
  type VisitAttendanceRow,
  type VisitQrCodes,
  type WebAuthnOptionsResponse,
} from '@ftms/core';
import type { Response } from 'express';
import {
  CurrentPrincipal,
  Public,
  RequireAnyPermission,
  RequirePermissions,
  Roles,
} from '../auth/decorators';
import { type AuthPrincipal } from '../auth/principal';
import { Errors } from '../common/api-exception';
import { safeEqual } from '../common/crypto';
import { Ctx, type RequestContext } from '../common/request-context';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { AppConfigService } from '../config/app-config.service';
import { PrismaService } from '../prisma/prisma.service';
import { contentDisposition } from '../storage/local-files.controller';
import { AbsencesService, type AbsenceRunResult } from './absences.service';
import { AttendanceTokens } from './attendance-tokens';
import { AttendanceService } from './attendance.service';
import { CheckInService } from './check-in.service';
import { ExportService } from './export.service';

const uuid = new ParseUUIDPipe({ version: '7' });

/** The QR check-in flow (§7.2): students only; everything else is checked by the service. */
@Controller('attendance/check-in')
@Roles('STUDENT')
export class CheckInController {
  constructor(private readonly checkIns: CheckInService) {}

  @Get(':token')
  context(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Param('token') token: string,
  ): Promise<CheckInContext> {
    return this.checkIns.context(principal, token);
  }

  /** A WebAuthn challenge for this check-in, bound to this student and visit. */
  @Post('options')
  @HttpCode(200)
  options(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Body(new ZodValidationPipe(CheckInOptionsRequestSchema)) body: CheckInOptionsRequest,
  ): Promise<WebAuthnOptionsResponse> {
    return this.checkIns.options(principal, body.token);
  }

  @Post()
  checkIn(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Body(new ZodValidationPipe(CheckInRequestSchema)) body: CheckInRequest,
    @Ctx() context: RequestContext,
  ): Promise<CheckInResult> {
    return this.checkIns.checkIn(principal, body, context);
  }
}

/** Attendance management (§8.4, §10.3), QR codes (§7) and dashboards (§9, §10.1). */
@Controller()
export class AttendanceController {
  constructor(
    private readonly attendance: AttendanceService,
    private readonly exports: ExportService,
    private readonly tokens: AttendanceTokens,
    private readonly prisma: PrismaService,
  ) {}

  @Get('visits/:id/attendance')
  @RequirePermissions('attendance.read')
  visit(
    @Param('id', uuid) id: string,
    @Query(new ZodValidationPipe(VisitAttendanceQuerySchema)) query: VisitAttendanceQuery,
  ): Promise<VisitAttendanceResponse> {
    return this.attendance.visitAttendance(id, query);
  }

  @Put('visits/:id/attendance/:studentId')
  @RequirePermissions('attendance.correct')
  correct(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Param('id', uuid) id: string,
    @Param('studentId', uuid) studentId: string,
    @Body(new ZodValidationPipe(CorrectAttendanceRequestSchema)) body: CorrectAttendanceRequest,
    @Ctx() context: RequestContext,
  ): Promise<VisitAttendanceRow> {
    return this.attendance.correct(principal, id, studentId, body, context);
  }

  /** Printable visit-details and attendance QR codes (§7.1, §7.2). */
  @Get('visits/:id/qr')
  @RequireAnyPermission('visits.manage', 'attendance.read')
  async qr(@Param('id', uuid) id: string): Promise<VisitQrCodes> {
    if (!(await this.prisma.trainingVisit.findUnique({ where: { id }, select: { id: true } }))) {
      throw Errors.notFound('Visit');
    }
    return this.tokens.qrCodes(id);
  }

  @Get('attendance/overview')
  @RequirePermissions('attendance.read')
  overview(): Promise<AttendanceOverview> {
    return this.attendance.overview();
  }

  /** CSV, XLSX or PDF of the records the caller may see (§10.4, §19). */
  @Get('attendance/export')
  @RequirePermissions('attendance.read', 'reports.export')
  async export(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Query(new ZodValidationPipe(ExportQuerySchema)) query: ExportQuery,
    @Ctx() context: RequestContext,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const file = await this.exports.export(principal, query, context);
    res.setHeader('content-disposition', contentDisposition('attachment', file.fileName));
    res.setHeader('cache-control', 'no-store');
    return new StreamableFile(file.body, { type: file.contentType, length: file.body.length });
  }

  /** The student's own summary and history (§9.1–9.3). */
  @Get('me/attendance')
  @Roles('STUDENT')
  own(@CurrentPrincipal() principal: AuthPrincipal): Promise<OwnAttendanceResponse> {
    return this.attendance.own(principal);
  }
}

/**
 * Called by the database's pg_cron job through pg_net (§8.3), authenticated by
 * the shared CRON_SECRET. Disabled (404) when no secret is configured.
 */
@Controller('internal/attendance')
export class InternalAttendanceController {
  constructor(
    private readonly absences: AbsencesService,
    private readonly config: AppConfigService,
  ) {}

  @Public()
  @Post('process-absences')
  @HttpCode(200)
  async process(@Headers('x-ftms-cron-key') key: string | undefined): Promise<AbsenceRunResult> {
    const secret = this.config.get('CRON_SECRET');
    if (!secret) throw Errors.notFound('Route');
    if (!key || !safeEqual(key, secret)) throw Errors.authRequired();
    return this.absences.processDue();
  }
}
