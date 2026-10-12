import { applyDecorators } from '@nestjs/common';
import { Transform } from 'class-transformer';
import { IsOptional, IsString, ValidateBy } from 'class-validator';

import {
  AMOUNT_NOT_POSITIVE,
  MAX_DESCRIPTION_LENGTH,
  TIMESTAMP_IN_FUTURE,
  isNotInFuture,
  isPositiveAmount,
  normalizeDescription,
} from '../transaction-rules';
import { parseIsoDate, parseMoneyInput } from '@shared/utils';

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

export const IsNotInFuture = () =>
  ValidateBy({
    name: 'isNotInFuture',
    validator: {
      validate: (value: unknown) => typeof value !== 'string' || parseIsoDate(value) === null || isNotInFuture(value),
      defaultMessage: () => TIMESTAMP_IN_FUTURE,
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
