import { Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { AppConfigService } from '../../config/app-config.service';
import { AUTH } from '../auth.constants';
import { type AuthPrincipal, PrincipalService } from '../principal';
import { type AccessClaims } from '../token.service';

/** Bearer access tokens (web BFF and the future mobile client authenticate identically). */
@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor(
    config: AppConfigService,
    private readonly principals: PrincipalService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      secretOrKey: config.get('JWT_ACCESS_SECRET'),
      algorithms: ['HS256'],
      issuer: AUTH.issuer,
      audience: AUTH.audience,
      ignoreExpiration: false,
    });
  }

  async validate(claims: Partial<AccessClaims>): Promise<AuthPrincipal | false> {
    if (claims.typ !== 'access' || !claims.sub || !claims.sid) return false;
    return (await this.principals.load(claims.sid, claims.sub)) ?? false;
  }
}
