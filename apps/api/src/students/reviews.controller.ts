import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import {
  type ApproveRequest,
  ApproveRequestSchema,
  type ApproveVerificationRequest,
  ApproveVerificationRequestSchema,
  type ListProfileChangesResponse,
  type ListRequestsQuery,
  ListRequestsQuerySchema,
  type ListVerificationsResponse,
  type ProfileChangeReview,
  type ReasonRequest,
  ReasonRequestSchema,
  type VerificationReview,
  type VerificationReviewDetail,
} from '@ftms/core';
import { CurrentPrincipal, RequirePermissions } from '../auth/decorators';
import { type AuthPrincipal } from '../auth/principal';
import { Ctx, type RequestContext } from '../common/request-context';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { ProfileChangesService } from './profile-changes.service';
import { VerificationsService } from './verifications.service';

const uuid = new ParseUUIDPipe({ version: '7' });

/** Review queue: protected profile changes (§4.4). */
@Controller('profile-changes')
@RequirePermissions('profile_changes.decide')
export class ProfileChangesController {
  constructor(private readonly changes: ProfileChangesService) {}

  @Get()
  list(
    @Query(new ZodValidationPipe(ListRequestsQuerySchema)) query: ListRequestsQuery,
  ): Promise<ListProfileChangesResponse> {
    return this.changes.list(query);
  }

  @Get(':id')
  detail(@Param('id', uuid) id: string): Promise<ProfileChangeReview> {
    return this.changes.detail(id);
  }

  @Post(':id/approve')
  @HttpCode(200)
  approve(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Param('id', uuid) id: string,
    @Body(new ZodValidationPipe(ApproveRequestSchema)) body: ApproveRequest,
    @Ctx() context: RequestContext,
  ): Promise<ProfileChangeReview> {
    return this.changes.approve(principal, id, body, context);
  }

  /** A reason is mandatory; the student sees it, never the reviewer's identity. */
  @Post(':id/reject')
  @HttpCode(200)
  reject(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Param('id', uuid) id: string,
    @Body(new ZodValidationPipe(ReasonRequestSchema)) body: ReasonRequest,
    @Ctx() context: RequestContext,
  ): Promise<ProfileChangeReview> {
    return this.changes.reject(principal, id, body.reason, context);
  }
}

/** Review queue: accounts waiting for verification (§4.2 Case B). */
@Controller('student-verifications')
@RequirePermissions('students.manage')
export class VerificationsController {
  constructor(private readonly verifications: VerificationsService) {}

  @Get()
  list(
    @Query(new ZodValidationPipe(ListRequestsQuerySchema)) query: ListRequestsQuery,
  ): Promise<ListVerificationsResponse> {
    return this.verifications.list(query);
  }

  @Get(':id')
  detail(@Param('id', uuid) id: string): Promise<VerificationReviewDetail> {
    return this.verifications.detail(id);
  }

  @Post(':id/approve')
  @HttpCode(200)
  approve(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Param('id', uuid) id: string,
    @Body(new ZodValidationPipe(ApproveVerificationRequestSchema)) body: ApproveVerificationRequest,
    @Ctx() context: RequestContext,
  ): Promise<VerificationReview> {
    return this.verifications.approve(principal, id, body, context);
  }

  @Post(':id/reject')
  @HttpCode(200)
  reject(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Param('id', uuid) id: string,
    @Body(new ZodValidationPipe(ReasonRequestSchema)) body: ReasonRequest,
    @Ctx() context: RequestContext,
  ): Promise<VerificationReview> {
    return this.verifications.reject(principal, id, body.reason, context);
  }
}
