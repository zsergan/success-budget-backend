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
              .mockResolvedValue({ income: 300000n, incomeCount: 1, expense: 81050n, expenseCount: 9 }),
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

  it('summary: totals of the actual range as decimal strings', async () => {
    const result = await service.getSummary(userId, spaceId, query);

    expect(result).toEqual({
      period,
      currency: 'EUR',
      income: { amount: '3000.00', count: 1 },
      expense: { amount: '810.50', count: 9 },
      net: '2189.50',
      transactions_count: 10,
    });
    expect(spaceAccessService.assertMembership).toHaveBeenCalledWith(spaceId, userId);
    expect(transactionQueriesService.getStatisticsTotals).toHaveBeenCalledWith(spaceId, period.from, now);
  });

  it('trend: control sums of the same selection', async () => {
    const result = await service.getTrend(userId, spaceId, query);

    expect(result).toEqual({
      period,
      currency: 'EUR',
      totals: { income: { amount: '3000.00', count: 1 }, expense: { amount: '810.50', count: 9 } },
    });
  });

  it('breakdown: the expense total of the same selection', async () => {
    const result = await service.getBreakdown(userId, spaceId, query);

    expect(result).toEqual({ period, currency: 'EUR', total: { amount: '810.50', count: 9 } });
  });

  it('keeps the sign of a negative net', async () => {
    transactionQueriesService.getStatisticsTotals.mockResolvedValue({
      income: 0n,
      incomeCount: 0,
      expense: 1000n,
      expenseCount: 1,
    });

    const result = await service.getSummary(userId, spaceId, query);

    expect(result.net).toBe('-10.00');
  });

  it('does not query a period that has not started', async () => {
    const result = await service.getSummary(userId, spaceId, { ...query, anchor_date: '2026-10-01' });

    expect(result.period.state).toBe('future');
    expect(result).toMatchObject({
      income: { amount: '0.00', count: 0 },
      expense: { amount: '0.00', count: 0 },
      net: '0.00',
      transactions_count: 0,
    });
    expect(transactionQueriesService.getStatisticsTotals).not.toHaveBeenCalled();
  });

  it('checks membership before anything else', async () => {
    spaceAccessService.assertMembership.mockRejectedValue(new HttpException(ErrorMessages.FORBIDDEN_SPACE, 403));

    await expect(service.getTrend(userId, spaceId, query)).rejects.toThrow(ErrorMessages.FORBIDDEN_SPACE);
    expect(spacesService.getOne).not.toHaveBeenCalled();
    expect(transactionQueriesService.getStatisticsTotals).not.toHaveBeenCalled();
  });
});
