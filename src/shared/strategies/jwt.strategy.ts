import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ConfigService } from '@nestjs/config';
import { ExtractJwt, Strategy } from 'passport-jwt';

import { UsersService } from '@modules/users/users.service';
import type { AccessTokenPayload } from '@shared/types';
import type { EnvironmentVariables } from '@config/env.validation';

// users.auth_version starts here, so tokens issued before versioning stay
// valid until the account's first password reset
const UNVERSIONED_TOKEN_VERSION = 1;

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    configService: ConfigService<EnvironmentVariables, true>,
    private readonly usersService: UsersService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: configService.getOrThrow('JWT_SECRET', { infer: true }),
    });
  }

  async validate(payload: AccessTokenPayload) {
    const authVersion = await this.usersService.findAuthVersion(payload.id);

    if (authVersion === null || (payload.ver ?? UNVERSIONED_TOKEN_VERSION) !== authVersion) {
      throw new UnauthorizedException();
    }

    return { id: payload.id };
  }
}
