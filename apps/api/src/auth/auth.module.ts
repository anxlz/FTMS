import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { UsersService } from '../users/users.service';
import { AuthController } from './auth.controller';
import { BiometricsController } from './biometrics/biometrics.controller';
import { BiometricsService } from './biometrics/biometrics.service';
import { WebAuthnChallenges, WebAuthnSettings } from './biometrics/webauthn';
import { AuthService } from './auth.service';
import { ChallengeService } from './challenge.service';
import {
  JwtAuthGuard,
  LocalAuthGuard,
  PasswordSetupGuard,
  PermissionsGuard,
  RolesGuard,
  VerificationGuard,
} from './guards/auth.guards';
import { PrincipalService } from './principal';
import { SessionService } from './session.service';
import { StudentLinkingService } from './student-linking.service';
import { JwtStrategy } from './strategies/jwt.strategy';
import { LocalStrategy } from './strategies/local.strategy';
import { TokenService } from './token.service';

@Module({
  // Secrets are passed per call (separate access/refresh secrets), so none is registered here.
  imports: [PassportModule, JwtModule.register({})],
  controllers: [AuthController, BiometricsController],
  providers: [
    AuthService,
    BiometricsService,
    WebAuthnChallenges,
    WebAuthnSettings,
    ChallengeService,
    PrincipalService,
    SessionService,
    StudentLinkingService,
    TokenService,
    UsersService,
    JwtStrategy,
    LocalStrategy,
    LocalAuthGuard,
    // Order matters: authenticate, password gate, verification gate, roles, permissions.
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: PasswordSetupGuard },
    { provide: APP_GUARD, useClass: VerificationGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
    { provide: APP_GUARD, useClass: PermissionsGuard },
  ],
  exports: [
    UsersService,
    SessionService,
    StudentLinkingService,
    BiometricsService,
    WebAuthnChallenges,
    WebAuthnSettings,
  ],
})
export class AuthModule {}
