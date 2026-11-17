import { HttpException } from '@nestjs/common';

import { ErrorMessages } from '@shared/error-messages';
import { buildConfigService } from '@testing';
import { LegacyWritesGuard } from './legacy-writes.guard';

describe('LegacyWritesGuard', () => {
  it('lets v1 writes through while they are enabled, also by default', () => {
    expect(new LegacyWritesGuard(buildConfigService({ LEGACY_WRITES: 'enabled' })).canActivate()).toBe(true);
    expect(new LegacyWritesGuard(buildConfigService()).canActivate()).toBe(true);
  });

  it('refuses them once retired', () => {
    expect(() => new LegacyWritesGuard(buildConfigService({ LEGACY_WRITES: 'retired' })).canActivate()).toThrow(
      new HttpException(ErrorMessages.LEGACY_API_RETIRED, 410),
    );
  });
});
