import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository, SelectQueryBuilder } from 'typeorm';

import { Transaction } from '@entities/transaction.entity';
import { SpaceMember } from '@entities/space-member.entity';
import { AssignmentKind, TransactionKind, TransactionType } from '@shared/enums';
import type { CategoryColor } from '@shared/category-color';
import type { WithRelations } from '@shared/types';
import { parseMoney, withRelations } from '@shared/utils';
import { type AssignmentFilter, DELETED_MEMBER_KEY } from './assignment-filter';

// author and assignedUser carry only id and name; null when not loaded
// (no such reference, or the account was deleted)
export type LoadedTransaction = WithRelations<Transaction, 'category'>;

export interface TransactionFilters {
  transactionType?: TransactionType;
  kind?: TransactionKind;
  categoryId?: number;
  assignment?: AssignmentFilter;
  // trimmed here too; blank means no text condition; matches descriptions and category names
  search?: string;
}

// What the history and the feed select: one space, both calendar dates inclusive.
export interface TransactionSelection {
  spaceId: number;
  fromDate: string;
  toDate: string;
  filters?: TransactionFilters;
}

// A place in the history order (date, then ordering key, both descending).
export interface FeedPosition {
  date: string;
  // the BIGINT ordering key as a decimal string
  orderKey: string;
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

// Searched text is compared in one fixed collation, whatever the columns or
// the server default use: case- and accent-insensitive, Cyrillic included.
export const SEARCH_COLLATION = 'utf8mb4_0900_ai_ci';
const SEARCH_ESCAPE = '!';

export const toSearchPattern = (search: string): string => `%${search.replace(/[!%_]/g, (char) => `!${char}`)}%`;

const searchable = (expression: string) => `CONVERT(${expression} USING utf8mb4) COLLATE ${SEARCH_COLLATION}`;

// `pattern` is a bound parameter holding toSearchPattern() of the text.
export const searchMatch = (column: string, pattern: string): string =>
  `${searchable(column)} LIKE ${searchable(pattern)} ESCAPE '${SEARCH_ESCAPE}'`;

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
  color: CategoryColor;
  isArchived: boolean;
  // in cents
  amount: bigint;
  count: number;
}

// One assignment group: a user (member or former member), the whole space,
// nobody, or every user whose account was deleted.
export interface StatisticsAssignmentGroup {
  kind: AssignmentKind | typeof DELETED_MEMBER_KEY;
  userId: number | null;
  name: string | null;
  isMember: boolean;
  // in cents
  amount: bigint;
  count: number;
}

export interface SpacePerson {
  userId: number;
  name: string;
}

// in cents
export interface StatisticsTotals {
  income: bigint;
  incomeCount: number;
  expense: bigint;
  expenseCount: number;
}

// A string parameter compared with a BIGINT column is read as a double;
// the cast keeps every digit of an ordering key.
const ORDER_KEY_PARAMETER = (name: string) => `CAST(:${name} AS UNSIGNED)`;

@Injectable()
export class TransactionQueriesService {
  constructor(
    @InjectRepository(Transaction)
    private readonly transactionRepository: Repository<Transaction>,
  ) {}

  // Scoped by the transaction's own space, so a transaction of another space
  // is not found rather than forbidden.
  async getOneInSpace(
    spaceId: number,
    transactionId: string,
    manager?: EntityManager,
  ): Promise<LoadedTransaction | null> {
    const transaction = await this.loadQuery(manager)
      .where('transaction.id = :transactionId', { transactionId })
      .andWhere('transaction.space_id = :spaceId', { spaceId })
      .getOne();

    return transaction && withRelations(transaction, 'category');
  }

  // the users who are members of the space now: the rest of the users a
  // record names are former members
  async getMemberUserIds(spaceId: number, manager?: EntityManager): Promise<Set<number>> {
    const rows: { user_id: number }[] = await (manager ?? this.transactionRepository.manager)
      .createQueryBuilder(SpaceMember, 'member')
      .select('member.user_id', 'user_id')
      .where('member.space_id = :spaceId', { spaceId })
      .getRawMany();

    return new Set(rows.map((row) => Number(row.user_id)));
  }

