import { buildCategoryBreakdown, buildWalletBreakdown, foldGroups } from './statistics-breakdown';
import { AppColor } from '@shared/enums';
import { parseMoney } from '@shared/utils';
import type {
  StatisticsCategoryExpense,
  StatisticsWalletExpense,
} from '@modules/transaction-queries/transaction-queries.service';

const groups = (...amounts: string[]) => amounts.map((amount, i) => ({ id: i + 1, amount: parseMoney(amount) }));
const ids = (list: { id: number }[]) => list.map((group) => group.id);
const fold = (list: { id: number; amount: bigint }[], maxPrimary = 6) => {
  const total = list.reduce((sum, group) => sum + group.amount, 0n);
  const { primary, folded } = foldGroups(list, total, maxPrimary);

  return { primary: ids(primary), folded: ids(folded) };
};

const category = (id: number, name: string, amount: string, overrides: Partial<StatisticsCategoryExpense> = {}) => ({
  id,
  name,
  icon: 'cart',
  color: AppColor.SLATE,
  isArchived: false,
  amount: parseMoney(amount),
  count: 1,
  ...overrides,
});

const wallet = (id: number, amount: string, isDeleted = false): StatisticsWalletExpense => ({
  id,
  name: `Wallet ${id}`,
  design: AppColor.SLATE,
  isDeleted,
  amount: parseMoney(amount),
  count: 1,
});

describe('foldGroups', () => {
  it('keeps a single group whole', () => {
    expect(fold(groups('100.00'))).toEqual({ primary: [1], folded: [] });
  });

  it('keeps 50/30/20 as three groups', () => {
    expect(fold(groups('50.00', '30.00', '20.00'))).toEqual({ primary: [1, 2, 3], folded: [] });
  });

  it('folds thin slices under 3% even with free primary slots', () => {
    expect(fold(groups('98.00', '1.00', '1.00'))).toEqual({ primary: [1], folded: [2, 3] });
  });

  it('keeps at most six primary groups', () => {
    const eight = groups('12.60', '12.50', '12.50', '12.50', '12.50', '12.50', '12.50', '12.40');

    expect(fold(eight)).toEqual({ primary: [1, 2, 3, 4, 5, 6], folded: [7, 8] });
  });

  it('checks the threshold on exact amounts, before rounding', () => {
    // 3.00 of 100.00 is exactly 3%; 2.99 of 100.00 would round to 3.0%
    expect(fold(groups('94.01', '3.00', '2.99'))).toEqual({ primary: [1, 2], folded: [3] });
  });

  it('keeps the largest group when none reaches the threshold', () => {
    const forty = Array.from({ length: 40 }, (_, i) => ({ id: i + 1, amount: 100n + BigInt(i) }));

    expect(fold(forty)).toEqual({
      primary: [40],
      folded: forty
        .slice(0, 39)
        .map((g) => g.id)
        .reverse(),
    });
  });

  it('drops zero groups and breaks ties by id', () => {
    const list = [
      { id: 7, amount: 500n },
      { id: 3, amount: 0n },
      { id: 5, amount: 500n },
      { id: 9, amount: 1000n },
    ];

    expect(fold(list)).toEqual({ primary: [9, 5, 7], folded: [] });
  });

  it('respects a smaller limit', () => {
    expect(fold(groups('30.00', '30.00', '40.00'), 2)).toEqual({ primary: [3, 1], folded: [2] });
  });

  it('returns nothing for nothing', () => {
    expect(fold([])).toEqual({ primary: [], folded: [] });
  });
});

