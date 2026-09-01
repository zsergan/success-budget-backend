import { Test, TestingModule } from '@nestjs/testing';
import { HttpException } from '@nestjs/common';

import { TransactionsController } from './transactions.controller';
import { TransactionsService } from './transactions.service';
import { WalletsService } from '../wallets/wallets.service';
import { ErrorMessages } from '../../shared/error-messages';
import { TransactionType } from '../../shared/enums';

describe('TransactionsController', () => {
  let controller: TransactionsController;
  let transactionsService: jest.Mocked<TransactionsService>;
  let walletsService: jest.Mocked<WalletsService>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [TransactionsController],
      providers: [
        { provide: TransactionsService, useValue: { create: jest.fn(), getForAllWallets: jest.fn() } },
        { provide: WalletsService, useValue: { getOne: jest.fn(), update: jest.fn() } },
      ],
    }).compile();

    controller = module.get(TransactionsController);
    transactionsService = module.get(TransactionsService);
    walletsService = module.get(WalletsService);
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

    it('increases the wallet balance for an income transaction', async () => {
      walletsService.getOne.mockResolvedValue({
        id: 1,
        user_id: 1,
        balance: 100,
        currency_id: 3,
        wallet_name: 'Cash',
        design: 'green',
      } as any);

      await controller.create(req, {
        wallet_id: 1,
        transaction_type: TransactionType.INCOME,
        amount: 50,
      } as any);

      expect(walletsService.update).toHaveBeenCalledWith(
        1,
        expect.objectContaining({ balance: 150, wallet_name: 'Cash', design: 'green' }),
      );
      expect(transactionsService.create).toHaveBeenCalledWith(
        3,
        expect.objectContaining({ wallet_id: 1, transaction_type: TransactionType.INCOME }),
      );
    });

    it('decreases the wallet balance for an expense transaction', async () => {
      walletsService.getOne.mockResolvedValue({
        id: 1,
        user_id: 1,
        balance: 100,
        currency_id: 3,
        wallet_name: 'Cash',
        design: 'green',
      } as any);

      await controller.create(req, {
        wallet_id: 1,
        transaction_type: TransactionType.EXPENSE,
        amount: 30,
      } as any);

      expect(walletsService.update).toHaveBeenCalledWith(1, expect.objectContaining({ balance: 70 }));
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
