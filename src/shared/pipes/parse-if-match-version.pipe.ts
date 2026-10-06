import { BadRequestException, Injectable, PipeTransform } from '@nestjs/common';

// a single strong entity tag holding the record version: "3"; the bare
// number is accepted too
const VERSION_TAG = /^(?:"([1-9]\d{0,9})"|([1-9]\d{0,9}))$/;
const MAX_VERSION = 4_294_967_295;

@Injectable()
export class ParseIfMatchVersionPipe implements PipeTransform<unknown, number | undefined> {
  transform(value: unknown): number | undefined {
    if (value === undefined) {
      return undefined;
    }

    const match = typeof value === 'string' ? VERSION_TAG.exec(value.trim()) : null;
    const version = match ? Number(match[1] ?? match[2]) : NaN;

    if (!(version <= MAX_VERSION)) {
      throw new BadRequestException([{ field: 'If-Match', error: 'If-Match must be a record version, e.g. "3"' }]);
    }

    return version;
  }
}
