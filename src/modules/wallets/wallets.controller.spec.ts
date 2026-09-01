import { Test, TestingModule } from '@nestjs/testing';
import { HttpException } from '@nestjs/common';

import { WalletsController } from './wallets.controller';
import { WalletsService } from './wallets.service';
import { TransactionsService } from '../transactions/transactions.service';
import { ErrorMessages } from '../../shared/error-messages';

describe('WalletsController', () => {
  let controller: WalletsController;
  let walletsService: jest.Mocked<WalletsService>;
  let transactionsService: jest.Mocked<TransactionsService>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [WalletsController],
      providers: [
        {
          provide: WalletsService,
          useValue: {
            create: jest.fn(),
            getOne: jest.fn(),
            update: jest.fn(),
            getAll: jest.fn(),
            delete: jest.fn(),
            summarize: jest.fn(),
          },
        },
        { provide: TransactionsService, useValue: { getAllForWallets: jest.fn() } },
      ],
    }).compile();

    controller = module.get(WalletsController);
    walletsService = module.get(WalletsService);
    transactionsService = module.get(TransactionsService);
  });

  const req = { user: { id: 1 } } as any;

  describe('create', () => {
    it('creates a wallet for the current user', async () => {
      walletsService.create.mockResolvedValue({ id: 1 } as any);

      const result = await controller.create(req, { wallet_name: 'Cash' } as any);

      expect(walletsService.create).toHaveBeenCalledWith(1, { wallet_name: 'Cash' });
      expect(result).toEqual({ id: 1 });
    });
  });

  describe('update', () => {
    it('rejects updating a wallet owned by someone else', async () => {
      walletsService.getOne.mockResolvedValue({ id: 1, user_id: 2 } as any);

      await expect(controller.update(req, 1, {} as any)).rejects.toMatchObject(
        new HttpException(ErrorMessages.FORBIDDEN_WALLET, 403),
      );
      expect(walletsService.update).not.toHaveBeenCalled();
    });

    it('updates a wallet owned by the current user', async () => {
      walletsService.getOne.mockResolvedValue({ id: 1, user_id: 1 } as any);

      await controller.update(req, 1, { wallet_name: 'Renamed' } as any);

      expect(walletsService.update).toHaveBeenCalledWith(1, { wallet_name: 'Renamed' });
    });
  });

  describe('delete', () => {
    it('rejects deleting a wallet owned by someone else', async () => {
      walletsService.getOne.mockResolvedValue({ id: 1, user_id: 2 } as any);

      await expect(controller.delete(req, 1)).rejects.toMatchObject(
        new HttpException(ErrorMessages.FORBIDDEN_WALLET, 403),
      );
      expect(walletsService.delete).not.toHaveBeenCalled();
    });

    it('deletes a wallet owned by the current user', async () => {
      walletsService.getOne.mockResolvedValue({ id: 1, user_id: 1 } as any);

      const result = await controller.delete(req, 1);

      expect(walletsService.delete).toHaveBeenCalledWith(1);
      expect(result).toBe(true);
    });
  });

  describe('getAll', () => {
    it('fetches every wallet transaction in a single query and delegates the summary to the service', async () => {
      const wallets = [{ id: 1 }, { id: 2 }] as any;
      const transactions = [{ wallet_id: 1, amount: '100' }] as any;
      walletsService.getAll.mockResolvedValue(wallets);
      transactionsService.getAllForWallets.mockResolvedValue(transactions);
      walletsService.summarize.mockReturnValue([{ wallet: { id: 1 }, total_spend: 30, total_income: 100 }] as any);

      const from = new Date('2026-01-01');
      const to = new Date('2026-01-31');
      const result = await controller.getAll(req, from, to);

      expect(transactionsService.getAllForWallets).toHaveBeenCalledWith([1, 2], from, to);
      expect(walletsService.summarize).toHaveBeenCalledWith(wallets, transactions);
      expect(result).toEqual([{ wallet: { id: 1 }, total_spend: 30, total_income: 100 }]);
    });
  });
});
