import { type CanActivate, HttpStatus, Injectable, UseGuards, applyDecorators } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiGoneResponse } from '@nestjs/swagger';

import { ApiException } from '@shared/api.exception';
import type { EnvironmentVariables } from '@config/env.validation';

// On the v1 transaction and wallet writes, which only builds older than the
// v2 transactions API send. Runs before validation, so a retired write is
// refused as such whatever its body.
@Injectable()
export class LegacyWritesGuard implements CanActivate {
  constructor(private readonly configService: ConfigService<EnvironmentVariables, true>) {}

  canActivate(): boolean {
    if (this.configService.get('LEGACY_WRITES', { infer: true }) === 'retired') {
      throw new ApiException('LEGACY_API_RETIRED', HttpStatus.GONE);
    }

    return true;
  }
}

export const LegacyWrite = () =>
  applyDecorators(
    UseGuards(LegacyWritesGuard),
    ApiGoneResponse({ description: 'LEGACY_API_RETIRED: v1 writes are retired; the app must be updated.' }),
  );
