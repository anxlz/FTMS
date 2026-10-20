import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { UsersService } from '../users/users.service';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { ChallengeService } from './challenge.service';
import {
  JwtAuthGuard,
  LocalAuthGuard,
  PasswordSetupGuard,
  PermissionsGuard,
  RolesGuard,
} from './guards/auth.guards';
import { PrincipalService } from './principal';
import { SessionService } from './session.service';
import { JwtStrategy } from './strategies/jwt.strategy';
import { LocalStrategy } from './strategies/local.strategy';
import { TokenService } from './token.service';

@Module({
  // Secrets are passed per call (separate access/refresh secrets), so none is registered here.
  imports: [PassportModule, JwtModule.register({})],
  controllers: [AuthController],
  providers: [
    AuthService,
    ChallengeService,
    PrincipalService,
    SessionService,
    TokenService,
    UsersService,
    JwtStrategy,
    LocalStrategy,
    LocalAuthGuard,
    // Order matters: authenticate, then password gate, then roles, then permissions.
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: PasswordSetupGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
    { provide: APP_GUARD, useClass: PermissionsGuard },
  ],
  exports: [UsersService, SessionService],
})
export class AuthModule {}
