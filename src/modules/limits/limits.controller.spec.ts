import { Test, TestingModule } from '@nestjs/testing';
import { HttpException } from '@nestjs/common';

import { LimitsController } from './limits.controller';
import { LimitsService } from './limits.service';
import { TransactionsService } from '../transactions/transactions.service';
import { ErrorMessages } from '../../shared/error-messages';

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
          useValue: {
            getAll: jest.fn(),
            getOne: jest.fn(),
            create: jest.fn(),
            update: jest.fn(),
            calculateSpending: jest.fn(),
          },
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
    it('fetches limits and transactions, then delegates the spending calculation to the service', async () => {
      limitsService.getAll.mockResolvedValue([{ id: 1 }] as any);
      transactionsService.getForAllWallets.mockResolvedValue([{ id: 'tx-1' }] as any);
      limitsService.calculateSpending.mockReturnValue({ limits: [], overall: {} } as any);

      const result = await controller.getAll(req);

      expect(limitsService.calculateSpending).toHaveBeenCalledWith([{ id: 1 }], [{ id: 'tx-1' }]);
      expect(result).toEqual({ limits: [], overall: {} });
    });
  });

  describe('create', () => {
    it('delegates to LimitsService.create', async () => {
      limitsService.create.mockResolvedValue({ id: 1 } as any);

      const result = await controller.create(req, { category_id: 5, amount: 10 } as any);

      expect(limitsService.create).toHaveBeenCalledWith(1, { category_id: 5, amount: 10 });
      expect(result).toEqual({ id: 1 });
    });

    it('propagates a duplicate-limit rejection from the service', async () => {
      limitsService.create.mockRejectedValue(new HttpException(ErrorMessages.LIMIT_EXISTS, 400));

      await expect(controller.create(req, { category_id: 5, amount: 10 } as any)).rejects.toMatchObject(
        new HttpException(ErrorMessages.LIMIT_EXISTS, 400),
      );
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

    it('delegates to LimitsService.update with the current category id', async () => {
      limitsService.getOne.mockResolvedValue({ id: 1, user_id: 1, category_id: 5 } as any);

      await controller.update(req, 1, { category_id: 6, amount: 20 } as any);

      expect(limitsService.update).toHaveBeenCalledWith(1, 1, 5, { category_id: 6, amount: 20 });
    });
  });
});
