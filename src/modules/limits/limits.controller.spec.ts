import { Test, TestingModule } from '@nestjs/testing';
import { HttpException } from '@nestjs/common';

import { LimitsController } from './limits.controller';
import { LimitsService } from './limits.service';
import { TransactionsService } from '../transactions/transactions.service';
import { ErrorMessages } from '../../shared/error-messages';
import { TransactionType } from '../../shared/enums';

describe('LimitsController', () => {
  let controller: LimitsController;
  let limitsService: jest.Mocked<LimitsService>;
  let transactionsService: jest.Mocked<TransactionsService>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [LimitsController],
      providers: [
        {
          provide: LimitsService,
          useValue: { getAll: jest.fn(), getOne: jest.fn(), create: jest.fn(), update: jest.fn() },
        },
        { provide: TransactionsService, useValue: { getForAllWallets: jest.fn() } },
      ],
    }).compile();

    controller = module.get(LimitsController);
    limitsService = module.get(LimitsService);
    transactionsService = module.get(TransactionsService);
  });

  const req = { user: { id: 1 } } as any;

  describe('getAll', () => {
    it('computes spent amounts and percentages per limit and overall', async () => {
      limitsService.getAll.mockResolvedValue([
        { id: 1, user_id: 1, category_id: 1, amount: 100 },
        { id: 2, user_id: 1, category_id: null, amount: 50 },
      ] as any);
      transactionsService.getForAllWallets.mockResolvedValue([
        { category_id: 1, transaction_type: TransactionType.EXPENSE, amount: 40 },
        { category_id: 2, transaction_type: TransactionType.EXPENSE, amount: 10 },
        { category_id: 1, transaction_type: TransactionType.INCOME, amount: 1000 },
      ] as any);

      const result = await controller.getAll(req);

      expect(result.limits[0]).toMatchObject({ spent: 40, in_percent: 40 });
      expect(result.limits[1]).toMatchObject({ spent: 10, in_percent: 20 });
      expect(result.overall).toMatchObject({ spent: 50, sum: 150, in_percent: 33 });
    });
  });

  describe('create', () => {
    it('rejects a duplicate category limit', async () => {
      limitsService.getAll.mockResolvedValue([{ category_id: 5 }] as any);

      await expect(controller.create(req, { category_id: 5, amount: 10 } as any)).rejects.toMatchObject(
        new HttpException(ErrorMessages.LIMIT_EXISTS, 400),
      );
      expect(limitsService.create).not.toHaveBeenCalled();
    });

    it('rejects a duplicate "others" limit', async () => {
      limitsService.getAll.mockResolvedValue([{ category_id: null }] as any);

      await expect(controller.create(req, { amount: 10 } as any)).rejects.toMatchObject(
        new HttpException(ErrorMessages.LIMIT_EXISTS, 400),
      );
    });

    it('creates a limit when no conflicting one exists', async () => {
      limitsService.getAll.mockResolvedValue([]);
      limitsService.create.mockResolvedValue({ id: 1 } as any);

      const result = await controller.create(req, { category_id: 5, amount: 10 } as any);

      expect(limitsService.create).toHaveBeenCalledWith(1, { category_id: 5, amount: 10 });
      expect(result).toEqual({ id: 1 });
    });
  });

  describe('update', () => {
    it('rejects updating a limit owned by someone else', async () => {
      limitsService.getOne.mockResolvedValue({ id: 1, user_id: 2, category_id: 5 } as any);

      await expect(controller.update(req, 1, { category_id: 5, amount: 20 } as any)).rejects.toMatchObject(
        new HttpException(ErrorMessages.FORBIDDEN_CATEGORY, 403),
      );
      expect(limitsService.update).not.toHaveBeenCalled();
    });

    it('re-validates for duplicates only when the category changes', async () => {
      limitsService.getOne.mockResolvedValue({ id: 1, user_id: 1, category_id: 5 } as any);

      await controller.update(req, 1, { category_id: 5, amount: 20 } as any);

      expect(limitsService.getAll).not.toHaveBeenCalled();
      expect(limitsService.update).toHaveBeenCalledWith(1, { category_id: 5, amount: 20 });
    });

    it('rejects switching to a category that already has a limit', async () => {
      limitsService.getOne.mockResolvedValue({ id: 1, user_id: 1, category_id: 5 } as any);
      limitsService.getAll.mockResolvedValue([{ category_id: 6 }] as any);

      await expect(controller.update(req, 1, { category_id: 6, amount: 20 } as any)).rejects.toMatchObject(
        new HttpException(ErrorMessages.LIMIT_EXISTS, 400),
      );
      expect(limitsService.update).not.toHaveBeenCalled();
    });
  });
});
