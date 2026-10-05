import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository, SelectQueryBuilder } from 'typeorm';

import { Transaction } from '@entities/transaction.entity';
import { AppColor, TransactionType } from '@shared/enums';
import type { WithRelations } from '@shared/types';
import { parseMoney, withRelations } from '@shared/utils';

export type LoadedTransaction = WithRelations<Transaction, 'wallet' | 'category'>;

export interface TransactionFilters {
  transactionType?: TransactionType;
  categoryId?: number;
  walletId?: number;
}

// in cents
export interface WalletPeriodTotals {
  income: bigint;
  spend: bigint;
}

type TotalsRow = Record<'income' | 'income_count' | 'expense' | 'expense_count', string | null>;

const toStatisticsTotals = (row: TotalsRow | undefined): StatisticsTotals => ({
  income: parseMoney(row?.income ?? '0'),
  incomeCount: Number(row?.income_count ?? 0),
  expense: parseMoney(row?.expense ?? '0'),
  expenseCount: Number(row?.expense_count ?? 0),
});

export interface StatisticsCategoryExpense {
  id: number;
  name: string;
  icon: string;
  color: AppColor;
  isArchived: boolean;
  // in cents
  amount: bigint;
  count: number;
}

export interface StatisticsWalletExpense {
  id: number;
  name: string;
  design: AppColor;
  isDeleted: boolean;
  // in cents
  amount: bigint;
  count: number;
}

// in cents
export interface StatisticsTotals {
  income: bigint;
  incomeCount: number;
  expense: bigint;
  expenseCount: number;
}

@Injectable()
export class TransactionQueriesService {
  constructor(
    @InjectRepository(Transaction)
    private readonly transactionRepository: Repository<Transaction>,
  ) {}

  // shared by GET /spaces/:spaceId/wallets and TransactionsService.create()'s
  // previous_balance - no lock, informational only: the balance is always
  // recomputed from history and never depends on the order concurrent
  // requests resolve in. Balances are in cents.
  async getBalances(walletIds: number[]): Promise<Map<number, bigint>> {
    const balances = new Map(walletIds.map((id) => [id, 0n]));

    if (walletIds.length === 0) {
      return balances;
    }

    const rows = await this.transactionRepository
      .createQueryBuilder('transaction')
      .select('transaction.wallet_id', 'wallet_id')
      .addSelect(
        'SUM(CASE WHEN transaction.transaction_type = :income THEN transaction.amount ELSE -transaction.amount END)',
        'balance',
      )
      .where('transaction.wallet_id IN (:...walletIds)', { walletIds })
      .setParameter('income', TransactionType.INCOME)
      .groupBy('transaction.wallet_id')
      .getRawMany<{ wallet_id: string; balance: string }>();

    rows.forEach((row) => balances.set(Number(row.wallet_id), parseMoney(row.balance)));

    return balances;
  }

  async getOneWithWallet(transactionId: string): Promise<WithRelations<Transaction, 'wallet'> | null> {
    const transaction = await this.transactionRepository
      .createQueryBuilder('transaction')
      .innerJoinAndSelect('transaction.wallet', 'wallet')
      .where('transaction.id = :transactionId', { transactionId })
      .getOne();

    return transaction && withRelations(transaction, 'wallet');
  }

  // Scoped through the transaction's own wallet, soft-deleted included, so a
  // transaction of another space is not found rather than forbidden.
  async getOneInSpace(spaceId: number, transactionId: string): Promise<LoadedTransaction | null> {
    const transaction = await this.transactionRepository
      .createQueryBuilder('transaction')
      .innerJoinAndSelect('transaction.wallet', 'wallet')
      .innerJoinAndSelect('transaction.category', 'category')
      .where('transaction.id = :transactionId', { transactionId })
      .andWhere('wallet.space_id = :spaceId', { spaceId })
      .getOne();

    return transaction && withRelations(transaction, 'wallet', 'category');
  }

  // one aggregated query for GET /spaces/:spaceId/wallets - the period
  // income/spend per wallet, grouped in SQL instead of filtering a raw
  // transaction-row fetch in JS. All-time balance is a separate concern,
  // still served by getBalances().
  async getPeriodTotals(walletIds: number[], from: Date, to: Date): Promise<Map<number, WalletPeriodTotals>> {
    const totals = new Map<number, WalletPeriodTotals>(walletIds.map((id) => [id, { income: 0n, spend: 0n }]));

    if (walletIds.length === 0) {
      return totals;
    }

    const rows = await this.transactionRepository
      .createQueryBuilder('transaction')
      .select('transaction.wallet_id', 'wallet_id')
      .addSelect('SUM(CASE WHEN transaction.transaction_type = :income THEN transaction.amount ELSE 0 END)', 'income')
      .addSelect('SUM(CASE WHEN transaction.transaction_type = :expense THEN transaction.amount ELSE 0 END)', 'spend')
      .where('transaction.wallet_id IN (:...walletIds)', { walletIds })
      .andWhere('transaction.timestamp >= :from', { from })
      .andWhere('transaction.timestamp <= :to', { to })
      .setParameter('income', TransactionType.INCOME)
      .setParameter('expense', TransactionType.EXPENSE)
      .groupBy('transaction.wallet_id')
      .getRawMany<{ wallet_id: string; income: string; spend: string }>();

    rows.forEach((row) =>
      totals.set(Number(row.wallet_id), { income: parseMoney(row.income), spend: parseMoney(row.spend) }),
    );

    return totals;
  }

