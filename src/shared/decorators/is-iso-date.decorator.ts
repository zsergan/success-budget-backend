import { ValidateBy, buildMessage } from 'class-validator';

import { parseIsoDate } from '@shared/utils';

export const IsIsoDate = () =>
  ValidateBy({
    name: 'isIsoDate',
    validator: {
      validate: (value: unknown) => typeof value === 'string' && parseIsoDate(value) !== null,
      defaultMessage: buildMessage((eachPrefix) => `${eachPrefix}$property must be a valid ISO 8601 date`),
    },
  });
