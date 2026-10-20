import { Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import type { Request } from 'express';
import { Strategy } from 'passport-local';
import { type RequestContext } from '../../common/request-context';
import { AuthService } from '../auth.service';
import { type UserWithRelations } from '../../users/user-mapping';

/** Email-or-seat-number + password (§4.3). */
@Injectable()
export class LocalStrategy extends PassportStrategy(Strategy, 'local') {
  constructor(private readonly auth: AuthService) {
    super({ usernameField: 'identifier', passwordField: 'password', passReqToCallback: true });
  }

  validate(
    req: Request & { ftmsContext?: RequestContext },
    identifier: string,
    password: string,
  ): Promise<UserWithRelations> {
    const context = req.ftmsContext ?? { ip: null, userAgent: null };
    return this.auth.validatePassword(identifier, password, context);
  }
}
