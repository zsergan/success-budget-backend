import { ValidateBy, buildMessage } from 'class-validator';

import { MAX_CALENDAR_DATE, MIN_CALENDAR_DATE, isCalendarDate, resolveTimeZone } from '@shared/utils';

export const CALENDAR_DATE_RULE = `a calendar date as YYYY-MM-DD from ${MIN_CALENDAR_DATE} to ${MAX_CALENDAR_DATE}`;

export const IsCalendarDate = () =>
  ValidateBy({
    name: 'isCalendarDate',
    validator: {
      validate: (value: unknown) => typeof value === 'string' && isCalendarDate(value),
      defaultMessage: buildMessage((eachPrefix) => `${eachPrefix}$property must be ${CALENDAR_DATE_RULE}`),
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
