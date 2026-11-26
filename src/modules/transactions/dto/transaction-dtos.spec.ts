import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { CreateTransactionDto } from './create-transaction.dto';
import { UpdateTransactionDto } from './update-transaction.dto';
import { TransactionFeedQueryDto } from './transaction-feed-query.dto';

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
    category_id: 5,
    transaction_type: 'expense',
    amount: '12.3',
    date: '2026-01-15',
    time_zone: 'Europe/Moscow',
  };

  it('accepts a valid request', async () => {
    expect((await errorsOf(CreateTransactionDto, valid)).errors).toEqual({});
  });

  it.each(['0', '0.00'])('refuses the amount %p', async (amount) => {
    expect((await errorsOf(CreateTransactionDto, { ...valid, amount })).errors).toEqual({
      amount: ['amount must be greater than 0'],
    });
  });

  it('reports an amount above the maximum by its range only', async () => {
    const { errors } = await errorsOf(CreateTransactionDto, { ...valid, amount: '100000000' });

    expect(errors.amount).toEqual(['amount must not be greater than 99999999.99']);
  });

  it('reports a malformed amount by its format only', async () => {
    const { errors } = await errorsOf(CreateTransactionDto, { ...valid, amount: '-1' });

    expect(errors.amount).toEqual(['amount must be a non-negative decimal string with at most 2 decimal places']);
  });

  const DATE_FORMAT = 'date must be a calendar date as YYYY-MM-DD from 1000-01-01 to 9999-12-31';

  it.each<unknown>([
    '2026-01-15T10:00:00.000Z',
    '2026-01-15T10:00:00',
    '2026-01-15+03:00',
    '2026-01-15Z',
    '2026-1-15',
    '15.01.2026',
    '2026-02-29',
    '2026-04-31',
    '2026-13-01',
    '0999-12-31',
    '',
    20260115,
  ])('refuses the date %p', async (date) => {
    expect((await errorsOf(CreateTransactionDto, { ...valid, date })).errors).toEqual({ date: [DATE_FORMAT] });
  });

  it.each(['2024-02-29', '2000-02-29', '1969-12-31', '1000-01-01'])('accepts the date %p', async (date) => {
    expect((await errorsOf(CreateTransactionDto, { ...valid, date })).errors).toEqual({});
  });

  it('requires the date and the zone that tells today', async () => {
    const body: Record<string, unknown> = { ...valid };
    delete body.date;
    delete body.time_zone;

    expect(Object.keys((await errorsOf(CreateTransactionDto, body)).errors).sort()).toEqual(['date', 'time_zone']);
  });

  it.each(['+03:00', 'UTC+3', 'Mars/Olympus', ''])('refuses the time_zone %p', async (time_zone) => {
    expect((await errorsOf(CreateTransactionDto, { ...valid, time_zone })).errors).toEqual({
      time_zone: ['time_zone must be an IANA time zone name'],
    });
  });

  it('refuses a timestamp, the field of earlier releases', async () => {
    expect(
      Object.keys((await errorsOf(CreateTransactionDto, { ...valid, timestamp: '2026-01-15T10:00:00.000Z' })).errors),
    ).toEqual(['timestamp']);
  });

  describe('today in time_zone', () => {
    afterEach(() => jest.useRealTimers());

    const at = (now: string) => jest.useFakeTimers({ now: new Date(now) });
    const check = async (date: string, time_zone: string) =>
      (await errorsOf(CreateTransactionDto, { ...valid, date, time_zone })).errors;
    const AFTER_TODAY = { date: ['date must not be after today in time_zone'] };

    it('accepts today and earlier in the zone, refuses tomorrow', async () => {
      // 21:30 UTC: already the 9th in Moscow, still the 8th in Chicago
      at('2026-10-08T21:30:00.000Z');

      expect(await check('2026-10-09', 'Europe/Moscow')).toEqual({});
      expect(await check('2026-10-08', 'America/Chicago')).toEqual({});
      expect(await check('2026-10-09', 'America/Chicago')).toEqual(AFTER_TODAY);
      expect(await check('2026-10-09', 'Pacific/Kiritimati')).toEqual({});
      expect(await check('2026-10-10', 'Pacific/Kiritimati')).toEqual(AFTER_TODAY);
    });

    it('gives a device clock up to a minute ahead the next day at midnight', async () => {
      at('2026-10-08T23:59:30.000Z');
      expect(await check('2026-10-09', 'UTC')).toEqual({});

      at('2026-10-08T23:58:30.000Z');
      expect(await check('2026-10-09', 'UTC')).toEqual(AFTER_TODAY);
    });

    it('takes a midnight after a DST change like any other', async () => {
      // 00:30 CDT, the first half hour of the day DST ends in Chicago
      at('2026-11-01T05:30:00.000Z');
      expect(await check('2026-11-01', 'America/Chicago')).toEqual({});
      expect(await check('2026-11-02', 'America/Chicago')).toEqual(AFTER_TODAY);
    });
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

  it('requires a calendar date for a date', async () => {
    expect(
      (await errorsOf(UpdateTransactionDto, { date: '2026-01-15T10:00:00.000Z', time_zone: 'UTC' })).errors,
    ).toEqual({ date: ['date must be a calendar date as YYYY-MM-DD from 1000-01-01 to 9999-12-31'] });
  });

  it('requires a time_zone with a date, and only then', async () => {
    expect((await errorsOf(UpdateTransactionDto, { date: '2026-01-15' })).errors).toEqual({
      time_zone: ['time_zone is required with date'],
    });
    expect((await errorsOf(UpdateTransactionDto, { date: '2026-01-15', time_zone: '+03:00' })).errors).toEqual({
      time_zone: ['time_zone must be an IANA time zone name'],
    });
    expect((await errorsOf(UpdateTransactionDto, { amount: '5' })).errors).toEqual({});
    expect((await errorsOf(UpdateTransactionDto, { amount: '5', time_zone: 'UTC' })).errors).toEqual({});
  });

  it('leaves the amount and date rules for new values to the service', async () => {
    const { errors } = await errorsOf(UpdateTransactionDto, { amount: '0', date: '2999-01-01', time_zone: 'UTC' });

    expect(errors).toEqual({});
  });

  it('refuses a timestamp, the field of earlier releases', async () => {
    expect(Object.keys((await errorsOf(UpdateTransactionDto, { timestamp: '2026-01-15T10:00:00Z' })).errors)).toEqual([
      'timestamp',
    ]);
  });

  it.each(['category_id', 'transaction_type', 'amount', 'date'])('refuses a null %s', async (field) => {
    expect((await errorsOf(UpdateTransactionDto, { [field]: null })).errors[field]).toContain(
      `${field} must not be null`,
    );
  });

  it('takes a null description as clearing it', async () => {
    const { dto, errors } = await errorsOf(UpdateTransactionDto, { description: null });

    expect(errors).toEqual({});
    expect(dto.description).toBeNull();
  });

  it('refuses an unknown field', async () => {
    expect(Object.keys((await errorsOf(UpdateTransactionDto, { kind: 'regular' })).errors)).toEqual(['kind']);
  });
});

