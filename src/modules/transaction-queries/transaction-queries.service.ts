import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository, SelectQueryBuilder } from 'typeorm';

import { Transaction } from '@entities/transaction.entity';
import { Wallet } from '@entities/wallet.entity';
import { AppColor, TransactionKind, TransactionType } from '@shared/enums';
import type { WithRelations } from '@shared/types';
import { parseMoney, withRelations } from '@shared/utils';
import { STORED_TIMESTAMP_MAX, TIMESTAMP_MIN } from '@shared/decorators/is-iso-date.decorator';

export type LoadedTransaction = WithRelations<Transaction, 'wallet' | 'category'>;

export interface TransactionFilters {
  transactionType?: TransactionType;
  kind?: TransactionKind;
  categoryId?: number;
  walletId?: number;
  // trimmed here too; blank means no text condition
  search?: string;
}

// What the history and the feed select: one space, both bounds inclusive.
// The bounds may lie outside what a TIMESTAMP column holds.
export interface TransactionSelection {
  spaceId: number;
  from: Date;
  to: Date;
  filters?: TransactionFilters;
}

// A place in the history order (timestamp, then id, both descending).
export interface FeedPosition {
  timestamp: Date;
  id: string;
}

export interface FeedPageRequest {
  limit: number;
  // older than this position; or newer than `before`, never both
  after?: FeedPosition;
  before?: FeedPosition;
}

export interface FeedPage {
  // newest first
  items: LoadedTransaction[];
  // more records of the selection further in the direction that was read
  hasMore: boolean;
}

// in cents; initial balances count in `count` only
export interface FeedSummary {
  count: number;
  income: bigint;
  expense: bigint;
}

export interface TimeInterval {
  from: Date;
  to: Date;
}

// Searched text is compared in one fixed collation, whatever the columns or
// the server default use: case- and accent-insensitive, Cyrillic included.
export const SEARCH_COLLATION = 'utf8mb4_0900_ai_ci';
const SEARCH_ESCAPE = '!';

export const toSearchPattern = (search: string): string => `%${search.replace(/[!%_]/g, (char) => `!${char}`)}%`;

const searchable = (expression: string) => `CONVERT(${expression} USING utf8mb4) COLLATE ${SEARCH_COLLATION}`;

// `pattern` is a bound parameter holding toSearchPattern() of the text.
export const searchMatch = (column: string, pattern: string): string =>
  `${searchable(column)} LIKE ${searchable(pattern)} ESCAPE '${SEARCH_ESCAPE}'`;

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

export interface StatisticsCategoryGroup {
  id: number;
  name: string;
  icon: string;
  color: AppColor;
  isArchived: boolean;
  // in cents
  amount: bigint;
  count: number;
}

export interface StatisticsWalletGroup {
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

const clampToStored = (date: Date): Date =>
  new Date(Math.min(Math.max(date.getTime(), TIMESTAMP_MIN.getTime()), STORED_TIMESTAMP_MAX.getTime()));

@Injectable()
export class TransactionQueriesService {
  constructor(
    @InjectRepository(Transaction)
    private readonly transactionRepository: Repository<Transaction>,
  ) {}

