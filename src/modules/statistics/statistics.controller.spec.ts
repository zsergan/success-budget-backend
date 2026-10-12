import { Test, TestingModule } from '@nestjs/testing';

import { StatisticsController } from './statistics.controller';
import { StatisticsService } from './statistics.service';
import type { StatisticsQueryDto } from './dto/statistics-query.dto';
import { StatisticsPeriodType } from '@shared/enums';
import type { AuthedRequest } from '@shared/types';

describe('StatisticsController', () => {
  let controller: StatisticsController;
  let statisticsService: jest.Mocked<StatisticsService>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [StatisticsController],
      providers: [
        {
          provide: StatisticsService,
          useValue: { getSummary: jest.fn(), getTrend: jest.fn(), getBreakdown: jest.fn() },
        },
      ],
    }).compile();

    controller = module.get(StatisticsController);
    statisticsService = module.get(StatisticsService);
  });

  const req: AuthedRequest = { user: { id: 1 } };
  const spaceId = 10;
  const query: StatisticsQueryDto = { period: StatisticsPeriodType.WEEK, time_zone: 'UTC' };

  it.each(['getSummary', 'getTrend', 'getBreakdown'] as const)('%s delegates to the service', async (method) => {
    const response = {} as never;
    statisticsService[method].mockResolvedValue(response);

    const result = await controller[method](req, spaceId, query);

    expect(statisticsService[method]).toHaveBeenCalledWith(1, spaceId, query);
    expect(result).toBe(response);
  });
});
