import { Body, Controller, Get, HttpCode, Patch, Post, Req, UseGuards } from '@nestjs/common';
import {
  type AcceptedResponse,
  type AuthResponse,
  type ChangePasswordRequest,
  ChangePasswordRequestSchema,
  type ForgotPasswordRequest,
  ForgotPasswordRequestSchema,
  type MeResponse,
  type OtpRequest,
  OtpRequestSchema,
  type OtpVerify,
  OtpVerifySchema,
  type RefreshRequest,
  RefreshRequestSchema,
  type ResetPasswordRequest,
  ResetPasswordRequestSchema,
  type SignupRequest,
  SignupRequestSchema,
  type SignupResponse,
  type SignupVerify,
  SignupVerifySchema,
  type UpdatePreferencesRequest,
  UpdatePreferencesRequestSchema,
} from '@ftms/core';
import type { Request } from 'express';
import { Ctx, type RequestContext } from '../common/request-context';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { type UserWithRelations } from '../users/user-mapping';
import { UsersService } from '../users/users.service';
import { AuthService } from './auth.service';
import {
  AllowPendingPasswordSetup,
  AllowPendingVerification,
  CurrentPrincipal,
  Public,
} from './decorators';
import { LocalAuthGuard } from './guards/auth.guards';
import { type AuthPrincipal } from './principal';

const ACCEPTED: AcceptedResponse = { accepted: true };

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly users: UsersService,
  ) {}

  /** Email or seat number + password. */
  @Public()
  @Post('login')
  @HttpCode(200)
  @UseGuards(LocalAuthGuard)
  login(
    @Req() req: Request & { user: UserWithRelations },
    @Ctx() context: RequestContext,
  ): Promise<AuthResponse> {
    return this.auth.signIn(req.user, 'PASSWORD', context);
  }

  /** First login: email a one-time code to an account that has no password yet. */
  @Public()
  @Post('code/request')
  @HttpCode(202)
  async requestCode(
    @Body(new ZodValidationPipe(OtpRequestSchema)) body: OtpRequest,
    @Ctx() context: RequestContext,
  ): Promise<AcceptedResponse> {
    await this.auth.requestLoginCode(body.email, context);
    return ACCEPTED;
  }

  @Public()
  @Post('code/verify')
  @HttpCode(200)
  verifyCode(
    @Body(new ZodValidationPipe(OtpVerifySchema)) body: OtpVerify,
    @Ctx() context: RequestContext,
  ): Promise<AuthResponse> {
    return this.auth.verifyLoginCode(body.email, body.code, context);
  }

  /** Student signup (§4.2), step 1: send a code to the university email. */
  @Public()
  @Post('signup/request')
  @HttpCode(202)
  async requestSignup(
    @Body(new ZodValidationPipe(SignupRequestSchema)) body: SignupRequest,
    @Ctx() context: RequestContext,
  ): Promise<AcceptedResponse> {
    await this.auth.requestSignupCode(body, context);
    return ACCEPTED;
  }

  /** Signup, step 2: verify the code; link to an imported record or wait for review. */
  @Public()
  @Post('signup/verify')
  @HttpCode(200)
  verifySignup(
    @Body(new ZodValidationPipe(SignupVerifySchema)) body: SignupVerify,
    @Ctx() context: RequestContext,
  ): Promise<SignupResponse> {
    return this.auth.verifySignup(body, context);
  }

  @Public()
  @Post('password/forgot')
  @HttpCode(202)
  async forgotPassword(
    @Body(new ZodValidationPipe(ForgotPasswordRequestSchema)) body: ForgotPasswordRequest,
    @Ctx() context: RequestContext,
  ): Promise<AcceptedResponse> {
    await this.auth.requestPasswordReset(body.email, context);
    return ACCEPTED;
  }

  @Public()
  @Post('password/reset')
  @HttpCode(204)
  async resetPassword(
    @Body(new ZodValidationPipe(ResetPasswordRequestSchema)) body: ResetPasswordRequest,
    @Ctx() context: RequestContext,
  ): Promise<void> {
    await this.auth.resetPassword(body, context);
  }

  @Public()
  @Post('refresh')
  @HttpCode(200)
  refresh(
    @Body(new ZodValidationPipe(RefreshRequestSchema)) body: RefreshRequest,
    @Ctx() context: RequestContext,
  ): Promise<AuthResponse> {
    return this.auth.refresh(body.refreshToken, context);
  }

  @AllowPendingPasswordSetup()
  @AllowPendingVerification()
  @Post('logout')
  @HttpCode(204)
  async logout(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Ctx() context: RequestContext,
  ): Promise<void> {
    await this.auth.logout(principal, context);
  }

  @AllowPendingPasswordSetup()
  @AllowPendingVerification()
  @Get('me')
  me(@CurrentPrincipal() principal: AuthPrincipal): Promise<MeResponse> {
    return this.users.me(principal.userId);
  }

  /** Sets the first password or changes the current one. */
  @AllowPendingPasswordSetup()
  @AllowPendingVerification()
  @Post('password/change')
  @HttpCode(204)
  async changePassword(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Body(new ZodValidationPipe(ChangePasswordRequestSchema)) body: ChangePasswordRequest,
    @Ctx() context: RequestContext,
  ): Promise<void> {
    await this.auth.changePassword(principal, body, context);
  }

  /** Language preference (§18.1). Allowed before the password step so the UI language sticks. */
  @AllowPendingPasswordSetup()
  @AllowPendingVerification()
  @Patch('me/preferences')
  updatePreferences(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Body(new ZodValidationPipe(UpdatePreferencesRequestSchema)) body: UpdatePreferencesRequest,
  ): Promise<MeResponse> {
    return this.users.updatePreferences(principal.userId, body);
  }
}
