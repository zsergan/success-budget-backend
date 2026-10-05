import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { CreateTransactionDto } from './create-transaction.dto';

const errorsOf = async <T extends object>(type: new () => T, plain: object) => {
  const dto = plainToInstance(type, plain);
  const errors = await validate(dto, { whitelist: true, forbidNonWhitelisted: true });

  return {
    dto,
    errors: Object.fromEntries(errors.map((error) => [error.property, Object.values(error.constraints ?? {})])),
  };
};

describe('CreateTransactionDto', () => {
  const valid = {
    wallet_id: 1,
    category_id: 5,
    transaction_type: 'expense',
    amount: '12.3',
    timestamp: '2026-01-15T10:00:00.000Z',
  };

  it('accepts a valid request', async () => {
    expect((await errorsOf(CreateTransactionDto, valid)).errors).toEqual({});
  });

  it.each(['0', '0.00'])('refuses the amount %p', async (amount) => {
    expect((await errorsOf(CreateTransactionDto, { ...valid, amount })).errors).toEqual({
      amount: ['amount must be greater than 0'],
    });
  });

  it('reports a malformed amount by its format only', async () => {
    const { errors } = await errorsOf(CreateTransactionDto, { ...valid, amount: '-1' });

    expect(errors.amount).toEqual(['amount must be a non-negative decimal string with at most 2 decimal places']);
  });

  it('refuses a timestamp more than a minute ahead, accepts one within it', async () => {
    const ahead = (ms: number) => new Date(Date.now() + ms).toISOString();

    expect((await errorsOf(CreateTransactionDto, { ...valid, timestamp: ahead(5 * 60_000) })).errors).toEqual({
      timestamp: ['timestamp must not be in the future'],
    });
    expect((await errorsOf(CreateTransactionDto, { ...valid, timestamp: ahead(30_000) })).errors).toEqual({});
  });

  it.each<[unknown, string | null | undefined]>([
    ['  Lunch \n', 'Lunch'],
    ['   ', null],
    ['', null],
    [null, null],
    [undefined, undefined],
  ])('normalizes the description %p to %p', async (description, expected) => {
    const { dto, errors } = await errorsOf(CreateTransactionDto, { ...valid, description });

    expect(errors).toEqual({});
    expect(dto.description).toBe(expected);
  });

  it('counts the description in code points, after trimming', async () => {
    expect((await errorsOf(CreateTransactionDto, { ...valid, description: ` ${'🙂'.repeat(140)} ` })).errors).toEqual(
      {},
    );
    expect((await errorsOf(CreateTransactionDto, { ...valid, description: 'x'.repeat(141) })).errors).toEqual({
      description: ['description must be at most 140 characters'],
    });
  });
});
