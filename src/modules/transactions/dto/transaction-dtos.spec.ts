import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { CreateTransactionDto } from './create-transaction.dto';
import { UpdateTransactionDto } from './update-transaction.dto';

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

  it.each(['2026-01-15', '2026-01-15T10:00:00', '2026-01-15T10:00:00.000'])(
    'refuses the timestamp %p without Z or an offset',
    async (timestamp) => {
      expect((await errorsOf(CreateTransactionDto, { ...valid, timestamp })).errors).toEqual({
        timestamp: ['timestamp must be an ISO 8601 date-time with Z or a UTC offset'],
      });
    },
  );

  it.each(['2026-01-15T10:00:00Z', '2026-01-15T10:00:00.250+03:00', '2026-01-15T10:00:00-0530'])(
    'accepts the instant %p',
    async (timestamp) => {
      expect((await errorsOf(CreateTransactionDto, { ...valid, timestamp })).errors).toEqual({});
    },
  );

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

describe('UpdateTransactionDto', () => {
  it('accepts an empty body', async () => {
    expect((await errorsOf(UpdateTransactionDto, {})).errors).toEqual({});
  });

  it('requires an instant for a timestamp', async () => {
    expect((await errorsOf(UpdateTransactionDto, { timestamp: '2026-01-15' })).errors).toEqual({
      timestamp: ['timestamp must be an ISO 8601 date-time with Z or a UTC offset'],
    });
  });

  it('leaves the amount and timestamp rules for new values to the service', async () => {
    const { errors } = await errorsOf(UpdateTransactionDto, { amount: '0', timestamp: '2037-01-01T00:00:00.000Z' });

    expect(errors).toEqual({});
  });

  it.each(['wallet_id', 'category_id', 'transaction_type', 'amount', 'timestamp'])(
    'refuses a null %s',
    async (field) => {
      expect((await errorsOf(UpdateTransactionDto, { [field]: null })).errors[field]).toContain(
        `${field} must not be null`,
      );
    },
  );

  it('takes a null description as clearing it', async () => {
    const { dto, errors } = await errorsOf(UpdateTransactionDto, { description: null });

    expect(errors).toEqual({});
    expect(dto.description).toBeNull();
  });

  it('refuses an unknown field', async () => {
    expect(Object.keys((await errorsOf(UpdateTransactionDto, { kind: 'regular' })).errors)).toEqual(['kind']);
  });
});
