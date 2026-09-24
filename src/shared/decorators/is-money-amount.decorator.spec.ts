import { validate } from 'class-validator';

import { IsMoneyAmount } from './is-money-amount.decorator';

class Dto {
  @IsMoneyAmount()
  amount: unknown;
}

const errorFor = async (amount: unknown) => {
  const dto = new Dto();
  dto.amount = amount;
  const [error] = await validate(dto);

  return error?.constraints?.isMoneyAmount;
};

describe('IsMoneyAmount', () => {
  it.each(['0', '0.01', '12.3', '99999999.99'])('accepts %p', async (amount) => {
    expect(await errorFor(amount)).toBeUndefined();
  });

  it.each(['-1', '1.234', '.5', '', 12.3, null, undefined])('rejects the malformed %p', async (amount) => {
    expect(await errorFor(amount)).toBe('amount must be a non-negative decimal string with at most 2 decimal places');
  });

  it.each(['100000000', '100000000.00'])('rejects %p above the range', async (amount) => {
    expect(await errorFor(amount)).toBe('amount must not be greater than 99999999.99');
  });
});
