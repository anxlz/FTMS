import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { type Role } from '@ftms/core';
import { AppConfigService } from '../config/app-config.service';
import { AUTH } from './auth.constants';

export interface AccessClaims {
  sub: string;
  sid: string;
  role: Role;
  typ: 'access';
}

export interface RefreshClaims {
  sub: string;
  sid: string;
  jti: string;
  typ: 'refresh';
}

/**
 * Signs and verifies the two JWT kinds with separate secrets, so an access token
 * can never be replayed as a refresh token or vice versa (`typ` is checked too).
 */
@Injectable()
export class TokenService {
  constructor(
    private readonly jwt: JwtService,
    private readonly config: AppConfigService,
  ) {}

  async signAccess(claims: Omit<AccessClaims, 'typ'>): Promise<{ token: string; expiresAt: Date }> {
    const expiresAt = new Date(Date.now() + AUTH.accessTokenSeconds * 1000);
    const token = await this.jwt.signAsync(
      { sid: claims.sid, role: claims.role, typ: 'access' },
      {
        secret: this.config.get('JWT_ACCESS_SECRET'),
        algorithm: 'HS256',
        subject: claims.sub,
        issuer: AUTH.issuer,
        audience: AUTH.audience,
        expiresIn: AUTH.accessTokenSeconds,
      },
    );
    return { token, expiresAt };
  }

  async signRefresh(
    claims: Omit<RefreshClaims, 'typ'>,
    expiresAt: Date,
  ): Promise<{ token: string; expiresAt: Date }> {
    const seconds = Math.max(1, Math.floor((expiresAt.getTime() - Date.now()) / 1000));
    const token = await this.jwt.signAsync(
      { sid: claims.sid, typ: 'refresh' },
      {
        secret: this.config.get('JWT_REFRESH_SECRET'),
        algorithm: 'HS256',
        subject: claims.sub,
        jwtid: claims.jti,
        issuer: AUTH.issuer,
        audience: AUTH.audience,
        expiresIn: seconds,
      },
    );
    return { token, expiresAt };
  }

  /** Returns the claims, or `null` for any invalid, expired or wrong-type token. */
  async verifyRefresh(token: string): Promise<RefreshClaims | null> {
    try {
      const claims = await this.jwt.verifyAsync<Partial<RefreshClaims>>(token, {
        secret: this.config.get('JWT_REFRESH_SECRET'),
        algorithms: ['HS256'],
        issuer: AUTH.issuer,
        audience: AUTH.audience,
      });
      if (claims.typ !== 'refresh' || !claims.sub || !claims.sid || !claims.jti) return null;
      return claims as RefreshClaims;
    } catch {
      return null;
    }
  }
}
