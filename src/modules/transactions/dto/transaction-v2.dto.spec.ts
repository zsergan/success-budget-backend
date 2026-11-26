import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { CreateTransactionV2Dto, UpdateTransactionV2Dto } from './transaction-v2.dto';
import { TransactionCountQueryV2Dto, TransactionFeedQueryV2Dto } from './transaction-feed-query-v2.dto';
import { formatValidationErrors } from '../../../app.config';

const fieldsOf = async <T extends object>(type: new () => T, plain: object) => {
  const dto = plainToInstance(type, plain);
  const errors = await validate(dto, { whitelist: true, forbidNonWhitelisted: true });

  return formatValidationErrors(errors).map((error) => error.field);
};

describe('CreateTransactionV2Dto', () => {
  const valid = {
    category_id: 5,
    transaction_type: 'expense',
    amount: '12.3',
    date: '2026-01-15',
    time_zone: 'Europe/Moscow',
    assignment: { kind: 'member', user_id: 31 },
  };

  it.each([{ kind: 'member', user_id: 31 }, { kind: 'space' }, { kind: 'unassigned' }])(
    'accepts the assignment %p',
    async (assignment) => {
      expect(await fieldsOf(CreateTransactionV2Dto, { ...valid, assignment })).toEqual([]);
    },
  );

  it.each<[unknown, string]>([
    [undefined, 'assignment'],
    [null, 'assignment'],
    ['space', 'assignment'],
    [{ kind: 'everyone' }, 'assignment.kind'],
    [{ kind: 'member' }, 'assignment.user_id'],
    [{ kind: 'member', user_id: 0 }, 'assignment.user_id'],
    [{ kind: 'member', user_id: '31' }, 'assignment.user_id'],
    [{ kind: 'space', user_id: 31 }, 'assignment.user_id'],
    [{ kind: 'unassigned', user_id: null }, 'assignment.user_id'],
    [{ kind: 'space', name: 'Lena' }, 'assignment.name'],
  ])('refuses the assignment %p at %s', async (assignment, field) => {
    expect(await fieldsOf(CreateTransactionV2Dto, { ...valid, assignment })).toContain(field);
  });

  it.each(['wallet_id', 'author', 'author_user_id', 'space_id', 'timestamp', 'order_key'])(
    'refuses %s',
    async (field) => {
      expect(await fieldsOf(CreateTransactionV2Dto, { ...valid, [field]: 1 })).toEqual([field]);
    },
  );

  it('keeps the v1 field rules', async () => {
    expect(await fieldsOf(CreateTransactionV2Dto, { ...valid, amount: '0' })).toEqual(['amount']);
  });
});

describe('UpdateTransactionV2Dto', () => {
  it('accepts an empty body and an assignment alone', async () => {
    expect(await fieldsOf(UpdateTransactionV2Dto, {})).toEqual([]);
    expect(await fieldsOf(UpdateTransactionV2Dto, { assignment: { kind: 'space' } })).toEqual([]);
  });

  it('refuses a null assignment and a wallet', async () => {
    expect(await fieldsOf(UpdateTransactionV2Dto, { assignment: null })).toEqual(['assignment']);
    expect(await fieldsOf(UpdateTransactionV2Dto, { wallet_id: 3 })).toEqual(['wallet_id']);
  });
});

describe('TransactionFeedQueryV2Dto', () => {
  const valid = { from_date: '2026-10-01', to_date: '2026-10-31' };

  it.each(['space', 'unassigned', 'deleted_member', 'member:31'])('accepts the assignment %p', async (assignment) => {
    expect(await fieldsOf(TransactionFeedQueryV2Dto, { ...valid, assignment })).toEqual([]);
  });

  it.each(['', 'member', 'member:0', 'wallet:3', 'Space', ['space', 'unassigned']])(
    'refuses the assignment %p',
    async (assignment) => {
      expect(await fieldsOf(TransactionFeedQueryV2Dto, { ...valid, assignment })).toEqual(['assignment']);
    },
  );

  it('refuses a wallet filter', async () => {
    expect(await fieldsOf(TransactionFeedQueryV2Dto, { ...valid, wallet_id: '3' })).toEqual(['wallet_id']);
  });

  it('counts with required dates and no paging', async () => {
    expect(await fieldsOf(TransactionCountQueryV2Dto, { ...valid, assignment: 'space' })).toEqual([]);
    expect(await fieldsOf(TransactionCountQueryV2Dto, { to_date: valid.to_date })).toEqual(['from_date']);
    expect(await fieldsOf(TransactionCountQueryV2Dto, { ...valid, limit: '5' })).toEqual(['limit']);
  });

  it.each(['from', 'to', 'time_zone'])('refuses the parameter %s of earlier releases', async (field) => {
    expect(await fieldsOf(TransactionFeedQueryV2Dto, { ...valid, [field]: '2026-10-01T00:00:00.000Z' })).toEqual([
      field,
    ]);
    expect(await fieldsOf(TransactionCountQueryV2Dto, { ...valid, [field]: 'Europe/Moscow' })).toEqual([field]);
  });
});