  // one aggregated query for GET /spaces/:spaceId/limits - every category's
  // expense spend for the period, grouped in SQL. Joined to wallet only to
  // scope by space_id (still includes deleted-wallet history, since limits
  // track space spend, not per-wallet); no wallet/category entities loaded.
  // Sums are in cents.
  async getExpensesByCategory(spaceId: number, from: Date, to: Date): Promise<Map<number, bigint>> {
    const rows = await this.transactionRepository
      .createQueryBuilder('transaction')
      .innerJoin('transaction.wallet', 'wallet')
      .select('transaction.category_id', 'category_id')
      .addSelect('SUM(transaction.amount)', 'spent')
      .where('wallet.space_id = :spaceId', { spaceId })
      .andWhere('transaction.transaction_type = :expense', { expense: TransactionType.EXPENSE })
      .andWhere('transaction.timestamp >= :from', { from })
      .andWhere('transaction.timestamp <= :to', { to })
      .groupBy('transaction.category_id')
      .getRawMany<{ category_id: number; spent: string }>();

    return new Map(rows.map((row) => [Number(row.category_id), parseMoney(row.spent)]));
  }

  async getForAllWallets(
    spaceId: number,
    from: Date,
    to: Date,
    filters: TransactionFilters = {},
  ): Promise<LoadedTransaction[]> {
    const query = this.transactionRepository
      .createQueryBuilder('transaction')
      .innerJoinAndSelect('transaction.wallet', 'wallet')
      .innerJoinAndSelect('transaction.category', 'category')
      .where('wallet.space_id = :spaceId', { spaceId })
      .andWhere('transaction.timestamp >= :from', { from })
      .andWhere('transaction.timestamp <= :to', { to });

    if (filters.transactionType) {
      query.andWhere('transaction.transaction_type = :transactionType', { transactionType: filters.transactionType });
    }

    if (filters.categoryId) {
      query.andWhere('transaction.category_id = :categoryId', { categoryId: filters.categoryId });
    }

    if (filters.walletId) {
      query.andWhere('transaction.wallet_id = :walletId', { walletId: filters.walletId });
    }

    const transactions = await query.orderBy('transaction.timestamp', 'DESC').getMany();

    return transactions.map((transaction) => withRelations(transaction, 'wallet', 'category'));
  }

  async getLatest(spaceId: number): Promise<LoadedTransaction | null> {
    const transaction = await this.transactionRepository
      .createQueryBuilder('transaction')
      .innerJoinAndSelect('transaction.wallet', 'wallet')
      .innerJoinAndSelect('transaction.category', 'category')
      .where('wallet.space_id = :spaceId', { spaceId })
      .orderBy('transaction.timestamp', 'DESC')
      // Deterministic tie-break for the (now rare, since timestamp is
      // millisecond-precision) case of two transactions landing on the
      // exact same value - a single "latest" result can't be left to
      // depend on MySQL's unspecified tie order.
      .addOrderBy('transaction.id', 'DESC')
      .limit(1)
      .getOne();

    return transaction && withRelations(transaction, 'wallet', 'category');
  }

  // The statistics reads below take the manager of the block's transaction,
  // so that all reads of one response see the same snapshot.
  async getStatisticsTotals(spaceId: number, from: Date, to: Date, manager: EntityManager): Promise<StatisticsTotals> {
    const row = await this.selectStatisticsTotals(
      this.statisticsScope(manager, spaceId, from, to),
    ).getRawOne<TotalsRow>();

    return toStatisticsTotals(row);
  }

  // Totals per interval in one query. Intervals are consecutive and the
  // i-th one ends at intervalEnds[i]; the last end only closes the list,
  // since the scope already ends at `to`.
  async getStatisticsIntervalTotals(
    spaceId: number,
    from: Date,
    to: Date,
    intervalEnds: Date[],
  ): Promise<StatisticsTotals[]> {
    const last = intervalEnds.length - 1;
    const cases = intervalEnds
      .slice(0, last)
      .map((_, i) => `WHEN transaction.timestamp <= :intervalEnd${i} THEN ${i}`)
      .join(' ');

    const rows = await this.selectStatisticsTotals(
      this.statisticsScope(this.transactionRepository.manager, spaceId, from, to),
    )
      .addSelect(last > 0 ? `CASE ${cases} ELSE ${last} END` : '0', 'interval_index')
      .setParameters(Object.fromEntries(intervalEnds.slice(0, last).map((end, i) => [`intervalEnd${i}`, end])))
      .groupBy('interval_index')
      .getRawMany<TotalsRow & { interval_index: string | number }>();

    const totals = intervalEnds.map(() => toStatisticsTotals(undefined));

    for (const row of rows) {
      totals[Number(row.interval_index)] = toStatisticsTotals(row);
    }

    return totals;
  }

