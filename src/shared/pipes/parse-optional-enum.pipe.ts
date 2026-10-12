import { ArgumentMetadata, BadRequestException, Injectable, PipeTransform } from '@nestjs/common';

@Injectable()
export class ParseOptionalEnumPipe<T extends string> implements PipeTransform<unknown, T | undefined> {
  constructor(private readonly values: Record<string, T>) {}

  transform(value: unknown, metadata: ArgumentMetadata): T | undefined {
    if (value === undefined) {
      return undefined;
    }

    const allowed = Object.values(this.values);

    if (typeof value !== 'string' || !allowed.includes(value as T)) {
      const field = metadata.data ?? 'value';
      throw new BadRequestException([{ field, error: `${field} must be one of: ${allowed.join(', ')}` }]);
    }

    return value as T;
  }
}
