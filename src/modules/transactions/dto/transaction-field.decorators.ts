import { applyDecorators } from '@nestjs/common';
import { Transform } from 'class-transformer';
import { IsOptional, IsString, ValidateBy, type ValidationArguments } from 'class-validator';

import {
  AMOUNT_NOT_POSITIVE,
  DATE_AFTER_TODAY,
  MAX_DESCRIPTION_LENGTH,
  TIME_ZONE_REQUIRED,
  isNotAfterToday,
  isPositiveAmount,
  normalizeDescription,
} from '../transaction-rules';
import { isCalendarDate, parseMoneyInput, resolveTimeZone } from '@shared/utils';

// Run after the format validators: a malformed value is reported by them.
export const IsPositiveAmount = () =>
  ValidateBy({
    name: 'isPositiveAmount',
    validator: {
      validate: (value: unknown) =>
        typeof value !== 'string' || parseMoneyInput(value) === null || isPositiveAmount(value),
      defaultMessage: () => AMOUNT_NOT_POSITIVE,
    },
  });

const timeZoneOf = (args: ValidationArguments): string | null => {
  const { time_zone: timeZone } = args.object as { time_zone?: unknown };

  return typeof timeZone === 'string' ? resolveTimeZone(timeZone) : null;
};

// Needs a valid time_zone on the same object; without one, time_zone is the error.
export const IsNotAfterToday = () =>
  ValidateBy({
    name: 'isNotAfterToday',
    validator: {
      validate: (value: unknown, args) => {
        const timeZone = timeZoneOf(args!);

        return typeof value !== 'string' || !isCalendarDate(value) || !timeZone || isNotAfterToday(value, timeZone);
      },
      defaultMessage: () => DATE_AFTER_TODAY,
    },
  });

// Optional, but required whenever the object carries a date.
export const IsTimeZoneWithDate = () =>
  ValidateBy({
    name: 'isTimeZoneWithDate',
    validator: {
      validate: (value: unknown, args) =>
        value === undefined
          ? (args!.object as { date?: unknown }).date === undefined
          : typeof value === 'string' && resolveTimeZone(value) !== null,
      defaultMessage: (args) =>
        args?.value === undefined ? TIME_ZONE_REQUIRED : `${args?.property} must be an IANA time zone name`,
    },
  });

// Optional and nullable; trimmed, and blank becomes null before validation.
// The length counts code points, so an emoji outside the BMP counts as one.
export const IsDescription = () =>
  applyDecorators(
    Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? normalizeDescription(value) : value)),
    IsOptional(),
    IsString(),
    ValidateBy({
      name: 'maxCodePoints',
      validator: {
        validate: (value: unknown) => typeof value !== 'string' || [...value].length <= MAX_DESCRIPTION_LENGTH,
        defaultMessage: () => `description must be at most ${MAX_DESCRIPTION_LENGTH} characters`,
      },
    }),
  );
