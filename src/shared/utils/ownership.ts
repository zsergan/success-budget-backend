import { HttpException, HttpStatus } from '@nestjs/common';

export function assertOwnership<T extends { user_id: number }>(
  resource: T | null | undefined,
  userId: number,
  errorMessage: string,
): asserts resource is T {
  if (!resource || resource.user_id !== userId) {
    throw new HttpException(errorMessage, HttpStatus.FORBIDDEN);
  }
}
