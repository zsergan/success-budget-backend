import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ConfigService } from '@nestjs/config';
import { ExtractJwt, Strategy } from 'passport-jwt';

import { UsersService } from '@modules/users/users.service';
import type { EnvironmentVariables } from '@config/env.validation';

interface JwtPayload {
  id: number;
}

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

  async validate(payload: JwtPayload) {
    const userExists = await this.usersService.exists(payload.id);

    if (!userExists) {
      throw new UnauthorizedException();
    }

    return { id: payload.id };
  }
}
