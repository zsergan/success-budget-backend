import { Test, TestingModule } from '@nestjs/testing';
import { HttpException } from '@nestjs/common';

import { WalletsController } from './wallets.controller';
import { WalletsService } from './wallets.service';
import { TransactionQueriesService } from '@modules/transaction-queries/transaction-queries.service';
import { SpaceAccessService } from '@modules/space-access/space-access.service';
import { ErrorMessages } from '@shared/error-messages';

describe('WalletsController', () => {
  let controller: WalletsController;
  let walletsService: jest.Mocked<WalletsService>;
  let transactionQueriesService: jest.Mocked<TransactionQueriesService>;
  let spaceAccessService: jest.Mocked<SpaceAccessService>;

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
            buildOverview: jest.fn(),
          },
        },
        { provide: TransactionQueriesService, useValue: { getPeriodTotals: jest.fn(), getBalances: jest.fn() } },
        { provide: SpaceAccessService, useValue: { assertMembership: jest.fn() } },
      ],
    }).compile();

    controller = module.get(WalletsController);
    walletsService = module.get(WalletsService);
    transactionQueriesService = module.get(TransactionQueriesService);
    spaceAccessService = module.get(SpaceAccessService);
  });

  const req = { user: { id: 1 } } as any;
  const spaceId = 10;

  describe('create', () => {
    it('creates a wallet in the space', async () => {
      const created = { wallet: { id: 1 }, transaction: null };
      walletsService.create.mockResolvedValue(created as any);

      const result = await controller.create(req, spaceId, { wallet_name: 'Cash' } as any);

      expect(spaceAccessService.assertMembership).toHaveBeenCalledWith(spaceId, 1);
      expect(walletsService.create).toHaveBeenCalledWith(spaceId, { wallet_name: 'Cash' });
      expect(result).toEqual(created);
    });
  });

  describe('update', () => {
    it('rejects updating a wallet that belongs to a different space', async () => {
      walletsService.getOne.mockResolvedValue({ id: 1, space_id: 20 } as any);

      await expect(controller.update(req, spaceId, 1, {} as any)).rejects.toMatchObject(
        new HttpException(ErrorMessages.FORBIDDEN_WALLET, 403),
      );
      expect(walletsService.update).not.toHaveBeenCalled();
    });

    it('updates a wallet that belongs to the space', async () => {
      walletsService.getOne.mockResolvedValue({ id: 1, space_id: spaceId } as any);

      await controller.update(req, spaceId, 1, { wallet_name: 'Renamed' } as any);

      expect(walletsService.update).toHaveBeenCalledWith(1, { wallet_name: 'Renamed' });
    });
  });

  describe('delete', () => {
    it('rejects deleting a wallet that belongs to a different space', async () => {
      walletsService.getOne.mockResolvedValue({ id: 1, space_id: 20 } as any);

      await expect(controller.delete(req, spaceId, 1)).rejects.toMatchObject(
        new HttpException(ErrorMessages.FORBIDDEN_WALLET, 403),
      );
      expect(walletsService.delete).not.toHaveBeenCalled();
    });

    it('deletes a wallet that belongs to the space', async () => {
      walletsService.getOne.mockResolvedValue({ id: 1, space_id: spaceId } as any);

      const result = await controller.delete(req, spaceId, 1);

      expect(walletsService.delete).toHaveBeenCalledWith(1);
      expect(result).toBe(true);
    });
  });

  describe('getAll', () => {
    it('fetches period totals and derived balances in parallel and delegates the overview to the service', async () => {
      const wallets = [{ id: 1 }, { id: 2 }] as any;
      const periodTotals = new Map([
        [1, { income: 100, spend: 30 }],
        [2, { income: 0, spend: 0 }],
      ]);
      const balances = new Map([
        [1, 100],
        [2, 0],
      ]);
      const overview = {
        total_balance: 100,
        total_balance_currency: 'USD',
        delta_percent: 4.2,
        wallets: [{ wallet: { id: 1 }, total_spend: 30, total_income: 100 }],
      };
      walletsService.getAll.mockResolvedValue(wallets);
      transactionQueriesService.getPeriodTotals.mockResolvedValue(periodTotals);
      transactionQueriesService.getBalances.mockResolvedValue(balances);
      walletsService.buildOverview.mockResolvedValue(overview as any);

      const from = new Date('2026-01-01');
      const to = new Date('2026-01-31');
      const result = await controller.getAll(req, spaceId, from, to);

      expect(spaceAccessService.assertMembership).toHaveBeenCalledWith(spaceId, 1);
      expect(transactionQueriesService.getPeriodTotals).toHaveBeenCalledWith([1, 2], from, to);
      expect(transactionQueriesService.getBalances).toHaveBeenCalledWith([1, 2]);
      expect(walletsService.buildOverview).toHaveBeenCalledWith(spaceId, wallets, periodTotals, balances);
      expect(result).toEqual(overview);
    });
  });
});
