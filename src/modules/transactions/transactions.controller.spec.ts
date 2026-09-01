import { Test, TestingModule } from '@nestjs/testing';
import { HttpException } from '@nestjs/common';

import { TransactionsController } from './transactions.controller';
import { TransactionsService } from './transactions.service';
import { WalletsService } from '../wallets/wallets.service';
import { CategoriesService } from '../categories/categories.service';
import { ErrorMessages } from '../../shared/error-messages';
import { TransactionType } from '../../shared/enums';

describe('TransactionsController', () => {
  let controller: TransactionsController;
  let transactionsService: jest.Mocked<TransactionsService>;
  let walletsService: jest.Mocked<WalletsService>;
  let categoriesService: jest.Mocked<CategoriesService>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [TransactionsController],
      providers: [
        { provide: TransactionsService, useValue: { create: jest.fn(), getForAllWallets: jest.fn() } },
        { provide: WalletsService, useValue: { getOne: jest.fn() } },
        { provide: CategoriesService, useValue: { getOne: jest.fn() } },
      ],
    }).compile();

    controller = module.get(TransactionsController);
    transactionsService = module.get(TransactionsService);
    walletsService = module.get(WalletsService);
    categoriesService = module.get(CategoriesService);
  });

  const req = { user: { id: 1 } } as any;

  describe('create', () => {
    it('rejects when the wallet belongs to someone else', async () => {
      walletsService.getOne.mockResolvedValue({ id: 1, user_id: 2 } as any);

      await expect(
        controller.create(req, { wallet_id: 1, transaction_type: TransactionType.EXPENSE, amount: 10 } as any),
      ).rejects.toMatchObject(new HttpException(ErrorMessages.FORBIDDEN_WALLET, 403));
      expect(transactionsService.create).not.toHaveBeenCalled();
    });

    it('rejects when the wallet was soft-deleted', async () => {
      walletsService.getOne.mockResolvedValue({ id: 1, user_id: 1, is_deleted: 1 } as any);

      await expect(
        controller.create(req, { wallet_id: 1, transaction_type: TransactionType.EXPENSE, amount: 10 } as any),
      ).rejects.toMatchObject(new HttpException(ErrorMessages.FORBIDDEN_WALLET, 403));
      expect(transactionsService.create).not.toHaveBeenCalled();
    });

    it('rejects when the wallet does not exist', async () => {
      walletsService.getOne.mockResolvedValue(null);

      await expect(
        controller.create(req, { wallet_id: 1, transaction_type: TransactionType.EXPENSE, amount: 10 } as any),
      ).rejects.toMatchObject(new HttpException(ErrorMessages.FORBIDDEN_WALLET, 403));
      expect(transactionsService.create).not.toHaveBeenCalled();
    });

    it('rejects when the category belongs to someone else', async () => {
      walletsService.getOne.mockResolvedValue({ id: 1, user_id: 1, currency_id: 3 } as any);
      categoriesService.getOne.mockResolvedValue({ id: 5, user_id: 2 } as any);

      await expect(
        controller.create(req, {
          wallet_id: 1,
          category_id: 5,
          transaction_type: TransactionType.EXPENSE,
          amount: 10,
        } as any),
      ).rejects.toMatchObject(new HttpException(ErrorMessages.FORBIDDEN_CATEGORY, 403));
      expect(transactionsService.create).not.toHaveBeenCalled();
    });

    it('delegates to TransactionsService with the wallet id and currency', async () => {
      walletsService.getOne.mockResolvedValue({ id: 1, user_id: 1, currency_id: 3 } as any);
      categoriesService.getOne.mockResolvedValue({ id: 5, user_id: 1 } as any);
      const dto = {
        wallet_id: 1,
        category_id: 5,
        transaction_type: TransactionType.INCOME,
        amount: 50,
      } as any;
      transactionsService.create.mockResolvedValue({ id: 99 } as any);

      const result = await controller.create(req, dto);

      expect(transactionsService.create).toHaveBeenCalledWith(1, 3, dto);
      expect(result).toEqual({ id: 99 });
    });
  });

  describe('getAll', () => {
    it('nulls out the wallet on transactions whose wallet was soft-deleted', async () => {
      transactionsService.getForAllWallets.mockResolvedValue([
        { id: 1, wallet: { id: 1, is_deleted: 0 } },
        { id: 2, wallet: { id: 2, is_deleted: 1 } },
      ] as any);

      const result = await controller.getAll(req);

      expect(result[0].wallet).toEqual({ id: 1, is_deleted: 0 });
      expect(result[1].wallet).toBeNull();
    });
  });
});
