import { Test, TestingModule } from '@nestjs/testing';
import { HttpException } from '@nestjs/common';

import { LimitsController } from './limits.controller';
import { LimitsService } from './limits.service';
import { TransactionsService } from '@modules/transactions/transactions.service';
import { CategoriesService } from '@modules/categories/categories.service';
import { SpaceAccessService } from '@modules/space-access/space-access.service';
import { ErrorMessages } from '@shared/error-messages';

describe('LimitsController', () => {
  let controller: LimitsController;
  let limitsService: jest.Mocked<LimitsService>;
  let transactionsService: jest.Mocked<TransactionsService>;
  let categoriesService: jest.Mocked<CategoriesService>;
  let spaceAccessService: jest.Mocked<SpaceAccessService>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [LimitsController],
      providers: [
        {
          provide: LimitsService,
          useValue: {
            getAll: jest.fn(),
            getOne: jest.fn(),
            create: jest.fn(),
            update: jest.fn(),
            remove: jest.fn(),
            calculateSpending: jest.fn(),
          },
        },
        { provide: TransactionsService, useValue: { getExpensesByCategory: jest.fn() } },
        { provide: CategoriesService, useValue: { getMany: jest.fn() } },
        { provide: SpaceAccessService, useValue: { assertMembership: jest.fn() } },
      ],
    }).compile();

    controller = module.get(LimitsController);
    limitsService = module.get(LimitsService);
    transactionsService = module.get(TransactionsService);
    categoriesService = module.get(CategoriesService);
    spaceAccessService = module.get(SpaceAccessService);
  });

  const req = { user: { id: 1 } } as any;
  const spaceId = 10;

  describe('getAll', () => {
    it('fetches limits and category expense totals, then delegates the spending calculation to the service', async () => {
      const categoryTotals = new Map([[10, 100]]);
      limitsService.getAll.mockResolvedValue([{ id: 1 }] as any);
      transactionsService.getExpensesByCategory.mockResolvedValue(categoryTotals);
      limitsService.calculateSpending.mockReturnValue({ total: null, categories: [], over_allocation: null } as any);

      const result = await controller.getAll(req, spaceId);

      expect(spaceAccessService.assertMembership).toHaveBeenCalledWith(spaceId, 1);
      expect(limitsService.calculateSpending).toHaveBeenCalledWith([{ id: 1 }], categoryTotals);
      expect(result).toEqual({ total: null, categories: [], over_allocation: null });
    });
  });

  describe('create', () => {
    it('delegates to LimitsService.create', async () => {
      categoriesService.getMany.mockResolvedValue([{ id: 5, space_id: spaceId }] as any);
      limitsService.create.mockResolvedValue({ id: 1 } as any);

      const result = await controller.create(req, spaceId, { category_ids: [5], amount: 10 } as any);

      expect(categoriesService.getMany).toHaveBeenCalledWith([5]);
      expect(limitsService.create).toHaveBeenCalledWith(spaceId, { category_ids: [5], amount: 10 });
      expect(result).toEqual({ id: 1 });
    });

    it('checks every category in a single batched call, not one per id', async () => {
      categoriesService.getMany.mockResolvedValue([
        { id: 5, space_id: spaceId },
        { id: 6, space_id: spaceId },
      ] as any);
      limitsService.create.mockResolvedValue({ id: 1 } as any);

      await controller.create(req, spaceId, { category_ids: [5, 6], name: 'Fun', amount: 10 } as any);

      expect(categoriesService.getMany).toHaveBeenCalledTimes(1);
      expect(categoriesService.getMany).toHaveBeenCalledWith([5, 6]);
    });

    it('passes a duplicate category id through unchanged - dedup is the service read, not a data change', async () => {
      categoriesService.getMany.mockResolvedValue([{ id: 5, space_id: spaceId }] as any);
      limitsService.create.mockResolvedValue({ id: 1 } as any);

      await controller.create(req, spaceId, { category_ids: [5, 5], amount: 10 } as any);

      expect(categoriesService.getMany).toHaveBeenCalledWith([5, 5]);
      expect(limitsService.create).toHaveBeenCalledWith(spaceId, { category_ids: [5, 5], amount: 10 });
    });

    it('allows creating a monthly total limit with no categories', async () => {
      limitsService.create.mockResolvedValue({ id: 1 } as any);

      await controller.create(req, spaceId, { amount: 2000 } as any);

      expect(categoriesService.getMany).not.toHaveBeenCalled();
      expect(limitsService.create).toHaveBeenCalledWith(spaceId, { amount: 2000 });
    });

    it('rejects creating a limit for a category belonging to a different space', async () => {
      categoriesService.getMany.mockResolvedValue([{ id: 5, space_id: 20 }] as any);

      await expect(controller.create(req, spaceId, { category_ids: [5], amount: 10 } as any)).rejects.toMatchObject(
        new HttpException(ErrorMessages.FORBIDDEN_CATEGORY, 403),
      );
      expect(limitsService.create).not.toHaveBeenCalled();
    });

    it('rejects creating a limit for a category id that does not exist', async () => {
      categoriesService.getMany.mockResolvedValue([]);

      await expect(controller.create(req, spaceId, { category_ids: [5], amount: 10 } as any)).rejects.toMatchObject(
        new HttpException(ErrorMessages.FORBIDDEN_CATEGORY, 403),
      );
      expect(limitsService.create).not.toHaveBeenCalled();
    });

    it('rejects creating a limit for a system category', async () => {
      categoriesService.getMany.mockResolvedValue([{ id: 5, space_id: spaceId, is_system: 1 }] as any);

      await expect(controller.create(req, spaceId, { category_ids: [5], amount: 10 } as any)).rejects.toMatchObject(
        new HttpException(ErrorMessages.CATEGORY_IS_SYSTEM, 400),
      );
      expect(limitsService.create).not.toHaveBeenCalled();
    });

    it('propagates a duplicate-limit rejection from the service', async () => {
      categoriesService.getMany.mockResolvedValue([{ id: 5, space_id: spaceId }] as any);
      limitsService.create.mockRejectedValue(new HttpException(ErrorMessages.LIMIT_EXISTS, 400));

      await expect(controller.create(req, spaceId, { category_ids: [5], amount: 10 } as any)).rejects.toMatchObject(
        new HttpException(ErrorMessages.LIMIT_EXISTS, 400),
      );
    });
  });

  describe('update', () => {
    it('rejects updating a limit that belongs to a different space', async () => {
      limitsService.getOne.mockResolvedValue({ id: 1, space_id: 20, categories: [] } as any);

      await expect(controller.update(req, spaceId, 1, { category_ids: [5], amount: 20 } as any)).rejects.toMatchObject(
        new HttpException(ErrorMessages.FORBIDDEN_LIMIT, 403),
      );
      expect(limitsService.update).not.toHaveBeenCalled();
    });

    it('rejects updating a limit to reference a category belonging to a different space', async () => {
      limitsService.getOne.mockResolvedValue({ id: 1, space_id: spaceId, categories: [{ id: 5 }] } as any);
      categoriesService.getMany.mockResolvedValue([{ id: 6, space_id: 20 }] as any);

      await expect(controller.update(req, spaceId, 1, { category_ids: [6], amount: 20 } as any)).rejects.toMatchObject(
        new HttpException(ErrorMessages.FORBIDDEN_CATEGORY, 403),
      );
      expect(limitsService.update).not.toHaveBeenCalled();
    });

    it('rejects updating a limit to reference a system category', async () => {
      limitsService.getOne.mockResolvedValue({ id: 1, space_id: spaceId, categories: [{ id: 5 }] } as any);
      categoriesService.getMany.mockResolvedValue([{ id: 6, space_id: spaceId, is_system: 1 }] as any);

      await expect(controller.update(req, spaceId, 1, { category_ids: [6], amount: 20 } as any)).rejects.toMatchObject(
        new HttpException(ErrorMessages.CATEGORY_IS_SYSTEM, 400),
      );
      expect(limitsService.update).not.toHaveBeenCalled();
    });

    it('delegates to LimitsService.update with the current limit and returns the refreshed one', async () => {
      const current = { id: 1, space_id: spaceId, categories: [{ id: 5 }] };
      limitsService.getOne.mockResolvedValueOnce(current as any).mockResolvedValueOnce({ id: 1, amount: 20 } as any);
      categoriesService.getMany.mockResolvedValue([{ id: 6, space_id: spaceId }] as any);

      const result = await controller.update(req, spaceId, 1, { category_ids: [6], amount: 20 } as any);

      expect(limitsService.update).toHaveBeenCalledWith(1, spaceId, current, { category_ids: [6], amount: 20 });
      expect(result).toEqual({ id: 1, amount: 20 });
    });
  });

  describe('remove', () => {
    it('rejects deleting a limit that belongs to a different space', async () => {
      limitsService.getOne.mockResolvedValue({ id: 1, space_id: 20 } as any);

      await expect(controller.remove(req, spaceId, 1)).rejects.toMatchObject(
        new HttpException(ErrorMessages.FORBIDDEN_LIMIT, 403),
      );
      expect(limitsService.remove).not.toHaveBeenCalled();
    });

    it('deletes a limit that belongs to the space', async () => {
      limitsService.getOne.mockResolvedValue({ id: 1, space_id: spaceId } as any);

      const result = await controller.remove(req, spaceId, 1);

      expect(limitsService.remove).toHaveBeenCalledWith(1);
      expect(result).toBe(true);
    });
  });
});
