import { ValidateBy, buildMessage } from 'class-validator';

import { parseLocalDate, resolveTimeZone } from '@shared/utils';

export const IsLocalDate = () =>
  ValidateBy({
    name: 'isLocalDate',
    validator: {
      validate: (value: unknown) => typeof value === 'string' && parseLocalDate(value) !== null,
      defaultMessage: buildMessage((eachPrefix) => `${eachPrefix}$property must be a calendar date as YYYY-MM-DD`),
    },
  });

export const IsTimeZone = () =>
  ValidateBy({
    name: 'isTimeZone',
    validator: {
      validate: (value: unknown) => typeof value === 'string' && resolveTimeZone(value) !== null,
      defaultMessage: buildMessage((eachPrefix) => `${eachPrefix}$property must be an IANA time zone name`),
    },
  });