describe('buildCategoryBreakdown', () => {
  // the mock-up: ten categories, six primary for 2593.49, four in Other for 270.91
  const mockUp = [
    category(1, 'Rent', '900.00'),
    category(2, 'Groceries', '612.30'),
    category(3, 'Transport', '420.19'),
    category(4, 'Home', '300.00'),
    category(5, 'Travel', '211.00'),
    category(6, 'Fun', '150.00'),
    category(7, 'Cafe', '96.40'),
    category(8, 'Health', '78.20'),
    category(9, 'Clothes', '58.50'),
    category(10, 'Gifts', '37.81', { isArchived: true }),
  ];

  it('folds the mock-up into six primary categories and Other with the children inline', () => {
    const result = buildCategoryBreakdown([...mockUp].reverse());

    expect(result.total_amount).toBe('2864.40');
    expect(result.source_count).toBe(10);
    expect(result.primary_items.map((item) => item.name)).toEqual([
      'Rent',
      'Groceries',
      'Transport',
      'Home',
      'Travel',
      'Fun',
    ]);
    expect(result.primary_items[0]).toEqual({
      kind: 'category',
      key: 'category:1',
      id: 1,
      name: 'Rent',
      icon: 'cart',
      color: AppColor.SLATE,
      amount: '900.00',
      percent: 31.4,
      is_archived: false,
      opens_history: true,
    });
    expect(result.other).toEqual({
      kind: 'other',
      key: 'other',
      id: null,
      name: null,
      icon: null,
      color: null,
      amount: '270.91',
      // from the exact sum; the children's rounded percents add up to 9.4
      percent: 9.5,
      is_archived: false,
      opens_history: false,
      children: [
        expect.objectContaining({ key: 'category:7', amount: '96.40', percent: 3.4 }),
        expect.objectContaining({ key: 'category:8', amount: '78.20', percent: 2.7 }),
        expect.objectContaining({ key: 'category:9', amount: '58.50', percent: 2 }),
        expect.objectContaining({ key: 'category:10', amount: '37.81', percent: 1.3, is_archived: true }),
      ],
    });
  });

  it('tells a real category named Other from the aggregate by kind and id', () => {
    const result = buildCategoryBreakdown([category(1, 'Other', '90.00'), category(2, 'Pets', '10.00')]);

    expect(result.primary_items[0]).toMatchObject({ kind: 'category', key: 'category:1', id: 1, name: 'Other' });
    expect(result.other).toBeNull();
  });

  it('leaves zero categories out of the list and the count', () => {
    const result = buildCategoryBreakdown([category(1, 'Rent', '10.00'), category(2, 'Fees', '0.00')]);

    expect(result.source_count).toBe(1);
    expect(result.primary_items).toHaveLength(1);
  });

  it('is empty without expenses', () => {
    expect(buildCategoryBreakdown([category(1, 'Fees', '0.00')])).toEqual({
      total_amount: '0.00',
      source_count: 0,
      primary_items: [],
      other: null,
    });
  });
});

describe('buildWalletBreakdown', () => {
  it('keeps deleted wallets as one service group and five primary slots', () => {
    const result = buildWalletBreakdown([
      wallet(1, '30.00'),
      wallet(2, '20.00'),
      wallet(3, '15.00'),
      wallet(4, '10.00'),
      wallet(5, '8.00'),
      wallet(6, '7.00'),
      wallet(7, '6.00', true),
      wallet(8, '4.00', true),
      wallet(9, '0.00', true),
    ]);

    expect(result.total_amount).toBe('100.00');
    // real wallets with positive expenses, deleted ones included
    expect(result.source_count).toBe(8);
    expect(result.primary_items.map((item) => item.id)).toEqual([1, 2, 3, 4, 5]);
    expect(result.primary_items[0]).toMatchObject({
      kind: 'wallet',
      key: 'wallet:1',
      icon: null,
      is_archived: false,
      opens_history: true,
    });
    expect(result.deleted_wallets).toEqual({
      kind: 'deleted_wallets',
      key: 'deleted_wallets',
      id: null,
      name: null,
      icon: null,
      color: null,
      amount: '10.00',
      percent: 10,
      is_archived: false,
      opens_history: false,
      wallets_count: 2,
    });
    expect(result.other).toMatchObject({ amount: '7.00', percent: 7, children: [expect.objectContaining({ id: 6 })] });
  });

  it('keeps a small deleted group outside the threshold and six slots without it', () => {
    const withSmallDeleted = buildWalletBreakdown([wallet(1, '99.00'), wallet(2, '1.00', true)]);

    expect(withSmallDeleted.deleted_wallets).toMatchObject({ amount: '1.00', percent: 1 });
    expect(withSmallDeleted.other).toBeNull();

    const seven = buildWalletBreakdown([1, 2, 3, 4, 5, 6, 7].map((id) => wallet(id, '10.00')));

    expect(seven.primary_items).toHaveLength(6);
    expect(seven.deleted_wallets).toBeNull();
    expect(seven.other?.children).toHaveLength(1);
  });

  it('does not show a zero deleted group', () => {
    expect(buildWalletBreakdown([wallet(1, '5.00'), wallet(2, '0.00', true)])).toMatchObject({
      source_count: 1,
      deleted_wallets: null,
    });
  });
});
