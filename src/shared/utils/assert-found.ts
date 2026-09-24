import { HttpException, HttpStatus } from '@nestjs/common';

import { ErrorMessages } from '@shared/error-messages';

export function assertFound<T>(
  resource: T | null | undefined,
  errorMessage: string = ErrorMessages.NOT_FOUND,
): asserts resource is T {
  if (resource === null || resource === undefined) {
    throw new HttpException(errorMessage, HttpStatus.NOT_FOUND);
  }
}
