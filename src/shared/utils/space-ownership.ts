import { HttpException, HttpStatus } from '@nestjs/common';

export function assertBelongsToSpace<T extends { space_id: number }>(
  resource: T | null | undefined,
  spaceId: number,
  errorMessage: string,
): asserts resource is T {
  if (!resource || resource.space_id !== spaceId) {
    throw new HttpException(errorMessage, HttpStatus.FORBIDDEN);
  }
}
