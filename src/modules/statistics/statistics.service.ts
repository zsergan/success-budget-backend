import { Injectable } from '@nestjs/common';

import type { StatisticsQueryDto } from './dto/statistics-query.dto';
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
  total: MoneyCount;
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
  ) {}

  async getSummary(userId: number, spaceId: number, query: StatisticsQueryDto): Promise<StatisticsSummary> {
    const block = await this.openBlock(userId, spaceId, query);
    const previousPeriod = resolvePreviousPeriod(block.period);
    const [totals, previousTotals] = await Promise.all([
      this.getTotals(spaceId, block.period),
      previousPeriod &&
        this.transactionQueriesService.getStatisticsTotals(spaceId, previousPeriod.from, previousPeriod.actual_to),
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
    const totals = await this.getTotals(spaceId, block.period);

    return { ...block, total: figuresOf(totals).expense };
  }

  private async openBlock(userId: number, spaceId: number, query: StatisticsQueryDto): Promise<StatisticsBlock> {
    await this.spaceAccessService.assertMembership(spaceId, userId);

    const period = resolveStatisticsPeriod(query, new Date());
    const space = await this.spacesService.getOne(spaceId);
    assertFound(space);

    return { period, currency: space.currency.code };
  }

  private async getTotals(spaceId: number, period: StatisticsPeriod): Promise<StatisticsTotals> {
    if (period.actual_to === null) {
      return EMPTY_TOTALS;
    }

    return this.transactionQueriesService.getStatisticsTotals(spaceId, period.from, period.actual_to);
  }
}