  // one aggregated query for GET /spaces/:spaceId/limits - every category's
  // expense spend for the period, grouped in SQL: every expense of the space,
  // whoever it is assigned to. Sums are in cents.
  async getExpensesByCategory(
    spaceId: number,
    fromDate: string,
    toDate: string,
    manager?: EntityManager,
  ): Promise<Map<number, bigint>> {
    const rows = await this.repository(manager)
      .createQueryBuilder('transaction')
      .select('transaction.category_id', 'category_id')
      .addSelect('SUM(transaction.amount)', 'spent')
      .where('transaction.space_id = :spaceId', { spaceId })
      .andWhere('transaction.transaction_type = :expense', { expense: TransactionType.EXPENSE })
      .andWhere('transaction.date >= :fromDate', { fromDate })
      .andWhere('transaction.date <= :toDate', { toDate })
      .groupBy('transaction.category_id')
      .getRawMany<{ category_id: number; spent: string }>();

    return new Map(rows.map((row) => [Number(row.category_id), parseMoney(row.spent)]));
  }

  // the number of records the feed pages through for the same selection
  async countSelection(selection: TransactionSelection, manager?: EntityManager): Promise<number> {
    return this.selectionScope(selection, manager).getCount();
  }

  // Up to `limit` records of the selection next to a position, in the
  // history order. One more is read to tell whether the direction goes on.
  // With the space as a constant, MySQL walks (space_id, date, order_key) in
  // index order and stops at the limit, so the cost does not grow with the
  // history; an assignment filter walks its own index the same way.
  async getFeedPage(
    selection: TransactionSelection,
    page: FeedPageRequest,
    manager?: EntityManager,
  ): Promise<FeedPage> {
    const newer = page.before !== undefined;
    const position = page.before ?? page.after;
    const direction = newer ? 'ASC' : 'DESC';
    const query = this.selectionScope(selection, manager).select('transaction.id', 'id');

    if (position) {
      const operator = newer ? '>' : '<';
      query.andWhere(
        `transaction.date ${operator}= :positionDate AND ` +
          `(transaction.date ${operator} :positionDate OR ` +
          `transaction.order_key ${operator} ${ORDER_KEY_PARAMETER('positionKey')})`,
        { positionDate: position.date, positionKey: position.orderKey },
      );
    }

    const rows = await query
      .orderBy('transaction.date', direction)
      .addOrderBy('transaction.order_key', direction)
      .limit(page.limit + 1)
      .getRawMany<{ id: string }>();
    const ids = rows.slice(0, page.limit).map((row) => row.id);
    const items = await this.loadInOrder(ids, manager);

    return { items: newer ? items.reverse() : items, hasMore: rows.length > page.limit };
  }

