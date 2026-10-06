import { BadRequestException, Injectable, PipeTransform } from '@nestjs/common';

// printable ASCII without spaces, e.g. a UUID
const KEY = /^[\x21-\x7e]{1,255}$/;

@Injectable()
export class ParseIdempotencyKeyPipe implements PipeTransform<unknown, string | undefined> {
  transform(value: unknown): string | undefined {
    if (value === undefined) {
      return undefined;
    }

    if (typeof value !== 'string' || !KEY.test(value)) {
      throw new BadRequestException([
        { field: 'Idempotency-Key', error: 'Idempotency-Key must be 1-255 printable ASCII characters' },
      ]);
    }

    return value;
  }
}
