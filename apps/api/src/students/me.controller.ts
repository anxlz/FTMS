import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import {
  type OwnProfileChange,
  type OwnStudentProfile,
  type OwnVerification,
  type SubmitProfileChangeRequest,
  SubmitProfileChangeRequestSchema,
  type SubmitVerificationRequest,
  SubmitVerificationRequestSchema,
  type SubmitVerificationResponse,
  type UpdateOwnProfileRequest,
  UpdateOwnProfileRequestSchema,
} from '@ftms/core';
import { AllowPendingVerification, CurrentPrincipal, Roles } from '../auth/decorators';
import { type AuthPrincipal } from '../auth/principal';
import { Ctx, type RequestContext } from '../common/request-context';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { ProfileChangesService } from './profile-changes.service';
import { StudentsService } from './students.service';
import { VerificationsService } from './verifications.service';

const uuid = new ParseUUIDPipe({ version: '7' });

/**
 * A student's own record, profile-change requests and verification status.
 * Ownership comes from the session — no student id is ever taken from the
 * client, so one student cannot address another's data (§3.4, §17).
 */
@Controller('me')
@Roles('STUDENT')
export class MeController {
  constructor(
    private readonly students: StudentsService,
    private readonly changes: ProfileChangesService,
    private readonly verifications: VerificationsService,
  ) {}

  @Get('student')
  own(@CurrentPrincipal() principal: AuthPrincipal): Promise<OwnStudentProfile> {
    return this.students.own(principal.userId);
  }

  /** Permitted fields only; identity fields go through `POST /me/profile-changes`. */
  @Patch('student')
  update(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Body(new ZodValidationPipe(UpdateOwnProfileRequestSchema)) body: UpdateOwnProfileRequest,
    @Ctx() context: RequestContext,
  ): Promise<OwnStudentProfile> {
    return this.students.updateOwn(principal, body, context);
  }

  @Get('profile-changes')
  listChanges(@CurrentPrincipal() principal: AuthPrincipal): Promise<OwnProfileChange[]> {
    return this.changes.listOwn(principal.userId);
  }

  @Post('profile-changes')
  submitChange(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Body(new ZodValidationPipe(SubmitProfileChangeRequestSchema)) body: SubmitProfileChangeRequest,
    @Ctx() context: RequestContext,
  ): Promise<OwnProfileChange> {
    return this.changes.submit(principal, body, context);
  }

  @Post('profile-changes/:id/cancel')
  @HttpCode(200)
  cancelChange(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Param('id', uuid) id: string,
    @Ctx() context: RequestContext,
  ): Promise<OwnProfileChange> {
    return this.changes.cancel(principal, id, context);
  }

  @AllowPendingVerification()
  @Get('verification')
  verification(@CurrentPrincipal() principal: AuthPrincipal): Promise<OwnVerification> {
    return this.verifications.own(principal);
  }

  /** Pending accounts: (re)submit details; an exact match links the account at once. */
  @AllowPendingVerification()
  @Post('verification')
  @HttpCode(200)
  submitVerification(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Body(new ZodValidationPipe(SubmitVerificationRequestSchema)) body: SubmitVerificationRequest,
    @Ctx() context: RequestContext,
  ): Promise<SubmitVerificationResponse> {
    return this.verifications.submit(principal, body, context);
  }
}