  async getFeedSummary(selection: TransactionSelection, manager?: EntityManager): Promise<FeedSummary> {
    const row = await this.selectionScope(selection, manager)
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

  // Income minus expense of the selection on each date, initial balances
  // left out, grouped by the stored date; the i-th net is for the i-th
  // date, 0 when it has no records.
  async getFeedDateNets(selection: TransactionSelection, dates: string[], manager?: EntityManager): Promise<bigint[]> {
    if (dates.length === 0) {
      return [];
    }

    const rows = await this.selectionScope(selection, manager)
      .select('transaction.date', 'date')
      .addSelect(
        'SUM(CASE WHEN category.is_system = 1 THEN 0 ' +
          'WHEN transaction.transaction_type = :income THEN transaction.amount ELSE -transaction.amount END)',
        'net',
      )
      .andWhere('transaction.date IN (:...dates)', { dates })
      .setParameter('income', TransactionType.INCOME)
      .groupBy('transaction.date')
      .getRawMany<{ date: string; net: string }>();
    const nets = new Map(rows.map((row) => [row.date, parseMoney(row.net)]));

    return dates.map((date) => nets.get(date) ?? 0n);
  }

  // The position of a transaction of the space, or null when the selection
  // does not contain it (another period, search or filter, or no such record).
  async findFeedPosition(
    selection: TransactionSelection,
    transactionId: string,
    manager?: EntityManager,
  ): Promise<FeedPosition | null> {
    const transaction = await this.selectionScope(selection, manager)
      .select(['transaction.id', 'transaction.date', 'transaction.order_key'])
      .andWhere('transaction.id = :transactionId', { transactionId })
      .getOne();

    return transaction && { date: transaction.date, orderKey: transaction.order_key };
  }

  async getLatest(spaceId: number, manager?: EntityManager): Promise<LoadedTransaction | null> {
    const transaction = await this.loadQuery(manager)
      .where('transaction.space_id = :spaceId', { spaceId })
      .orderBy('transaction.date', 'DESC')
      .addOrderBy('transaction.order_key', 'DESC')
      .limit(1)
      .getOne();

    return transaction && withRelations(transaction, 'category');
  }

  // The statistics reads below take the manager of the block's transaction,
  // so that all reads of one response see the same snapshot.
  async getStatisticsTotals(
    spaceId: number,
    fromDate: string,
    toDate: string,
    manager: EntityManager,
  ): Promise<StatisticsTotals> {
    const row = await this.selectStatisticsTotals(
      this.statisticsScope(manager, spaceId, fromDate, toDate),
    ).getRawOne<TotalsRow>();

    return toStatisticsTotals(row);
  }

  // Totals per interval in one query. Intervals are consecutive and the
  // i-th one ends with the date intervalEnds[i]; the last end only closes
  // the list, since the scope already ends at `toDate`.
  async getStatisticsIntervalTotals(
    spaceId: number,
    fromDate: string,
    toDate: string,
    intervalEnds: string[],
  ): Promise<StatisticsTotals[]> {
    const last = intervalEnds.length - 1;
    const cases = intervalEnds
      .slice(0, last)
      .map((_, i) => `WHEN transaction.date <= :intervalEnd${i} THEN ${i}`)
      .join(' ');

    const rows = await this.selectStatisticsTotals(
      this.statisticsScope(this.transactionRepository.manager, spaceId, fromDate, toDate),
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
    fromDate: string,
    toDate: string,
    manager: EntityManager,
  ): Promise<StatisticsCategoryGroup[]> {
    const rows = await this.statisticsTypeScope(manager, spaceId, transactionType, fromDate, toDate)
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
        color: CategoryColor;
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

  // Per assignment: each user once (members and former members alike), the
  // whole space, nobody, and every deleted account together. A user's name
  // and membership are read in the same snapshot as the sums.
  async getStatisticsByAssignment(
    spaceId: number,
    transactionType: TransactionType,
    fromDate: string,
    toDate: string,
    manager: EntityManager,
  ): Promise<StatisticsAssignmentGroup[]> {
    const rows = await this.statisticsTypeScope(manager, spaceId, transactionType, fromDate, toDate)
      .leftJoin('transaction.assignedUser', 'assignedUser')
      .leftJoin(
        SpaceMember,
        'member',
        'member.space_id = transaction.space_id AND member.user_id = transaction.assigned_user_id',
      )
      .select('transaction.assignment_kind', 'kind')
      .addSelect('transaction.assigned_user_id', 'user_id')
      .addSelect('MAX(assignedUser.name)', 'name')
      .addSelect('MAX(member.id)', 'member_id')
      .addSelect('SUM(transaction.amount)', 'amount')
      .addSelect('COUNT(*)', 'count')
      .groupBy('transaction.assignment_kind')
      .addGroupBy('transaction.assigned_user_id')
      .getRawMany<{
        kind: AssignmentKind;
        user_id: number | string | null;
        name: string | null;
        member_id: number | string | null;
        amount: string;
        count: number | string;
      }>();

    return rows.map((row) => {
      const userId = row.user_id === null ? null : Number(row.user_id);
      const deleted = row.kind === AssignmentKind.MEMBER && userId === null;

      return {
        kind: deleted ? DELETED_MEMBER_KEY : row.kind,
        userId,
        name: row.name,
        isMember: row.member_id !== null,
        amount: parseMoney(row.amount),
        count: Number(row.count),
      };
    });
  }

  // the members of the space now, in joining order
  async getMembers(spaceId: number, manager?: EntityManager): Promise<SpacePerson[]> {
    const rows: { user_id: number; name: string }[] = await (manager ?? this.transactionRepository.manager)
      .createQueryBuilder(SpaceMember, 'member')
      .innerJoin('member.user', 'user')
      .select('member.user_id', 'user_id')
      .addSelect('user.name', 'name')
      .where('member.space_id = :spaceId', { spaceId })
      .orderBy('member.created_at', 'ASC')
      .addOrderBy('member.id', 'ASC')
      .getRawMany();

    return rows.map((row) => ({ userId: Number(row.user_id), name: row.name }));
  }

  // every existing user with a record of the space assigned to them
  async getAssignedUsers(spaceId: number, manager?: EntityManager): Promise<SpacePerson[]> {
    const rows: { user_id: number; name: string }[] = await this.repository(manager)
      .createQueryBuilder('transaction')
      .innerJoin('transaction.assignedUser', 'assignedUser')
      .select('transaction.assigned_user_id', 'user_id')
      .addSelect('MAX(assignedUser.name)', 'name')
      .where('transaction.space_id = :spaceId', { spaceId })
      .andWhere('transaction.assignment_kind = :member', { member: AssignmentKind.MEMBER })
      .groupBy('transaction.assigned_user_id')
      .getRawMany();

    return rows.map((row) => ({ userId: Number(row.user_id), name: row.name }));
  }

  // some record of the space is assigned to an account deleted since
  async hasDeletedAssignees(spaceId: number, manager?: EntityManager): Promise<boolean> {
    return this.repository(manager)
      .createQueryBuilder('transaction')
      .where('transaction.space_id = :spaceId', { spaceId })
      .andWhere('transaction.assignment_kind = :member', { member: AssignmentKind.MEMBER })
      .andWhere('transaction.assigned_user_id IS NULL')
      .getExists();
  }

  // A member filter may name a member or anyone a record of the space is
  // assigned to, so former members stay filterable.
  async isKnownAssignee(spaceId: number, userId: number): Promise<boolean> {
    if ((await this.getMemberUserIds(spaceId)).has(userId)) {
      return true;
    }

    return this.transactionRepository
      .createQueryBuilder('transaction')
      .where('transaction.space_id = :spaceId', { spaceId })
      .andWhere('transaction.assignment_kind = :member', { member: AssignmentKind.MEMBER })
      .andWhere('transaction.assigned_user_id = :userId', { userId })
      .getExists();
  }

  // The latest date of any statistics transaction up to `toDate`, in any period.
  async getLastStatisticsDate(spaceId: number, toDate: string, manager: EntityManager): Promise<string | null> {
    const row = await this.statisticsScope(manager, spaceId, null, toDate)
      .select('transaction.date', 'date')
      .orderBy('transaction.date', 'DESC')
      .limit(1)
      .getRawOne<{ date: string }>();

    return row?.date ?? null;
  }

  private async loadInOrder(ids: string[], manager?: EntityManager): Promise<LoadedTransaction[]> {
    if (ids.length === 0) {
      return [];
    }

    const rows = await this.loadQuery(manager).where('transaction.id IN (:...ids)', { ids }).getMany();
    const byId = new Map(rows.map((row) => [row.id, withRelations(row, 'category')]));

    return ids.map((id) => byId.get(id)!);
  }

  // The one selection of the feed, its count and every total of it: the
  // records of the space by their own space_id, archived categories
  // included. The space is a constant and the dates are compared with the
  // column itself, so MySQL ranges over (space_id, date, ...) instead of
  // scanning other spaces.
  private selectionScope(
    { spaceId, fromDate, toDate, filters = {} }: TransactionSelection,
    manager?: EntityManager,
  ): SelectQueryBuilder<Transaction> {
    const search = filters.search?.trim();
    const query = this.repository(manager)
      .createQueryBuilder('transaction')
      .innerJoin('transaction.category', 'category')
      .where('transaction.space_id = :spaceId', { spaceId })
      .andWhere('transaction.date >= :fromDate', { fromDate })
      .andWhere('transaction.date <= :toDate', { toDate });

    if (filters.transactionType) {
      query.andWhere('transaction.transaction_type = :transactionType', { transactionType: filters.transactionType });
    }

    if (filters.kind) {
      query.andWhere(`category.is_system = ${filters.kind === TransactionKind.INITIAL_BALANCE ? 1 : 0}`);
    }

    if (filters.categoryId) {
      query.andWhere('transaction.category_id = :categoryId', { categoryId: filters.categoryId });
    }

    if (filters.assignment) {
      applyAssignmentFilter(query, filters.assignment);
    }

    if (search) {
      const matches = (column: string) => searchMatch(column, ':searchPattern');
      query.andWhere(`(${matches('transaction.description')} OR ${matches('category.name')})`, {
        searchPattern: toSearchPattern(search),
      });
    }

    return query;
  }

  private repository(manager?: EntityManager): Repository<Transaction> {
    return manager?.getRepository(Transaction) ?? this.transactionRepository;
  }

  // A record with what every view needs: its category, and the id and name
  // of its author and assignee, never other user columns.
  private loadQuery(manager?: EntityManager): SelectQueryBuilder<Transaction> {
    return this.repository(manager)
      .createQueryBuilder('transaction')
      .innerJoinAndSelect('transaction.category', 'category')
      .leftJoin('transaction.author', 'author')
      .addSelect(['author.id', 'author.name'])
      .leftJoin('transaction.assignedUser', 'assignedUser')
      .addSelect(['assignedUser.id', 'assignedUser.name']);
  }

  private statisticsTypeScope(
    manager: EntityManager,
    spaceId: number,
    transactionType: TransactionType,
    fromDate: string,
    toDate: string,
  ): SelectQueryBuilder<Transaction> {
    return this.statisticsScope(manager, spaceId, fromDate, toDate).andWhere(
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
  // every record of the space, whatever its assignment, without
  // starting balances, both dates inclusive.
  private statisticsScope(
    manager: EntityManager,
    spaceId: number,
    fromDate: string | null,
    toDate: string,
  ): SelectQueryBuilder<Transaction> {
    const query = manager
      .createQueryBuilder(Transaction, 'transaction')
      .innerJoin('transaction.category', 'category')
      .where('transaction.space_id = :spaceId', { spaceId })
      .andWhere('category.is_system = 0');

    if (fromDate) {
      query.andWhere('transaction.date >= :fromDate', { fromDate });
    }

    return query.andWhere('transaction.date <= :toDate', { toDate });
  }
}

function applyAssignmentFilter(query: SelectQueryBuilder<Transaction>, filter: AssignmentFilter): void {
  if (filter.kind === AssignmentKind.MEMBER) {
    query
      .andWhere('transaction.assignment_kind = :assignmentKind', { assignmentKind: AssignmentKind.MEMBER })
      .andWhere('transaction.assigned_user_id = :assignedUserId', { assignedUserId: filter.userId });
  } else if (filter.kind === DELETED_MEMBER_KEY) {
    query
      .andWhere('transaction.assignment_kind = :assignmentKind', { assignmentKind: AssignmentKind.MEMBER })
      .andWhere('transaction.assigned_user_id IS NULL');
  } else {
    query.andWhere('transaction.assignment_kind = :assignmentKind', { assignmentKind: filter.kind });
  }
}
