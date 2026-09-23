import { Test, TestingModule } from '@nestjs/testing';
import { HttpException } from '@nestjs/common';

import { TransactionsController } from './transactions.controller';
import { TransactionsService } from './transactions.service';
import { TransactionQueriesService } from '@modules/transaction-queries/transaction-queries.service';
import { WalletsService } from '@modules/wallets/wallets.service';
import { CategoriesService } from '@modules/categories/categories.service';
import { SpaceAccessService } from '@modules/space-access/space-access.service';
import { ErrorMessages } from '@shared/error-messages';
import { TransactionType } from '@shared/enums';

describe('TransactionsController', () => {
  let controller: TransactionsController;
  let transactionsService: jest.Mocked<TransactionsService>;
  let transactionQueriesService: jest.Mocked<TransactionQueriesService>;
  let walletsService: jest.Mocked<WalletsService>;
  let categoriesService: jest.Mocked<CategoriesService>;
  let spaceAccessService: jest.Mocked<SpaceAccessService>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [TransactionsController],
      providers: [
        {
          provide: TransactionsService,
          useValue: { create: jest.fn(), remove: jest.fn() },
        },
        {
          provide: TransactionQueriesService,
          useValue: { getForAllWallets: jest.fn(), getOneWithWallet: jest.fn(), getLatest: jest.fn() },
        },
        { provide: WalletsService, useValue: { getOne: jest.fn() } },
        { provide: CategoriesService, useValue: { getOne: jest.fn() } },
        { provide: SpaceAccessService, useValue: { assertMembership: jest.fn() } },
      ],
    }).compile();

    controller = module.get(TransactionsController);
    transactionsService = module.get(TransactionsService);
    transactionQueriesService = module.get(TransactionQueriesService);
    walletsService = module.get(WalletsService);
    categoriesService = module.get(CategoriesService);
    spaceAccessService = module.get(SpaceAccessService);
  });

  const req = { user: { id: 1 } } as any;
  const spaceId = 10;

  describe('create', () => {
    it('rejects when the wallet belongs to a different space', async () => {
      walletsService.getOne.mockResolvedValue({ id: 1, space_id: 20 } as any);

      await expect(
        controller.create(req, spaceId, {
          wallet_id: 1,
          transaction_type: TransactionType.EXPENSE,
          amount: 10,
        } as any),
      ).rejects.toMatchObject(new HttpException(ErrorMessages.FORBIDDEN_WALLET, 403));
      expect(transactionsService.create).not.toHaveBeenCalled();
    });

    it('rejects when the wallet was soft-deleted', async () => {
      walletsService.getOne.mockResolvedValue({ id: 1, space_id: spaceId, is_deleted: 1 } as any);

      await expect(
        controller.create(req, spaceId, {
          wallet_id: 1,
          transaction_type: TransactionType.EXPENSE,
          amount: 10,
        } as any),
      ).rejects.toMatchObject(new HttpException(ErrorMessages.FORBIDDEN_WALLET, 403));
      expect(transactionsService.create).not.toHaveBeenCalled();
    });

    it('rejects when the wallet does not exist', async () => {
      walletsService.getOne.mockResolvedValue(null);

      await expect(
        controller.create(req, spaceId, {
          wallet_id: 1,
          transaction_type: TransactionType.EXPENSE,
          amount: 10,
        } as any),
      ).rejects.toMatchObject(new HttpException(ErrorMessages.FORBIDDEN_WALLET, 403));
      expect(transactionsService.create).not.toHaveBeenCalled();
    });

    it('rejects when the category belongs to a different space', async () => {
      walletsService.getOne.mockResolvedValue({ id: 1, space_id: spaceId } as any);
      categoriesService.getOne.mockResolvedValue({ id: 5, space_id: 20 } as any);

      await expect(
        controller.create(req, spaceId, {
          wallet_id: 1,
          category_id: 5,
          transaction_type: TransactionType.EXPENSE,
          amount: 10,
        } as any),
      ).rejects.toMatchObject(new HttpException(ErrorMessages.FORBIDDEN_CATEGORY, 403));
      expect(transactionsService.create).not.toHaveBeenCalled();
    });

    it('rejects when the category is a system category', async () => {
      const wallet = { id: 1, space_id: spaceId };
      walletsService.getOne.mockResolvedValue(wallet as any);
      categoriesService.getOne.mockResolvedValue({ id: 5, space_id: spaceId, is_system: 1 } as any);

      await expect(
        controller.create(req, spaceId, {
          wallet_id: 1,
          category_id: 5,
          transaction_type: TransactionType.INCOME,
          amount: 10,
        } as any),
      ).rejects.toMatchObject(new HttpException(ErrorMessages.FORBIDDEN_CATEGORY, 403));
      expect(transactionsService.create).not.toHaveBeenCalled();
    });

    it('delegates to TransactionsService with the loaded wallet entity', async () => {
      const wallet = { id: 1, space_id: spaceId };
      walletsService.getOne.mockResolvedValue(wallet as any);
      categoriesService.getOne.mockResolvedValue({ id: 5, space_id: spaceId } as any);
      const dto = {
        wallet_id: 1,
        category_id: 5,
        transaction_type: TransactionType.INCOME,
        amount: 50,
      } as any;
      const created = { transaction: { id: 99 }, wallet: { id: 1, balance: 150 }, previous_balance: 100 };
      transactionsService.create.mockResolvedValue(created as any);

      const result = await controller.create(req, spaceId, dto);

      expect(spaceAccessService.assertMembership).toHaveBeenCalledWith(spaceId, 1);
      expect(transactionsService.create).toHaveBeenCalledWith(wallet, dto);
      expect(result).toEqual(created);
    });
  });

  describe('getAll', () => {
    it('nulls out the wallet on transactions whose wallet was soft-deleted', async () => {
      transactionQueriesService.getForAllWallets.mockResolvedValue([
        { id: 1, wallet: { id: 1, is_deleted: 0 } },
        { id: 2, wallet: { id: 2, is_deleted: 1 } },
      ] as any);

      const result = await controller.getAll(req, spaceId);

      expect(spaceAccessService.assertMembership).toHaveBeenCalledWith(spaceId, 1);
      expect(transactionQueriesService.getForAllWallets).toHaveBeenCalledWith(
        spaceId,
        expect.any(Date),
        expect.any(Date),
      );
      expect(result[0].wallet).toEqual({ id: 1, is_deleted: 0 });
      expect(result[1].wallet).toBeNull();
    });
  });

  describe('getLatest', () => {
    it('returns null when the space has no transactions', async () => {
      transactionQueriesService.getLatest.mockResolvedValue(null);

      const result = await controller.getLatest(req, spaceId);

      expect(spaceAccessService.assertMembership).toHaveBeenCalledWith(spaceId, 1);
      expect(transactionQueriesService.getLatest).toHaveBeenCalledWith(spaceId);
      expect(result).toBeNull();
    });

    it('nulls out the wallet when it was soft-deleted', async () => {
      transactionQueriesService.getLatest.mockResolvedValue({ id: 1, wallet: { id: 1, is_deleted: 1 } } as any);

      const result = await controller.getLatest(req, spaceId);

      expect(result.wallet).toBeNull();
    });
  });

  describe('remove', () => {
    it('rejects when the transaction does not exist', async () => {
      transactionQueriesService.getOneWithWallet.mockResolvedValue(null);

      await expect(controller.remove(req, spaceId, 'tx-1')).rejects.toMatchObject(
        new HttpException(ErrorMessages.FORBIDDEN_WALLET, 403),
      );
      expect(transactionsService.remove).not.toHaveBeenCalled();
    });

    it('rejects when the transaction belongs to a different space', async () => {
      transactionQueriesService.getOneWithWallet.mockResolvedValue({
        id: 'tx-1',
        wallet: { id: 1, space_id: 20 },
      } as any);

      await expect(controller.remove(req, spaceId, 'tx-1')).rejects.toMatchObject(
        new HttpException(ErrorMessages.FORBIDDEN_WALLET, 403),
      );
      expect(transactionsService.remove).not.toHaveBeenCalled();
    });

    it('removes the transaction when its wallet belongs to the space', async () => {
      const transaction = { id: 'tx-1', wallet: { id: 1, space_id: spaceId } };
      transactionQueriesService.getOneWithWallet.mockResolvedValue(transaction as any);

      const result = await controller.remove(req, spaceId, 'tx-1');

      expect(transactionsService.remove).toHaveBeenCalledWith(transaction);
      expect(result).toBe(true);
    });
  });
});
