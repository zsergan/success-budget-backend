import { Injectable } from '@nestjs/common';

import type { StatisticsQueryDto } from './dto/statistics-query.dto';
import { type StatisticsPeriod, resolveStatisticsPeriod } from './statistics-period';
import { assertFound, formatMoney } from '@shared/utils';
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

interface StatisticsBlock {
  period: StatisticsPeriod;
  currency: string;
}

export interface StatisticsSummary extends StatisticsBlock {
  income: MoneyCount;
  expense: MoneyCount;
  net: string;
  transactions_count: number;
}

export interface StatisticsTrend extends StatisticsBlock {
  // control sums: the client compares them with the summary of the same cycle
  totals: { income: MoneyCount; expense: MoneyCount };
}

export interface StatisticsBreakdown extends StatisticsBlock {
  total: MoneyCount;
}

const EMPTY_TOTALS: StatisticsTotals = { income: 0n, incomeCount: 0, expense: 0n, expenseCount: 0 };

@Injectable()
export class StatisticsService {
  constructor(
    private readonly spaceAccessService: SpaceAccessService,
    private readonly spacesService: SpacesService,
    private readonly transactionQueriesService: TransactionQueriesService,
  ) {}

  async getSummary(userId: number, spaceId: number, query: StatisticsQueryDto): Promise<StatisticsSummary> {
    const block = await this.openBlock(userId, spaceId, query);
    const totals = await this.getTotals(spaceId, block.period);

    return {
      ...block,
      income: { amount: formatMoney(totals.income), count: totals.incomeCount },
      expense: { amount: formatMoney(totals.expense), count: totals.expenseCount },
      net: formatMoney(totals.income - totals.expense),
      transactions_count: totals.incomeCount + totals.expenseCount,
    };
  }

  async getTrend(userId: number, spaceId: number, query: StatisticsQueryDto): Promise<StatisticsTrend> {
    const block = await this.openBlock(userId, spaceId, query);
    const totals = await this.getTotals(spaceId, block.period);

    return {
      ...block,
      totals: {
        income: { amount: formatMoney(totals.income), count: totals.incomeCount },
        expense: { amount: formatMoney(totals.expense), count: totals.expenseCount },
      },
    };
  }

  async getBreakdown(userId: number, spaceId: number, query: StatisticsQueryDto): Promise<StatisticsBreakdown> {
    const block = await this.openBlock(userId, spaceId, query);
    const totals = await this.getTotals(spaceId, block.period);

    return { ...block, total: { amount: formatMoney(totals.expense), count: totals.expenseCount } };
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