  async getStatisticsExpenseByCategory(
    spaceId: number,
    from: Date,
    to: Date,
    manager: EntityManager,
  ): Promise<StatisticsCategoryExpense[]> {
    const rows = await this.statisticsExpenseScope(manager, spaceId, from, to)
      .select('category.id', 'id')
      .addSelect('category.name', 'name')
      .addSelect('category.icon', 'icon')
      .addSelect('category.color', 'color')
      .addSelect('category.is_active', 'is_active')
      .addSelect('SUM(transaction.amount)', 'amount')
      .addSelect('COUNT(*)', 'count')
      .groupBy('category.id')
      .getRawMany<{
        id: number | string;
        name: string;
        icon: string;
        color: AppColor;
        is_active: number | string;
        amount: string;
        count: number | string;
      }>();

    return rows.map((row) => ({
      id: Number(row.id),
      name: row.name,
      icon: row.icon,
      color: row.color,
      isArchived: Number(row.is_active) === 0,
      amount: parseMoney(row.amount),
      count: Number(row.count),
    }));
  }

  async getStatisticsExpenseByWallet(
    spaceId: number,
    from: Date,
    to: Date,
    manager: EntityManager,
  ): Promise<StatisticsWalletExpense[]> {
    const rows = await this.statisticsExpenseScope(manager, spaceId, from, to)
      .select('wallet.id', 'id')
      .addSelect('wallet.wallet_name', 'name')
      .addSelect('wallet.design', 'design')
      .addSelect('wallet.is_deleted', 'is_deleted')
      .addSelect('SUM(transaction.amount)', 'amount')
      .addSelect('COUNT(*)', 'count')
      .groupBy('wallet.id')
      .getRawMany<{
        id: number | string;
        name: string;
        design: AppColor;
        is_deleted: number | string;
        amount: string;
        count: number | string;
      }>();

    return rows.map((row) => ({
      id: Number(row.id),
      name: row.name,
      design: row.design,
      isDeleted: Number(row.is_deleted) === 1,
      amount: parseMoney(row.amount),
      count: Number(row.count),
    }));
  }

  // Latest timestamp of any statistics transaction up to `to`, in any period.
  async getLastStatisticsTimestamp(spaceId: number, to: Date, manager: EntityManager): Promise<Date | null> {
    const transaction = await this.statisticsScope(manager, spaceId, null, to)
      .select(['transaction.id', 'transaction.timestamp'])
      .orderBy('transaction.timestamp', 'DESC')
      .limit(1)
      .getOne();

    return transaction?.timestamp ?? null;
  }

  private statisticsExpenseScope(
    manager: EntityManager,
    spaceId: number,
    from: Date,
    to: Date,
  ): SelectQueryBuilder<Transaction> {
    return this.statisticsScope(manager, spaceId, from, to).andWhere('transaction.transaction_type = :expense', {
      expense: TransactionType.EXPENSE,
    });
  }

  private selectStatisticsTotals(query: SelectQueryBuilder<Transaction>): SelectQueryBuilder<Transaction> {
    return query
      .select('SUM(CASE WHEN transaction.transaction_type = :income THEN transaction.amount ELSE 0 END)', 'income')
      .addSelect('SUM(CASE WHEN transaction.transaction_type = :income THEN 1 ELSE 0 END)', 'income_count')
      .addSelect('SUM(CASE WHEN transaction.transaction_type = :expense THEN transaction.amount ELSE 0 END)', 'expense')
      .addSelect('SUM(CASE WHEN transaction.transaction_type = :expense THEN 1 ELSE 0 END)', 'expense_count')
      .setParameter('income', TransactionType.INCOME)
      .setParameter('expense', TransactionType.EXPENSE);
  }

  // The selection every statistics block shares (docs/statistics-contract.md):
  // all wallets of the space, soft-deleted ones included, without starting
  // balances, both bounds inclusive.
  private statisticsScope(
    manager: EntityManager,
    spaceId: number,
    from: Date | null,
    to: Date,
  ): SelectQueryBuilder<Transaction> {
    const query = manager
      .createQueryBuilder(Transaction, 'transaction')
      .innerJoin('transaction.wallet', 'wallet')
      .innerJoin('transaction.category', 'category')
      .where('wallet.space_id = :spaceId', { spaceId })
      .andWhere('category.is_system = 0');

    if (from) {
      query.andWhere('transaction.timestamp >= :from', { from });
    }

    return query.andWhere('transaction.timestamp <= :to', { to });
  }
}
