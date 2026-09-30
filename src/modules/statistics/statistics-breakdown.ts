import { AppColor } from '@shared/enums';
import { formatMoney, roundPercentToTenth } from '@shared/utils';
import type {
  StatisticsCategoryExpense,
  StatisticsWalletExpense,
} from '@modules/transaction-queries/transaction-queries.service';

export const MAX_PRIMARY_GROUPS = 6;
// A product setting, not a mock-up value: about 11° of the donut.
export const OTHER_THRESHOLD_PERCENT = 3n;

export type BreakdownItemKind = 'category' | 'wallet' | 'deleted_wallets' | 'other';

interface BreakdownItemBase<K extends BreakdownItemKind> {
  kind: K;
  key: string;
  id: number | null;
  // null for the service groups: the client names them
  name: string | null;
  icon: string | null;
  color: AppColor | null;
  amount: string;
  percent: number;
  is_archived: boolean;
  opens_history: boolean;
}

export type CategoryItem = BreakdownItemBase<'category'>;
export type WalletItem = BreakdownItemBase<'wallet'>;

export interface DeletedWalletsItem extends BreakdownItemBase<'deleted_wallets'> {
  wallets_count: number;
}

export interface OtherItem<T> extends BreakdownItemBase<'other'> {
  children: T[];
}

export interface CategoryBreakdown {
  total_amount: string;
  source_count: number;
  primary_items: CategoryItem[];
  other: OtherItem<CategoryItem> | null;
}

export interface WalletBreakdown {
  total_amount: string;
  source_count: number;
  primary_items: WalletItem[];
  deleted_wallets: DeletedWalletsItem | null;
  other: OtherItem<WalletItem> | null;
}

export interface Group {
  id: number;
  amount: bigint;
}

// Groups with a zero sum are dropped. At most maxPrimary groups of at least
// the threshold share of total stay, largest first (ties by id); the rest
// is folded. When no group reaches the threshold, the largest one stays.
export const foldGroups = <T extends Group>(
  groups: T[],
  total: bigint,
  maxPrimary: number,
): { primary: T[]; folded: T[] } => {
  const sorted = groups
    .filter((group) => group.amount > 0n)
    .sort((a, b) => (a.amount === b.amount ? a.id - b.id : a.amount > b.amount ? -1 : 1));
  const limit = Math.min(maxPrimary, sorted.length);
  let primaryCount = 0;

  while (primaryCount < limit && sorted[primaryCount].amount * 100n >= total * OTHER_THRESHOLD_PERCENT) {
    primaryCount++;
  }

  if (primaryCount === 0 && limit > 0) {
    primaryCount = 1;
  }

  return { primary: sorted.slice(0, primaryCount), folded: sorted.slice(primaryCount) };
};

const serviceItem = <K extends 'deleted_wallets' | 'other'>(kind: K, amount: bigint, total: bigint) => ({
  kind,
  key: kind,
  id: null,
  name: null,
  icon: null,
  color: null,
  amount: formatMoney(amount),
  percent: roundPercentToTenth(amount, total),
  is_archived: false,
  opens_history: false,
});

export const sumOf = (groups: Group[]): bigint => groups.reduce((sum, group) => sum + group.amount, 0n);

const otherOf = <T>(folded: Group[], children: T[], total: bigint): OtherItem<T> | null =>
  folded.length ? { ...serviceItem('other', sumOf(folded), total), children } : null;

export const buildCategoryBreakdown = (categories: StatisticsCategoryExpense[]): CategoryBreakdown => {
  const total = sumOf(categories);
  const { primary, folded } = foldGroups(categories, total, MAX_PRIMARY_GROUPS);
  const toItem = (category: StatisticsCategoryExpense): CategoryItem => ({
    kind: 'category',
    key: `category:${category.id}`,
    id: category.id,
    name: category.name,
    icon: category.icon,
    color: category.color,
    amount: formatMoney(category.amount),
    percent: roundPercentToTenth(category.amount, total),
    is_archived: category.isArchived,
    opens_history: true,
  });

  return {
    total_amount: formatMoney(total),
    source_count: primary.length + folded.length,
    primary_items: primary.map(toItem),
    other: otherOf(folded, folded.map(toItem), total),
  };
};

// Deleted wallets form one service group outside the threshold and Other;
// with it, one primary slot less keeps the donut within seven segments.
export const buildWalletBreakdown = (wallets: StatisticsWalletExpense[]): WalletBreakdown => {
  const total = sumOf(wallets);
  const deleted = wallets.filter((wallet) => wallet.isDeleted && wallet.amount > 0n);
  const { primary, folded } = foldGroups(
    wallets.filter((wallet) => !wallet.isDeleted),
    total,
    deleted.length ? MAX_PRIMARY_GROUPS - 1 : MAX_PRIMARY_GROUPS,
  );
  const toItem = (wallet: StatisticsWalletExpense): WalletItem => ({
    kind: 'wallet',
    key: `wallet:${wallet.id}`,
    id: wallet.id,
    name: wallet.name,
    icon: null,
    color: wallet.design,
    amount: formatMoney(wallet.amount),
    percent: roundPercentToTenth(wallet.amount, total),
    is_archived: false,
    opens_history: true,
  });

  return {
    total_amount: formatMoney(total),
    source_count: primary.length + folded.length + deleted.length,
    primary_items: primary.map(toItem),
    deleted_wallets: deleted.length
      ? { ...serviceItem('deleted_wallets', sumOf(deleted), total), wallets_count: deleted.length }
      : null,
    other: otherOf(folded, folded.map(toItem), total),
  };
};
