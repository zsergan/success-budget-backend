import { HttpStatus } from '@nestjs/common';

import { ApiException } from '@shared/api.exception';
import type { ErrorCode } from '@shared/error-messages';

export function assertFound<T>(resource: T | null | undefined, code: ErrorCode = 'NOT_FOUND'): asserts resource is T {
  if (resource === null || resource === undefined) {
    throw new ApiException(code, HttpStatus.NOT_FOUND);
  }
}
