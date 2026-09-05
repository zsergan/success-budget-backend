import { Test, TestingModule } from '@nestjs/testing';
import { HttpException } from '@nestjs/common';

import { LimitsController } from './limits.controller';
import { LimitsService } from './limits.service';
import { TransactionsService } from '@modules/transactions/transactions.service';
import { CategoriesService } from '@modules/categories/categories.service';
import { ErrorMessages } from '@shared/error-messages';

describe('LimitsController', () => {
  let controller: LimitsController;
  let limitsService: jest.Mocked<LimitsService>;
  let transactionsService: jest.Mocked<TransactionsService>;
  let categoriesService: jest.Mocked<CategoriesService>;

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
        { provide: TransactionsService, useValue: { getForAllWallets: jest.fn() } },
        { provide: CategoriesService, useValue: { getOne: jest.fn() } },
      ],
    }).compile();

    controller = module.get(LimitsController);
    limitsService = module.get(LimitsService);
    transactionsService = module.get(TransactionsService);
    categoriesService = module.get(CategoriesService);
  });

  const req = { user: { id: 1 } } as any;

  describe('getAll', () => {
    it('fetches limits and transactions, then delegates the spending calculation to the service', async () => {
      limitsService.getAll.mockResolvedValue([{ id: 1 }] as any);
      transactionsService.getForAllWallets.mockResolvedValue([{ id: 'tx-1' }] as any);
      limitsService.calculateSpending.mockReturnValue({ total: null, categories: [], over_allocation: null } as any);

      const result = await controller.getAll(req);

      expect(limitsService.calculateSpending).toHaveBeenCalledWith([{ id: 1 }], [{ id: 'tx-1' }]);
      expect(result).toEqual({ total: null, categories: [], over_allocation: null });
    });
  });

  describe('create', () => {
    it('delegates to LimitsService.create', async () => {
      categoriesService.getOne.mockResolvedValue({ id: 5, user_id: 1 } as any);
      limitsService.create.mockResolvedValue({ id: 1 } as any);

      const result = await controller.create(req, { category_ids: [5], amount: 10 } as any);

      expect(limitsService.create).toHaveBeenCalledWith(1, { category_ids: [5], amount: 10 });
      expect(result).toEqual({ id: 1 });
    });

    it('allows creating a monthly total limit with no categories', async () => {
      limitsService.create.mockResolvedValue({ id: 1 } as any);

      await controller.create(req, { amount: 2000 } as any);

      expect(categoriesService.getOne).not.toHaveBeenCalled();
      expect(limitsService.create).toHaveBeenCalledWith(1, { amount: 2000 });
    });

    it('rejects creating a limit for a category belonging to someone else', async () => {
      categoriesService.getOne.mockResolvedValue({ id: 5, user_id: 2 } as any);

      await expect(controller.create(req, { category_ids: [5], amount: 10 } as any)).rejects.toMatchObject(
        new HttpException(ErrorMessages.FORBIDDEN_CATEGORY, 403),
      );
      expect(limitsService.create).not.toHaveBeenCalled();
    });

    it('propagates a duplicate-limit rejection from the service', async () => {
      categoriesService.getOne.mockResolvedValue({ id: 5, user_id: 1 } as any);
      limitsService.create.mockRejectedValue(new HttpException(ErrorMessages.LIMIT_EXISTS, 400));

      await expect(controller.create(req, { category_ids: [5], amount: 10 } as any)).rejects.toMatchObject(
        new HttpException(ErrorMessages.LIMIT_EXISTS, 400),
      );
    });
  });

  describe('update', () => {
    it('rejects updating a limit owned by someone else', async () => {
      limitsService.getOne.mockResolvedValue({ id: 1, user_id: 2, categories: [] } as any);

      await expect(controller.update(req, 1, { category_ids: [5], amount: 20 } as any)).rejects.toMatchObject(
        new HttpException(ErrorMessages.FORBIDDEN_LIMIT, 403),
      );
      expect(limitsService.update).not.toHaveBeenCalled();
    });

    it('rejects updating a limit to reference a category belonging to someone else', async () => {
      limitsService.getOne.mockResolvedValue({ id: 1, user_id: 1, categories: [{ id: 5 }] } as any);
      categoriesService.getOne.mockResolvedValue({ id: 6, user_id: 2 } as any);

      await expect(controller.update(req, 1, { category_ids: [6], amount: 20 } as any)).rejects.toMatchObject(
        new HttpException(ErrorMessages.FORBIDDEN_CATEGORY, 403),
      );
      expect(limitsService.update).not.toHaveBeenCalled();
    });

    it('delegates to LimitsService.update with the current limit and returns the refreshed one', async () => {
      const current = { id: 1, user_id: 1, categories: [{ id: 5 }] };
      limitsService.getOne.mockResolvedValueOnce(current as any).mockResolvedValueOnce({ id: 1, amount: 20 } as any);
      categoriesService.getOne.mockResolvedValue({ id: 6, user_id: 1 } as any);

      const result = await controller.update(req, 1, { category_ids: [6], amount: 20 } as any);

      expect(limitsService.update).toHaveBeenCalledWith(1, 1, current, { category_ids: [6], amount: 20 });
      expect(result).toEqual({ id: 1, amount: 20 });
    });
  });

  describe('remove', () => {
    it('rejects deleting a limit owned by someone else', async () => {
      limitsService.getOne.mockResolvedValue({ id: 1, user_id: 2 } as any);

      await expect(controller.remove(req, 1)).rejects.toMatchObject(
        new HttpException(ErrorMessages.FORBIDDEN_LIMIT, 403),
      );
      expect(limitsService.remove).not.toHaveBeenCalled();
    });

    it('deletes an owned limit', async () => {
      limitsService.getOne.mockResolvedValue({ id: 1, user_id: 1 } as any);

      const result = await controller.remove(req, 1);

      expect(limitsService.remove).toHaveBeenCalledWith(1);
      expect(result).toBe(true);
    });
  });
});
