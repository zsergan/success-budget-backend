import type { Category } from '@entities/category.entity';
import type { Transaction } from '@entities/transaction.entity';
import type { Wallet } from '@entities/wallet.entity';
import { AssignmentKind, AuthorSource, PersonStatus, TransactionKind } from '@shared/enums';
import { withRelations } from '@shared/utils';
import { buildCategory, buildTransaction, buildUser, buildWallet } from '@testing';
import { toTransactionView, toTransactionViewV2 } from './transaction-view';

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

describe('toTransactionViewV2', () => {
  const members = new Set([7, 31]);
  const view = (transaction: Partial<Transaction> = {}, category: Partial<Category> = {}) =>
    toTransactionViewV2(
      withRelations(
        buildTransaction({ wallet: buildWallet(), category: buildCategory(category), ...transaction }),
        'wallet',
        'category',
      ),
      members,
    );

  it('lists exactly the public fields: no wallet, the author and the assignment', () => {
    expect(Object.keys(view()).sort()).toEqual([
      'amount',
      'assignment',
      'author',
      'category',
      'description',
      'id',
      'kind',
      'timestamp',
      'transaction_type',
      'version',
    ]);
  });

  it('resolves the author against the members of the space now', () => {
    const author = (author_user_id: number | null, source = AuthorSource.RECORDED) =>
      view({ author_user_id, author_source: source, author: author_user_id ? buildUser({ name: 'Lena' }) : null })
        .author;

    expect(author(31)).toEqual({ user_id: 31, name: 'Lena', status: PersonStatus.MEMBER, source: 'recorded' });
    expect(author(44, AuthorSource.IMPORTED)).toEqual({
      user_id: 44,
      name: 'Lena',
      status: PersonStatus.FORMER_MEMBER,
      source: 'imported',
    });
    expect(author(null)).toEqual({ user_id: null, name: null, status: PersonStatus.DELETED, source: 'recorded' });
  });

  it('keeps a member assignment to a deleted account apart from an unassigned record', () => {
    const assignment = (overrides: Partial<Transaction>) => view(overrides).assignment;

    expect(
      assignment({
        assignment_kind: AssignmentKind.MEMBER,
        assigned_user_id: 7,
        assignedUser: buildUser({ name: 'Zakhar' }),
      }),
    ).toEqual({ kind: 'member', user_id: 7, name: 'Zakhar', status: PersonStatus.MEMBER });
    expect(assignment({ assignment_kind: AssignmentKind.MEMBER, assigned_user_id: null })).toEqual({
      kind: 'member',
      user_id: null,
      name: null,
      status: PersonStatus.DELETED,
    });
    expect(assignment({ assignment_kind: AssignmentKind.UNASSIGNED, assigned_user_id: null })).toEqual({
      kind: 'unassigned',
      user_id: null,
      name: null,
      status: null,
    });
    expect(assignment({ assignment_kind: AssignmentKind.SPACE })).toEqual({
      kind: 'space',
      user_id: null,
      name: null,
      status: null,
    });
  });

  it('marks the initial balance by the system category', () => {
    expect(view({}, { is_system: 1 }).kind).toBe(TransactionKind.INITIAL_BALANCE);
  });
});
