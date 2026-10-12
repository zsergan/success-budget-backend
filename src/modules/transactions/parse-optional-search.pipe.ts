import { BadRequestException, Injectable, PipeTransform } from '@nestjs/common';

import { SEARCH_TOO_LONG, isSearchWithinLimit, normalizeSearch } from './transaction-rules';

// The feed's q rules for a route without a query DTO: undefined when absent or blank.
@Injectable()
export class ParseOptionalSearchPipe implements PipeTransform<unknown, string | undefined> {
  transform(value: unknown): string | undefined {
    if (value === undefined) {
      return undefined;
    }

    if (typeof value !== 'string') {
      throw new BadRequestException([{ field: 'q', error: 'q must be a string' }]);
    }

    const search = normalizeSearch(value);

    if (search !== undefined && !isSearchWithinLimit(search)) {
      throw new BadRequestException([{ field: 'q', error: SEARCH_TOO_LONG }]);
    }

    return search;
  }
}
