import { ArgumentMetadata, BadRequestException, Injectable, PipeTransform } from '@nestjs/common';

import { parseIsoDate } from '@shared/utils';

// An absent value stays undefined so the handler's default parameter applies.
@Injectable()
export class ParseOptionalDatePipe implements PipeTransform<unknown, Date | undefined> {
  transform(value: unknown, metadata: ArgumentMetadata): Date | undefined {
    if (value === undefined) {
      return undefined;
    }

    const date = typeof value === 'string' ? parseIsoDate(value) : null;

    if (!date) {
      const field = metadata.data ?? 'value';
      throw new BadRequestException([{ field, error: `${field} must be a valid ISO 8601 date` }]);
    }

    return date;
  }
}
