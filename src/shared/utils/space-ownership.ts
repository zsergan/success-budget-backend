import { HttpStatus } from '@nestjs/common';

import { ApiException } from '@shared/api.exception';
import type { ErrorCode } from '@shared/error-messages';

export function assertBelongsToSpace<T extends { space_id: number }>(
  resource: T | null | undefined,
  spaceId: number,
  code: ErrorCode,
): asserts resource is T {
  if (!resource || resource.space_id !== spaceId) {
    throw new ApiException(code, HttpStatus.FORBIDDEN);
  }
}