describe('TransactionFeedQueryDto', () => {
  const valid = { from_date: '2026-10-01', to_date: '2026-10-31' };

  it('accepts a minimal query with a page of 50', async () => {
    const { dto, errors } = await errorsOf(TransactionFeedQueryDto, valid);

    expect(errors).toEqual({});
    expect(dto.limit).toBe(50);
  });

  it.each(['from_date', 'to_date'])('requires %s', async (field) => {
    expect(Object.keys((await errorsOf(TransactionFeedQueryDto, { ...valid, [field]: undefined })).errors)).toEqual([
      field,
    ]);
  });

  it.each<unknown>([
    '2026-10-01T00:00:00.000Z',
    '2026-10-01T00:00:00',
    '2026-02-30',
    '2026-10',
    ['2026-10-01', '2026-10-02'],
  ])('refuses the date %p', async (from_date) => {
    expect(Object.keys((await errorsOf(TransactionFeedQueryDto, { ...valid, from_date })).errors)).toEqual([
      'from_date',
    ]);
  });

  it('takes any dates of the DATE range, those a TIMESTAMP could not hold included', async () => {
    expect(
      (await errorsOf(TransactionFeedQueryDto, { from_date: '1000-01-01', to_date: '9999-12-31' })).errors,
    ).toEqual({});
  });

  it.each(['from', 'to', 'time_zone'])('refuses %s, a parameter of earlier releases', async (field) => {
    expect(Object.keys((await errorsOf(TransactionFeedQueryDto, { ...valid, [field]: 'UTC' })).errors)).toEqual([
      field,
    ]);
  });

  it.each(['1', '100'])('accepts the limit %p', async (limit) => {
    expect((await errorsOf(TransactionFeedQueryDto, { ...valid, limit })).dto.limit).toBe(Number(limit));
  });

  it.each(['0', '101', '1.5', '-1', 'ten', '', ['5', '6']])('refuses the limit %p', async (limit) => {
    expect(Object.keys((await errorsOf(TransactionFeedQueryDto, { ...valid, limit })).errors)).toEqual(['limit']);
  });

  it.each<[string, string | undefined]>([
    ['  coffee  beans ', 'coffee  beans'],
    ['   ', undefined],
    ['', undefined],
  ])('trims q %p to %p', async (q, expected) => {
    const { dto, errors } = await errorsOf(TransactionFeedQueryDto, { ...valid, q });

    expect(errors).toEqual({});
    expect(dto.q).toBe(expected);
  });

  it('counts q in code points after trimming and refuses, not cuts, a longer one', async () => {
    expect((await errorsOf(TransactionFeedQueryDto, { ...valid, q: ` ${'🙂'.repeat(255)} ` })).errors).toEqual({});
    expect((await errorsOf(TransactionFeedQueryDto, { ...valid, q: 'x'.repeat(256) })).errors).toEqual({
      q: ['q must be at most 255 characters'],
    });
  });

  it('refuses a repeated q', async () => {
    expect(Object.keys((await errorsOf(TransactionFeedQueryDto, { ...valid, q: ['a', 'b'] })).errors)).toEqual(['q']);
  });

  it('turns numeric filters into numbers', async () => {
    const { dto, errors } = await errorsOf(TransactionFeedQueryDto, { ...valid, category_id: '12' });

    expect(errors).toEqual({});
    expect(dto).toMatchObject({ category_id: 12 });
  });

  it.each(['0', '2147483648', '1e3', 'abc'])('refuses the category_id %p', async (category_id) => {
    expect(Object.keys((await errorsOf(TransactionFeedQueryDto, { ...valid, category_id })).errors)).toEqual([
      'category_id',
    ]);
  });

  it('refuses an unknown parameter', async () => {
    expect(Object.keys((await errorsOf(TransactionFeedQueryDto, { ...valid, page: '2' })).errors)).toEqual(['page']);
  });
});
