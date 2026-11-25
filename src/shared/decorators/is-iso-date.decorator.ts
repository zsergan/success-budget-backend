import { ValidateBy, buildMessage } from 'class-validator';

import { parseIsoDate } from '@shared/utils';

const EXPLICIT_OFFSET = /[T ].*(Z|[+-]\d{2}:?\d{2})$/;

// An exact instant: the zone must be explicit, since a local value would be
// read in the server's zone.
export const IsIsoInstant = () =>
  ValidateBy({
    name: 'isIsoInstant',
    validator: {
      validate: (value: unknown) =>
        typeof value === 'string' && EXPLICIT_OFFSET.test(value) && parseIsoDate(value) !== null,
      defaultMessage: buildMessage(
        (eachPrefix) => `${eachPrefix}$property must be an ISO 8601 date-time with Z or a UTC offset`,
      ),
    },
  });
