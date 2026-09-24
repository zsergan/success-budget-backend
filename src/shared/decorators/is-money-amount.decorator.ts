import { ValidateBy, ValidationArguments } from 'class-validator';

import { MAX_MONEY_INPUT, isMoneyInputFormat, parseMoneyInput } from '@shared/utils';

export const IsMoneyAmount = () =>
  ValidateBy({
    name: 'isMoneyAmount',
    validator: {
      validate: (value: unknown) => typeof value === 'string' && parseMoneyInput(value) !== null,
      defaultMessage: ({ value }: ValidationArguments) =>
        isMoneyInputFormat(value)
          ? `$property must not be greater than ${MAX_MONEY_INPUT}`
          : '$property must be a non-negative decimal string with at most 2 decimal places',
    },
  });
