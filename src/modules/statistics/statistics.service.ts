import { Injectable } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';

import type { StatisticsQueryDto } from './dto/statistics-query.dto';
import {
  type CategoryBreakdown,
  type WalletBreakdown,
  buildCategoryBreakdown,
  buildWalletBreakdown,
  sumOf,
} from './statistics-breakdown';
import { calendarDateAt, formatCalendarDate } from './statistics-calendar';
import {
  type PreviousPeriod,
  type StatisticsPeriod,
  type TrendGranularity,
  type TrendInterval,
  resolvePreviousPeriod,
  resolveStatisticsPeriod,
  resolveTrendIntervals,
  trendGranularity,
} from './statistics-period';
import { assertFound, formatMoney, roundPercentToTenth } from '@shared/utils';
import { SpaceAccessService } from '@modules/space-access/space-access.service';
import { SpacesService } from '@modules/spaces/spaces.service';
import {
  type StatisticsTotals,
  TransactionQueriesService,
} from '@modules/transaction-queries/transaction-queries.service';

export interface MoneyCount {
  amount: string;
  count: number;
}

export interface Change {
  delta: string;
  // null when the previous value is zero
  percent: number | null;
}

interface StatisticsBlock {
  period: StatisticsPeriod;
  currency: string;
}

interface Figures {
  income: MoneyCount;
  expense: MoneyCount;
  net: string;
  transactions_count: number;
}

export interface StatisticsSummary extends StatisticsBlock, Figures {
  previous: (PreviousPeriod & Figures) | null;
  change: { income: Change; expense: Change; net: Change } | null;
  // any statistics transaction up to as_of, in any period
  has_any_transactions: boolean;
  // local date in period.time_zone
  last_transaction_date: string | null;
}

export interface TrendBucket extends TrendInterval {
  // null for a future interval
  income: string | null;
  expense: string | null;
}

export interface StatisticsTrend extends StatisticsBlock {
  // control sums: the client compares them with the summary of the same cycle
  totals: { income: MoneyCount; expense: MoneyCount };
  granularity: TrendGranularity;
  buckets: TrendBucket[];
}

export interface StatisticsBreakdown extends StatisticsBlock {
  // control sum: the client compares it with the summary expense of the same cycle
  total: MoneyCount;
  by_category: CategoryBreakdown;
  by_wallet: WalletBreakdown;
}

const EMPTY_TOTALS: StatisticsTotals = { income: 0n, incomeCount: 0, expense: 0n, expenseCount: 0 };

const figuresOf = (totals: StatisticsTotals): Figures => ({
  income: { amount: formatMoney(totals.income), count: totals.incomeCount },
  expense: { amount: formatMoney(totals.expense), count: totals.expenseCount },
  net: formatMoney(totals.income - totals.expense),
  transactions_count: totals.incomeCount + totals.expenseCount,
});

const changeOf = (current: bigint, previous: bigint): Change => {
  const delta = current - previous;
  const base = previous < 0n ? -previous : previous;

  return { delta: formatMoney(delta), percent: base === 0n ? null : roundPercentToTenth(delta, base) };
};

const addTotals = (a: StatisticsTotals, b: StatisticsTotals): StatisticsTotals => ({
  income: a.income + b.income,
  incomeCount: a.incomeCount + b.incomeCount,
  expense: a.expense + b.expense,
  expenseCount: a.expenseCount + b.expenseCount,
});

@Injectable()
export class StatisticsService {
  constructor(
    private readonly spaceAccessService: SpaceAccessService,
    private readonly spacesService: SpacesService,
    private readonly transactionQueriesService: TransactionQueriesService,
    private readonly dataSource: DataSource,
  ) {}

  async getSummary(userId: number, spaceId: number, query: StatisticsQueryDto): Promise<StatisticsSummary> {
    const block = await this.openBlock(userId, spaceId, query);
    const { period } = block;
    const previousPeriod = resolvePreviousPeriod(period);
    const [totals, previousTotals, lastTimestamp] = await this.readSnapshot(async (manager) => [
      period.actual_to === null
        ? EMPTY_TOTALS
        : await this.transactionQueriesService.getStatisticsTotals(spaceId, period.from, period.actual_to, manager),
      previousPeriod &&
        (await this.transactionQueriesService.getStatisticsTotals(
          spaceId,
          previousPeriod.from,
          previousPeriod.actual_to,
          manager,
        )),
      await this.transactionQueriesService.getLastStatisticsTimestamp(spaceId, period.as_of, manager),
    ]);

    return {
      ...block,
      ...figuresOf(totals),
      previous: previousPeriod && { ...previousPeriod, ...figuresOf(previousTotals!) },
      change: previousTotals && {
        income: changeOf(totals.income, previousTotals.income),
        expense: changeOf(totals.expense, previousTotals.expense),
        net: changeOf(totals.income - totals.expense, previousTotals.income - previousTotals.expense),
      },
      has_any_transactions: lastTimestamp !== null,
      last_transaction_date: lastTimestamp && formatCalendarDate(calendarDateAt(lastTimestamp, period.time_zone)),
    };
  }

  async getTrend(userId: number, spaceId: number, query: StatisticsQueryDto): Promise<StatisticsTrend> {
    const block = await this.openBlock(userId, spaceId, query);
    const { period } = block;
    const granularity = trendGranularity(period);
    const intervals = resolveTrendIntervals(period, granularity);
    const started = intervals.filter((interval) => interval.state !== 'future');
    const sums =
      period.actual_to === null
        ? []
        : await this.transactionQueriesService.getStatisticsIntervalTotals(
            spaceId,
            period.from,
            period.actual_to,
            started.map((interval) => interval.to),
          );
    const totals = sums.reduce(addTotals, EMPTY_TOTALS);
    const figures = figuresOf(totals);

    return {
      ...block,
      totals: { income: figures.income, expense: figures.expense },
      granularity,
      buckets: intervals.map((interval, i) => ({
        ...interval,
        income: i < sums.length ? formatMoney(sums[i].income) : null,
        expense: i < sums.length ? formatMoney(sums[i].expense) : null,
      })),
    };
  }

  async getBreakdown(userId: number, spaceId: number, query: StatisticsQueryDto): Promise<StatisticsBreakdown> {
    const block = await this.openBlock(userId, spaceId, query);
    const { period } = block;
    const { actual_to: to } = period;
    const [categories, wallets] =
      to === null
        ? [[], []]
        : await this.readSnapshot(async (manager) => [
            await this.transactionQueriesService.getStatisticsExpenseByCategory(spaceId, period.from, to, manager),
            await this.transactionQueriesService.getStatisticsExpenseByWallet(spaceId, period.from, to, manager),
          ]);

    return {
      ...block,
      total: {
        amount: formatMoney(sumOf(categories)),
        count: categories.reduce((sum, category) => sum + category.count, 0),
      },
      by_category: buildCategoryBreakdown(categories),
      by_wallet: buildWalletBreakdown(wallets),
    };
  }

  private async openBlock(userId: number, spaceId: number, query: StatisticsQueryDto): Promise<StatisticsBlock> {
    await this.spaceAccessService.assertMembership(spaceId, userId);

    const period = resolveStatisticsPeriod(query, new Date());
    const space = await this.spacesService.getOne(spaceId);
    assertFound(space);

    return { period, currency: space.currency.code };
  }

  // InnoDB takes the snapshot at the first read, so the later reads of a
  // block see no commits made in between. Plain reads, no locks.
  private readSnapshot<T>(read: (manager: EntityManager) => Promise<T>): Promise<T> {
    return this.dataSource.transaction('REPEATABLE READ', read);
  }
}
