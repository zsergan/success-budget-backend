import { ArgumentMetadata, BadRequestException, Injectable, PipeTransform } from '@nestjs/common';

import { resolveTimeZone } from '@shared/utils';

// The canonical IANA name, or undefined when absent. Fixed offsets are refused: they ignore DST.
@Injectable()
export class ParseOptionalTimeZonePipe implements PipeTransform<unknown, string | undefined> {
  transform(value: unknown, metadata: ArgumentMetadata): string | undefined {
    if (value === undefined) {
      return undefined;
    }

    const timeZone = typeof value === 'string' ? resolveTimeZone(value) : null;

    if (!timeZone) {
      const field = metadata.data ?? 'value';
      throw new BadRequestException([{ field, error: `${field} must be an IANA time zone name` }]);
    }

    return timeZone;
  }
}
