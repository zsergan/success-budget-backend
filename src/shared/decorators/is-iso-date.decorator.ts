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

const TIMESTAMP_MIN = new Date('1970-01-01T00:00:01.000Z');
const TIMESTAMP_MAX = new Date('2038-01-19T03:14:07.000Z');

// A MySQL TIMESTAMP column rejects anything outside this range at insert time.
export const IsInTimestampRange = () =>
  ValidateBy({
    name: 'isInTimestampRange',
    validator: {
      validate: (value: unknown) => {
        const date = typeof value === 'string' ? parseIsoDate(value) : null;

        return date === null || (date >= TIMESTAMP_MIN && date <= TIMESTAMP_MAX);
      },
      defaultMessage: buildMessage(
        (eachPrefix) =>
          `${eachPrefix}$property must be between ${TIMESTAMP_MIN.toISOString()} and ${TIMESTAMP_MAX.toISOString()}`,
      ),
    },
  });
