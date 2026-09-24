import { Test, TestingModule } from '@nestjs/testing';

import { LimitsController } from './limits.controller';
import { LimitsService } from './limits.service';
import type { AuthedRequest } from '@shared/types';
import { withRelations } from '@shared/utils';
import { buildCategory, buildLimit } from '@testing';

describe('LimitsController', () => {
  let controller: LimitsController;
  let limitsService: jest.Mocked<LimitsService>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [LimitsController],
      providers: [
        {
          provide: LimitsService,
          useValue: { getSummary: jest.fn(), create: jest.fn(), update: jest.fn(), remove: jest.fn() },
        },
      ],
    }).compile();

    controller = module.get(LimitsController);
    limitsService = module.get(LimitsService);
  });

  const req: AuthedRequest = { user: { id: 1 } };
  const spaceId = 10;

  it('getAll delegates to LimitsService.getSummary', async () => {
    const summary = { total: null, categories: [], over_allocation: null };
    limitsService.getSummary.mockResolvedValue(summary);

    const result = await controller.getAll(req, spaceId);

    expect(limitsService.getSummary).toHaveBeenCalledWith(1, spaceId);
    expect(result).toBe(summary);
  });

  it('create delegates to LimitsService.create', async () => {
    const limit = withRelations(buildLimit({ categories: [buildCategory({ id: 5 })] }), 'categories');
    limitsService.create.mockResolvedValue(limit);

    const result = await controller.create(req, spaceId, { category_ids: [5], amount: '10' });

    expect(limitsService.create).toHaveBeenCalledWith(1, spaceId, { category_ids: [5], amount: '10' });
    expect(result).toBe(limit);
  });

  it('update delegates to LimitsService.update and returns the refreshed limit', async () => {
    const limit = withRelations(buildLimit({ id: 3, amount: '20.00', categories: [] }), 'categories');
    limitsService.update.mockResolvedValue(limit);

    const result = await controller.update(req, spaceId, 3, { amount: '20' });

    expect(limitsService.update).toHaveBeenCalledWith(1, spaceId, 3, { amount: '20' });
    expect(result).toBe(limit);
  });

  it('remove delegates to LimitsService.remove and returns true', async () => {
    const result = await controller.remove(req, spaceId, 3);

    expect(limitsService.remove).toHaveBeenCalledWith(1, spaceId, 3);
    expect(result).toBe(true);
  });
});
