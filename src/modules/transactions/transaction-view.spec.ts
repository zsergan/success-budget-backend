import type { Category } from '@entities/category.entity';
import type { Transaction } from '@entities/transaction.entity';
import type { Wallet } from '@entities/wallet.entity';
import { TransactionKind } from '@shared/enums';
import { withRelations } from '@shared/utils';
import { buildCategory, buildTransaction, buildWallet } from '@testing';
import { toTransactionView } from './transaction-view';

describe('toTransactionView', () => {
  const view = (
    transaction: Partial<Transaction> = {},
    wallet: Partial<Wallet> = {},
    category: Partial<Category> = {},
  ) =>
    toTransactionView(
      withRelations(
        buildTransaction({ ...transaction, wallet: buildWallet(wallet), category: buildCategory(category) }),
        'wallet',
        'category',
      ),
    );

  it('lists exactly the public fields, without internal columns', () => {
    const result = view({ wallet_id: 1, category_id: 1 });

    expect(Object.keys(result).sort()).toEqual([
      'amount',
      'category',
      'description',
      'id',
      'kind',
      'timestamp',
      'transaction_type',
      'version',
      'wallet',
    ]);
    expect(Object.keys(result.wallet!).sort()).toEqual(['created_at', 'design', 'id', 'updated_at', 'wallet_name']);
    expect(Object.keys(result.category).sort()).toEqual([
      'color',
      'created_at',
      'icon',
      'id',
      'is_active',
      'is_archived',
      'name',
      'transaction_type',
      'updated_at',
    ]);
  });

  it('tells the initial balance from a regular transaction by the system category', () => {
    expect(view({}, {}, { is_system: 0 }).kind).toBe(TransactionKind.REGULAR);
    expect(view({}, {}, { is_system: 1, name: 'Renamed' }).kind).toBe(TransactionKind.INITIAL_BALANCE);
  });

  it('nulls the wallet once it is soft-deleted', () => {
    expect(view({}, { id: 3 }).wallet).toEqual(expect.objectContaining({ id: 3 }));
    expect(view({}, { id: 3, is_deleted: 1, deleted_at: new Date() }).wallet).toBeNull();
  });

  it('marks an archived category', () => {
    expect(view().category.is_archived).toBe(false);
    expect(view({}, {}, { is_active: 0, archived_at: new Date() }).category).toEqual(
      expect.objectContaining({ is_active: 0, is_archived: true }),
    );
  });

  it.each([
    [null, null],
    ['', null],
    ['  \n', null],
    ['Lunch', 'Lunch'],
  ])('returns the description %j as %j', (description, expected) => {
    expect(view({ description }).description).toBe(expected);
  });

  it('carries the stored amount and version', () => {
    expect(view({ amount: '12.30', version: 4 })).toEqual(expect.objectContaining({ amount: '12.30', version: 4 }));
  });
});