  // Balances are in cents. Transaction writes pass their manager, holding
  // the wallet rows locked, so the balance cannot change before they commit.
  async getBalances(walletIds: number[], manager?: EntityManager): Promise<Map<number, bigint>> {
    const balances = new Map(walletIds.map((id) => [id, 0n]));

    if (walletIds.length === 0) {
      return balances;
    }

    const rows = await this.repository(manager)
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

  // Scoped through the transaction's own wallet, soft-deleted included, so a
  // transaction of another space is not found rather than forbidden.
  async getOneInSpace(
    spaceId: number,
    transactionId: string,
    manager?: EntityManager,
  ): Promise<LoadedTransaction | null> {
    const transaction = await this.repository(manager)
      .createQueryBuilder('transaction')
      .innerJoinAndSelect('transaction.wallet', 'wallet')
      .innerJoinAndSelect('transaction.category', 'category')
      .where('transaction.id = :transactionId', { transactionId })
      .andWhere('wallet.space_id = :spaceId', { spaceId })
      .getOne();

    return transaction && withRelations(transaction, 'wallet', 'category');
  }

  // one aggregated query for GET /spaces/:spaceId/wallets - the period
  // income/spend per wallet, grouped in SQL. Initial balances are not income
  // here, as in statistics; they only count in the balance (getBalances()).
  async getPeriodTotals(
    walletIds: number[],
    from: Date,
    to: Date,
    manager?: EntityManager,
  ): Promise<Map<number, WalletPeriodTotals>> {
    const totals = new Map<number, WalletPeriodTotals>(walletIds.map((id) => [id, { income: 0n, spend: 0n }]));

    if (walletIds.length === 0) {
      return totals;
    }

    const rows = await this.repository(manager)
      .createQueryBuilder('transaction')
      .innerJoin('transaction.category', 'category')
      .select('transaction.wallet_id', 'wallet_id')
      .addSelect('SUM(CASE WHEN transaction.transaction_type = :income THEN transaction.amount ELSE 0 END)', 'income')
      .addSelect('SUM(CASE WHEN transaction.transaction_type = :expense THEN transaction.amount ELSE 0 END)', 'spend')
      .where('transaction.wallet_id IN (:...walletIds)', { walletIds })
      .andWhere('category.is_system = 0')
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
  async getExpensesByCategory(
    spaceId: number,
    from: Date,
    to: Date,
    manager?: EntityManager,
  ): Promise<Map<number, bigint>> {
    const rows = await this.repository(manager)
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

  // the number of records the feed pages through for the same selection
  async countForAllWallets(spaceId: number, from: Date, to: Date, filters: TransactionFilters = {}): Promise<number> {
    const selection = { spaceId, from, to, filters };
    const walletIds = await this.selectionWallets(selection);

    return walletIds.length === 0 ? 0 : this.selectionScope(selection, walletIds).getCount();
  }

  // Up to `limit` records of the selection next to a position, in the
  // history order. One more is read to tell whether the direction goes on.
  // Each wallet is read as its own branch: with a constant wallet_id, MySQL
  // walks (wallet_id, timestamp, id) in index order and stops at the limit,
  // so the cost does not grow with the history; only the branches' heads are
  // sorted together.
  async getFeedPage(
    selection: TransactionSelection,
    page: FeedPageRequest,
    manager?: EntityManager,
  ): Promise<FeedPage> {
    const walletIds = await this.selectionWallets(selection, manager);

    if (walletIds.length === 0) {
      return { items: [], hasMore: false };
    }

    const newer = page.before !== undefined;
    const position = page.before ?? page.after;
    const direction = newer ? 'ASC' : 'DESC';
    const branches = walletIds.map((walletId) => {
      const branch = this.selectionScope(selection, [walletId], manager)
        .select('transaction.id', 'id')
        .addSelect('transaction.timestamp', 'timestamp');

      if (position) {
        const operator = newer ? '>' : '<';
        branch.andWhere(
          `transaction.timestamp ${operator}= :positionTimestamp AND ` +
            `(transaction.timestamp ${operator} :positionTimestamp OR transaction.id ${operator} :positionId)`,
          { positionTimestamp: position.timestamp, positionId: position.id },
        );
      }

      return branch
        .orderBy('transaction.timestamp', direction)
        .addOrderBy('transaction.id', direction)
        .limit(page.limit + 1)
        .getQueryAndParameters();
    });

    const rows: { id: string }[] = await (manager ?? this.transactionRepository.manager).query(
      `SELECT page.id FROM (${branches.map(([sql]) => `(${sql})`).join(' UNION ALL ')}) page ` +
        `ORDER BY page.\`timestamp\` ${direction}, page.id ${direction} LIMIT ${page.limit + 1}`,
      branches.flatMap(([, parameters]) => parameters),
    );
    const ids = rows.slice(0, page.limit).map((row) => row.id);
    const items = await this.loadInOrder(ids, manager);

    return { items: newer ? items.reverse() : items, hasMore: rows.length > page.limit };
  }

  async getFeedSummary(selection: TransactionSelection, manager?: EntityManager): Promise<FeedSummary> {
    const walletIds = await this.selectionWallets(selection, manager);

    if (walletIds.length === 0) {
      return { count: 0, income: 0n, expense: 0n };
    }

    const row = await this.selectionScope(selection, walletIds, manager)
      .select('COUNT(*)', 'count')
      .addSelect(
        'SUM(CASE WHEN category.is_system = 0 AND transaction.transaction_type = :income THEN transaction.amount ELSE 0 END)',
        'income',
      )
      .addSelect(
        'SUM(CASE WHEN category.is_system = 0 AND transaction.transaction_type = :expense THEN transaction.amount ELSE 0 END)',
        'expense',
      )
      .setParameter('income', TransactionType.INCOME)
      .setParameter('expense', TransactionType.EXPENSE)
      .getRawOne<{ count: string | number; income: string | null; expense: string | null }>();

    return {
      count: Number(row?.count ?? 0),
      income: parseMoney(row?.income ?? '0'),
      expense: parseMoney(row?.expense ?? '0'),
    };
  }

  // Income minus expense of the selection within each interval, initial
  // balances left out. Intervals must not overlap; the i-th net is for the
  // i-th interval, 0 when it has no records.
  async getFeedIntervalNets(
    selection: TransactionSelection,
    intervals: TimeInterval[],
    manager?: EntityManager,
  ): Promise<bigint[]> {
    const nets = intervals.map(() => 0n);
    const walletIds = intervals.length === 0 ? [] : await this.selectionWallets(selection, manager);

    if (walletIds.length === 0) {
      return nets;
    }

    const within = (i: number) => `transaction.timestamp BETWEEN :intervalFrom${i} AND :intervalTo${i}`;
    const rows = await this.selectionScope(selection, walletIds, manager)
      .select(`CASE ${intervals.map((_, i) => `WHEN ${within(i)} THEN ${i}`).join(' ')} END`, 'interval_index')
      .addSelect(
        'SUM(CASE WHEN category.is_system = 1 THEN 0 ' +
          'WHEN transaction.transaction_type = :income THEN transaction.amount ELSE -transaction.amount END)',
        'net',
      )
      .andWhere(`(${intervals.map((_, i) => within(i)).join(' OR ')})`)
      .setParameters(
        Object.fromEntries(
          intervals.flatMap((interval, i) => [
            [`intervalFrom${i}`, clampToStored(interval.from)],
            [`intervalTo${i}`, clampToStored(interval.to)],
          ]),
        ),
      )
      .setParameter('income', TransactionType.INCOME)
      .groupBy('interval_index')
      .getRawMany<{ interval_index: string | number; net: string }>();

    for (const row of rows) {
      nets[Number(row.interval_index)] = parseMoney(row.net);
    }

    return nets;
  }

  // The position of a transaction of the space, or null when the selection
  // does not contain it (another period, search or filter, or no such record).
  async findFeedPosition(
    selection: TransactionSelection,
    transactionId: string,
    manager?: EntityManager,
  ): Promise<FeedPosition | null> {
    const walletIds = await this.selectionWallets(selection, manager);

    if (walletIds.length === 0) {
      return null;
    }

    const transaction = await this.selectionScope(selection, walletIds, manager)
      .select(['transaction.id', 'transaction.timestamp'])
      .andWhere('transaction.id = :transactionId', { transactionId })
      .getOne();

    return transaction && { timestamp: transaction.timestamp, id: transaction.id };
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

  async getStatisticsByCategory(
    spaceId: number,
    transactionType: TransactionType,
    from: Date,
    to: Date,
    manager: EntityManager,
  ): Promise<StatisticsCategoryGroup[]> {
    const rows = await this.statisticsTypeScope(manager, spaceId, transactionType, from, to)
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

  async getStatisticsByWallet(
    spaceId: number,
    transactionType: TransactionType,
    from: Date,
    to: Date,
    manager: EntityManager,
  ): Promise<StatisticsWalletGroup[]> {
    const rows = await this.statisticsTypeScope(manager, spaceId, transactionType, from, to)
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

  // The wallets whose transactions the selection reads: every wallet of the
  // space, soft-deleted included, or the one of the wallet filter.
  private async selectionWallets(selection: TransactionSelection, manager?: EntityManager): Promise<number[]> {
    const rows: { id: number }[] = await (manager ?? this.transactionRepository.manager)
      .createQueryBuilder(Wallet, 'wallet')
      .select('wallet.id', 'id')
      .where('wallet.space_id = :spaceId', { spaceId: selection.spaceId })
      .orderBy('wallet.id')
      .getRawMany();
    const walletId = selection.filters?.walletId;
    const ids = rows.map((row) => Number(row.id));

    return walletId === undefined ? ids : ids.filter((id) => id === walletId);
  }

  private async loadInOrder(ids: string[], manager?: EntityManager): Promise<LoadedTransaction[]> {
    if (ids.length === 0) {
      return [];
    }

    const rows = await this.repository(manager)
      .createQueryBuilder('transaction')
      .innerJoinAndSelect('transaction.wallet', 'wallet')
      .innerJoinAndSelect('transaction.category', 'category')
      .where('transaction.id IN (:...ids)', { ids })
      .getMany();
    const byId = new Map(rows.map((row) => [row.id, withRelations(row, 'wallet', 'category')]));

    return ids.map((id) => byId.get(id)!);
  }

  // The one selection of the feed, its count and every total of it. Soft-
  // deleted wallets are joined like active ones, so their history is listed
  // and their stored name is searched; archived categories likewise. The
  // space is applied as a list of wallet ids, not through the wallet join:
  // only constants give MySQL index ranges on (wallet_id, timestamp), while
  // the join let it scan the whole table, every space's rows included.
  private selectionScope(
    { from, to, filters = {} }: TransactionSelection,
    walletIds: number[],
    manager?: EntityManager,
  ): SelectQueryBuilder<Transaction> {
    const query = this.repository(manager)
      .createQueryBuilder('transaction')
      .innerJoin('transaction.wallet', 'wallet')
      .innerJoin('transaction.category', 'category');

    query.where('transaction.wallet_id IN (:...walletIds)', { walletIds });

    // MySQL is only given the part of the period a TIMESTAMP can hold; a
    // period wholly outside it selects nothing.
    if (to < TIMESTAMP_MIN || from > STORED_TIMESTAMP_MAX) {
      query.andWhere('FALSE');
    } else {
      query
        .andWhere('transaction.timestamp >= :from', { from: clampToStored(from) })
        .andWhere('transaction.timestamp <= :to', { to: clampToStored(to) });
    }

    if (filters.transactionType) {
      query.andWhere('transaction.transaction_type = :transactionType', { transactionType: filters.transactionType });
    }

    if (filters.kind) {
      query.andWhere(`category.is_system = ${filters.kind === TransactionKind.INITIAL_BALANCE ? 1 : 0}`);
    }

    if (filters.categoryId) {
      query.andWhere('transaction.category_id = :categoryId', { categoryId: filters.categoryId });
    }

    const search = filters.search?.trim();

    if (search) {
      const matches = (column: string) => searchMatch(column, ':searchPattern');

      query.andWhere(
        `(${matches('transaction.description')} OR ${matches('category.name')} OR ${matches('wallet.wallet_name')})`,
        { searchPattern: toSearchPattern(search) },
      );
    }

    return query;
  }

  private repository(manager?: EntityManager): Repository<Transaction> {
    return manager?.getRepository(Transaction) ?? this.transactionRepository;
  }

  private statisticsTypeScope(
    manager: EntityManager,
    spaceId: number,
    transactionType: TransactionType,
    from: Date,
    to: Date,
  ): SelectQueryBuilder<Transaction> {
    return this.statisticsScope(manager, spaceId, from, to).andWhere(
      'transaction.transaction_type = :transactionType',
      { transactionType },
    );
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
