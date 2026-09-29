import { ArgumentMetadata, BadRequestException, Injectable, PipeTransform } from '@nestjs/common';

const ID = /^[1-9]\d{0,9}$/;
// MySQL signed INT, the type of every id column
const MAX_ID = 2_147_483_647;

@Injectable()
export class ParseOptionalIdPipe implements PipeTransform<unknown, number | undefined> {
  transform(value: unknown, metadata: ArgumentMetadata): number | undefined {
    if (value === undefined) {
      return undefined;
    }

    // the global ValidationPipe has already turned a numeric string into a number
    const text = typeof value === 'number' ? String(value) : value;
    const id = typeof text === 'string' && ID.test(text) ? Number(text) : NaN;

    if (!(id <= MAX_ID)) {
      const field = metadata.data ?? 'value';
      throw new BadRequestException([{ field, error: `${field} must be a positive integer id` }]);
    }

    return id;
  }
}
