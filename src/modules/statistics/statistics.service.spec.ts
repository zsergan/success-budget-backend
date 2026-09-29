import { HttpException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';

import { StatisticsService } from './statistics.service';
import type { StatisticsQueryDto } from './dto/statistics-query.dto';
import { SpaceAccessService } from '@modules/space-access/space-access.service';
import { SpacesService } from '@modules/spaces/spaces.service';
import { TransactionQueriesService } from '@modules/transaction-queries/transaction-queries.service';
import { StatisticsPeriodType } from '@shared/enums';
import { ErrorMessages } from '@shared/error-messages';
import { withRelations } from '@shared/utils';
import { buildCurrency, buildSpace, buildSpaceMember } from '@testing';

describe('StatisticsService', () => {
  let service: StatisticsService;
  let spaceAccessService: jest.Mocked<SpaceAccessService>;
  let spacesService: jest.Mocked<SpacesService>;
  let transactionQueriesService: jest.Mocked<TransactionQueriesService>;

  const userId = 1;
  const spaceId = 9;
  const now = new Date('2026-09-28T12:00:00.000Z');
  const query: StatisticsQueryDto = { period: StatisticsPeriodType.MONTH, time_zone: 'Europe/Moscow' };
  const SEPTEMBER = { income: 300000n, incomeCount: 1, expense: 81050n, expenseCount: 9 };
  const AUGUST_TO_28TH = { income: 300000n, incomeCount: 1, expense: 30000n, expenseCount: 2 };
  const EMPTY = { income: 0n, incomeCount: 0, expense: 0n, expenseCount: 0 };

  beforeEach(async () => {
    jest.useFakeTimers({ now });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        StatisticsService,
        {
          provide: SpaceAccessService,
          useValue: { assertMembership: jest.fn().mockResolvedValue(buildSpaceMember()) },
        },
        {
          provide: SpacesService,
          useValue: {
            getOne: jest
              .fn()
              .mockResolvedValue(
                withRelations(buildSpace({ id: spaceId, currency: buildCurrency({ code: 'EUR' }) }), 'currency'),
              ),
          },
        },
        {
          provide: TransactionQueriesService,
          useValue: {
            getStatisticsTotals: jest
              .fn()
              .mockResolvedValueOnce(SEPTEMBER)
              .mockResolvedValueOnce(AUGUST_TO_28TH)
              .mockResolvedValue(SEPTEMBER),
            getStatisticsIntervalTotals: jest.fn(),
            getLastStatisticsTimestamp: jest.fn().mockResolvedValue(new Date('2026-09-27T21:30:00.000Z')),
            getStatisticsExpenseByCategory: jest.fn().mockResolvedValue([
              {
                id: 10,
                name: 'Groceries',
                icon: 'cart',
                color: 'emerald',
                isArchived: false,
                amount: 80000n,
                count: 8,
              },
              { id: 16, name: 'Fees', icon: 'receipt', color: 'slate', isArchived: false, amount: 1050n, count: 1 },
            ]),
            getStatisticsExpenseByWallet: jest.fn().mockResolvedValue([
              { id: 1, name: 'Card', design: 'slate', isDeleted: false, amount: 71050n, count: 7 },
              { id: 3, name: 'Old card', design: 'rose', isDeleted: true, amount: 10000n, count: 2 },
            ]),
          },
        },
      ],
    }).compile();

    service = module.get(StatisticsService);
    spaceAccessService = module.get(SpaceAccessService);
    spacesService = module.get(SpacesService);
    transactionQueriesService = module.get(TransactionQueriesService);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  const period = {
    type: 'month',
    time_zone: 'Europe/Moscow',
    start_date: '2026-09-01',
    end_date: '2026-09-30',
    from: new Date('2026-08-31T21:00:00.000Z'),
    to: new Date('2026-09-30T20:59:59.999Z'),
    as_of: now,
    actual_to: now,
    state: 'current',
  };

  it('summary: totals of the actual range compared with the same part of the previous month', async () => {
    const result = await service.getSummary(userId, spaceId, query);
    const previousFrom = new Date('2026-07-31T21:00:00.000Z');
    const previousCut = new Date('2026-08-28T12:00:00.000Z');

    expect(result).toEqual({
      period,
      currency: 'EUR',
      income: { amount: '3000.00', count: 1 },
      expense: { amount: '810.50', count: 9 },
      net: '2189.50',
      transactions_count: 10,
      previous: {
        start_date: '2026-08-01',
        end_date: '2026-08-31',
        from: previousFrom,
        to: new Date('2026-08-31T20:59:59.999Z'),
        actual_to: previousCut,
        income: { amount: '3000.00', count: 1 },
        expense: { amount: '300.00', count: 2 },
        net: '2700.00',
        transactions_count: 3,
      },
      change: {
        income: { delta: '0.00', percent: 0 },
        expense: { delta: '510.50', percent: 170.2 },
        net: { delta: '-510.50', percent: -18.9 },
      },
      has_any_transactions: true,
      // 00:30 on Sep 28 in Moscow
      last_transaction_date: '2026-09-28',
    });
    expect(transactionQueriesService.getLastStatisticsTimestamp).toHaveBeenCalledWith(spaceId, now);
    expect(spaceAccessService.assertMembership).toHaveBeenCalledWith(spaceId, userId);
    expect(transactionQueriesService.getStatisticsTotals).toHaveBeenNthCalledWith(1, spaceId, period.from, now);
    expect(transactionQueriesService.getStatisticsTotals).toHaveBeenNthCalledWith(
      2,
      spaceId,
      previousFrom,
      previousCut,
    );
  });

  it('summary: no percent against a zero previous value, a positive one for a rising negative net', async () => {
    transactionQueriesService.getStatisticsTotals.mockReset();
    transactionQueriesService.getStatisticsTotals
      .mockResolvedValueOnce({ income: 0n, incomeCount: 0, expense: 5000n, expenseCount: 1 })
      .mockResolvedValueOnce({ income: 0n, incomeCount: 0, expense: 10000n, expenseCount: 1 });

    const result = await service.getSummary(userId, spaceId, query);

    expect(result.change).toEqual({
      income: { delta: '0.00', percent: null },
      expense: { delta: '-50.00', percent: -50 },
      net: { delta: '50.00', percent: 50 },
    });
  });

  it('summary: no comparison for a custom period', async () => {
    const result = await service.getSummary(userId, spaceId, {
      ...query,
      period: StatisticsPeriodType.CUSTOM,
      from_date: '2026-09-01',
      to_date: '2026-09-10',
    });

    expect(result).toMatchObject({ previous: null, change: null });
    expect(transactionQueriesService.getStatisticsTotals).toHaveBeenCalledTimes(1);
  });

  it('trend: sums per started interval, null for the future ones, control sums of the buckets', async () => {
    transactionQueriesService.getStatisticsIntervalTotals.mockResolvedValue([
      { income: 300000n, incomeCount: 1, expense: 57025n, expenseCount: 2 },
      EMPTY,
      { income: 0n, incomeCount: 0, expense: 1000n, expenseCount: 1 },
    ]);

    const result = await service.getTrend(userId, spaceId, {
      ...query,
      period: StatisticsPeriodType.CUSTOM,
      from_date: '2026-09-26',
      to_date: '2026-09-30',
    });

    expect(result.granularity).toBe('day');
    expect(result.totals).toEqual({
      income: { amount: '3000.00', count: 1 },
      expense: { amount: '580.25', count: 3 },
    });
    expect(result.buckets.map(({ key, state, income, expense }) => ({ key, state, income, expense }))).toEqual([
      { key: '2026-09-26', state: 'past', income: '3000.00', expense: '570.25' },
      { key: '2026-09-27', state: 'past', income: '0.00', expense: '0.00' },
      { key: '2026-09-28', state: 'current', income: '0.00', expense: '10.00' },
      { key: '2026-09-29', state: 'future', income: null, expense: null },
      { key: '2026-09-30', state: 'future', income: null, expense: null },
    ]);
    expect(transactionQueriesService.getStatisticsIntervalTotals).toHaveBeenCalledWith(
      spaceId,
      new Date('2026-09-25T21:00:00.000Z'),
      now,
      result.buckets.slice(0, 3).map((bucket) => bucket.to),
    );
  });

  it('breakdown: the expense total of the same selection', async () => {
    const result = await service.getBreakdown(userId, spaceId, query);

    expect(result).toMatchObject({ period, currency: 'EUR', total: { amount: '810.50', count: 9 } });
    expect(result.by_category).toMatchObject({
      total_amount: '810.50',
      source_count: 2,
      primary_items: [{ kind: 'category', key: 'category:10', amount: '800.00', percent: 98.7 }],
      // 1.3% is under the threshold
      other: { kind: 'other', amount: '10.50', percent: 1.3, children: [{ key: 'category:16' }] },
    });
    expect(result.by_wallet).toMatchObject({
      total_amount: '810.50',
      source_count: 2,
      primary_items: [{ kind: 'wallet', key: 'wallet:1', amount: '710.50' }],
      deleted_wallets: { kind: 'deleted_wallets', amount: '100.00', wallets_count: 1 },
      other: null,
    });
    expect(transactionQueriesService.getStatisticsExpenseByCategory).toHaveBeenCalledWith(spaceId, period.from, now);
    expect(transactionQueriesService.getStatisticsExpenseByWallet).toHaveBeenCalledWith(spaceId, period.from, now);
  });

  it('summary: no transactions at all', async () => {
    transactionQueriesService.getLastStatisticsTimestamp.mockResolvedValue(null);

    const result = await service.getSummary(userId, spaceId, query);

    expect(result).toMatchObject({ has_any_transactions: false, last_transaction_date: null });
  });

  it('keeps the sign of a negative net', async () => {
    transactionQueriesService.getStatisticsTotals.mockReset();
    transactionQueriesService.getStatisticsTotals.mockResolvedValue({
      income: 0n,
      incomeCount: 0,
      expense: 1000n,
      expenseCount: 1,
    });

    const result = await service.getSummary(userId, spaceId, query);

    expect(result.net).toBe('-10.00');
  });

  it('neither queries nor compares a period that has not started', async () => {
    const future = { ...query, anchor_date: '2026-10-01' };
    const summary = await service.getSummary(userId, spaceId, future);
    const trend = await service.getTrend(userId, spaceId, future);
    const breakdown = await service.getBreakdown(userId, spaceId, future);

    expect(summary.period.state).toBe('future');
    expect(summary).toMatchObject({
      income: { amount: '0.00', count: 0 },
      expense: { amount: '0.00', count: 0 },
      net: '0.00',
      transactions_count: 0,
      previous: null,
      change: null,
      // history before as_of still counts: the period is just not there yet
      has_any_transactions: true,
    });
    expect(breakdown).toMatchObject({
      total: { amount: '0.00', count: 0 },
      by_category: { total_amount: '0.00', source_count: 0, primary_items: [], other: null },
      by_wallet: { source_count: 0, primary_items: [], deleted_wallets: null, other: null },
    });
    expect(transactionQueriesService.getStatisticsExpenseByCategory).not.toHaveBeenCalled();
    expect(trend.totals).toEqual({ income: { amount: '0.00', count: 0 }, expense: { amount: '0.00', count: 0 } });
    expect(trend.buckets).toHaveLength(5);
    expect(trend.buckets.every((bucket) => bucket.state === 'future' && bucket.income === null)).toBe(true);
    expect(transactionQueriesService.getStatisticsTotals).not.toHaveBeenCalled();
    expect(transactionQueriesService.getStatisticsIntervalTotals).not.toHaveBeenCalled();
  });

  it('checks membership before anything else', async () => {
    spaceAccessService.assertMembership.mockRejectedValue(new HttpException(ErrorMessages.FORBIDDEN_SPACE, 403));

    await expect(service.getTrend(userId, spaceId, query)).rejects.toThrow(ErrorMessages.FORBIDDEN_SPACE);
    expect(spacesService.getOne).not.toHaveBeenCalled();
    expect(transactionQueriesService.getStatisticsTotals).not.toHaveBeenCalled();
  });
});
