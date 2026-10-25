import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import {
  type AuthResponse,
  type BiometricCredential,
  type BiometricLoginRequest,
  BiometricLoginRequestSchema,
  type DeviceKeyChallenge,
  type DeviceKeyLoginOptionsRequest,
  DeviceKeyLoginOptionsRequestSchema,
  type DeviceKeyLoginRequest,
  DeviceKeyLoginRequestSchema,
  type RegisterCredentialRequest,
  RegisterCredentialRequestSchema,
  type RegisterDeviceKeyRequest,
  RegisterDeviceKeyRequestSchema,
  type RevokeCredentialRequest,
  RevokeCredentialRequestSchema,
  type WebAuthnOptionsResponse,
} from '@ftms/core';
import { Ctx, type RequestContext } from '../../common/request-context';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { CurrentPrincipal, Public } from '../decorators';
import { type AuthPrincipal } from '../principal';
import { BiometricsService } from './biometrics.service';

const uuid = new ParseUUIDPipe({ version: '7' });

/**
 * Optional biometric sign-in (§4.5, Phase 8): usernameless WebAuthn login in
 * browsers, Android Keystore keys in the app, and each account's own devices —
 * enroll, list, revoke (one revocation route for both kinds). Password and
 * email-code sign-in always remain. Attendance never uses any of this.
 */
@Controller('auth/biometric')
export class BiometricsController {
  constructor(private readonly biometrics: BiometricsService) {}

  @Public()
  @Post('login/options')
  @HttpCode(200)
  loginOptions(@Ctx() context: RequestContext): Promise<WebAuthnOptionsResponse> {
    return this.biometrics.loginOptions(context);
  }

  @Public()
  @Post('login')
  @HttpCode(200)
  login(
    @Body(new ZodValidationPipe(BiometricLoginRequestSchema)) body: BiometricLoginRequest,
    @Ctx() context: RequestContext,
  ): Promise<AuthResponse> {
    return this.biometrics.login(body, context);
  }

  @Get('credentials')
  list(@CurrentPrincipal() principal: AuthPrincipal): Promise<BiometricCredential[]> {
    return this.biometrics.list(principal.userId);
  }

  @Post('credentials/options')
  @HttpCode(200)
  registrationOptions(
    @CurrentPrincipal() principal: AuthPrincipal,
  ): Promise<WebAuthnOptionsResponse> {
    return this.biometrics.registrationOptions(principal);
  }

  @Post('credentials')
  register(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Body(new ZodValidationPipe(RegisterCredentialRequestSchema)) body: RegisterCredentialRequest,
    @Ctx() context: RequestContext,
  ): Promise<BiometricCredential> {
    return this.biometrics.register(principal, body, context);
  }

  /* ── Android device keys (Phase 8) ── */

  @Post('device/options')
  @HttpCode(200)
  deviceRegistrationOptions(
    @CurrentPrincipal() principal: AuthPrincipal,
  ): Promise<DeviceKeyChallenge> {
    return this.biometrics.deviceRegistrationOptions(principal);
  }

  @Post('device')
  registerDevice(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Body(new ZodValidationPipe(RegisterDeviceKeyRequestSchema)) body: RegisterDeviceKeyRequest,
    @Ctx() context: RequestContext,
  ): Promise<BiometricCredential> {
    return this.biometrics.registerDevice(principal, body, context);
  }

  @Public()
  @Post('device/login/options')
  @HttpCode(200)
  deviceLoginOptions(
    @Body(new ZodValidationPipe(DeviceKeyLoginOptionsRequestSchema))
    body: DeviceKeyLoginOptionsRequest,
    @Ctx() context: RequestContext,
  ): Promise<DeviceKeyChallenge> {
    return this.biometrics.deviceLoginOptions(body, context);
  }

  @Public()
  @Post('device/login')
  @HttpCode(200)
  deviceLogin(
    @Body(new ZodValidationPipe(DeviceKeyLoginRequestSchema)) body: DeviceKeyLoginRequest,
    @Ctx() context: RequestContext,
  ): Promise<AuthResponse> {
    return this.biometrics.deviceLogin(body, context);
  }

  @Delete('credentials/:id')
  @HttpCode(204)
  async revoke(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Param('id', uuid) id: string,
    @Body(new ZodValidationPipe(RevokeCredentialRequestSchema)) body: RevokeCredentialRequest,
    @Ctx() context: RequestContext,
  ): Promise<void> {
    await this.biometrics.revoke(principal, id, body.reason, context);
  }
}
