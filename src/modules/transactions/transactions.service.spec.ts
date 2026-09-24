import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { HttpException } from '@nestjs/common';

import { TransactionsService } from './transactions.service';
import { Transaction } from '@entities/transaction.entity';
import { TransactionType } from '@shared/enums';
import { ErrorMessages } from '@shared/error-messages';
import { TransactionQueriesService } from '@modules/transaction-queries/transaction-queries.service';
import { WalletsService } from '@modules/wallets/wallets.service';
import { CategoriesService } from '@modules/categories/categories.service';
import { SpaceAccessService } from '@modules/space-access/space-access.service';

describe('TransactionsService', () => {
  let service: TransactionsService;
  let transactionRepository: { create: jest.Mock; save: jest.Mock; delete: jest.Mock };
  let transactionQueriesService: {
    getBalances: jest.Mock;
    getForAllWallets: jest.Mock;
    getLatest: jest.Mock;
    getOneWithWallet: jest.Mock;
  };
  let walletsService: { getOne: jest.Mock };
  let categoriesService: { getOne: jest.Mock };
  let spaceAccessService: { assertMembership: jest.Mock };

  const userId = 1;
  const spaceId = 10;

  beforeEach(async () => {
    transactionRepository = {
      create: jest.fn((entity) => entity),
      save: jest.fn(),
      delete: jest.fn(),
    };
    transactionQueriesService = {
      getBalances: jest.fn(async (ids: number[]) => new Map(ids.map((id) => [id, 0]))),
      getForAllWallets: jest.fn(),
      getLatest: jest.fn(),
      getOneWithWallet: jest.fn(),
    };
    walletsService = { getOne: jest.fn().mockResolvedValue({ id: 1, space_id: spaceId, is_deleted: 0 }) };
    categoriesService = { getOne: jest.fn().mockResolvedValue({ id: 5, space_id: spaceId, is_system: 0 }) };
    spaceAccessService = { assertMembership: jest.fn().mockResolvedValue({}) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TransactionsService,
        { provide: getRepositoryToken(Transaction), useValue: transactionRepository },
        { provide: TransactionQueriesService, useValue: transactionQueriesService },
        { provide: WalletsService, useValue: walletsService },
        { provide: CategoriesService, useValue: categoriesService },
        { provide: SpaceAccessService, useValue: spaceAccessService },
      ],
    }).compile();

    service = module.get(TransactionsService);
  });

  const forbidden = () => new HttpException(ErrorMessages.FORBIDDEN_SPACE, 403);

  describe('create', () => {
    const dto = (overrides = {}) =>
      ({
        wallet_id: 1,
        category_id: 5,
        amount: '10',
        transaction_type: TransactionType.INCOME,
        timestamp: '2026-01-15T10:00:00.000Z',
        ...overrides,
      }) as any;

    it('rejects a non-member before loading anything', async () => {
      spaceAccessService.assertMembership.mockRejectedValue(forbidden());

      await expect(service.create(userId, spaceId, dto())).rejects.toMatchObject(forbidden());
      expect(walletsService.getOne).not.toHaveBeenCalled();
      expect(categoriesService.getOne).not.toHaveBeenCalled();
      expect(transactionRepository.save).not.toHaveBeenCalled();
    });

    it.each([
      ['does not exist', null],
      ['belongs to a different space', { id: 1, space_id: 20 }],
      ['was soft-deleted', { id: 1, space_id: spaceId, is_deleted: 1 }],
    ])('rejects when the wallet %s, before loading the category', async (_, wallet) => {
      walletsService.getOne.mockResolvedValue(wallet);

      await expect(service.create(userId, spaceId, dto())).rejects.toMatchObject(
        new HttpException(ErrorMessages.FORBIDDEN_WALLET, 403),
      );
      expect(categoriesService.getOne).not.toHaveBeenCalled();
      expect(transactionRepository.save).not.toHaveBeenCalled();
    });

    it.each([
      ['does not exist', null],
      ['belongs to a different space', { id: 5, space_id: 20 }],
      ['is a system category', { id: 5, space_id: spaceId, is_system: 1 }],
    ])('rejects when the category %s', async (_, category) => {
      categoriesService.getOne.mockResolvedValue(category);

      await expect(service.create(userId, spaceId, dto())).rejects.toMatchObject(
        new HttpException(ErrorMessages.FORBIDDEN_CATEGORY, 403),
      );
      expect(transactionRepository.save).not.toHaveBeenCalled();
    });

    it('creates the transaction and derives the wallet balance from its previous history', async () => {
      const wallet = { id: 1, space_id: spaceId, is_deleted: 0 };
      walletsService.getOne.mockResolvedValue(wallet);
      transactionQueriesService.getBalances.mockResolvedValue(new Map([[1, 100]]));
      const input = dto({ description: 'Lunch' });
      const entity = {
        wallet_id: 1,
        category_id: 5,
        transaction_type: TransactionType.INCOME,
        amount: '10',
        timestamp: new Date('2026-01-15T10:00:00.000Z'),
        description: 'Lunch',
      };
      transactionRepository.save.mockResolvedValue({ ...entity, id: 'tx-1' });

      const result = await service.create(userId, spaceId, input);

      expect(spaceAccessService.assertMembership).toHaveBeenCalledTimes(1);
      expect(spaceAccessService.assertMembership).toHaveBeenCalledWith(spaceId, userId);
      expect(walletsService.getOne).toHaveBeenCalledWith(1);
      expect(categoriesService.getOne).toHaveBeenCalledWith(5);
      expect(transactionRepository.create).toHaveBeenCalledWith(entity);
      expect(transactionRepository.save).toHaveBeenCalledWith(entity);
      expect(result).toEqual({
        transaction: { ...entity, id: 'tx-1' },
        wallet: { ...wallet, balance: 110 },
        previous_balance: 100,
      });
      expect(result.wallet).toBe(wallet);
      expect(transactionQueriesService.getBalances).toHaveBeenCalledWith([1]);
    });

    it('subtracts the amount for an expense transaction', async () => {
      transactionQueriesService.getBalances.mockResolvedValue(new Map([[1, 100]]));
      const input = dto({ amount: '30', transaction_type: TransactionType.EXPENSE });
      transactionRepository.save.mockResolvedValue(input);

      const result = await service.create(userId, spaceId, input);

      expect(result.previous_balance).toBe(100);
      expect(result.wallet.balance).toBe(70);
    });

    it('starts from a balance of 0 when the wallet has no transactions yet', async () => {
      const input = dto({ amount: '50' });
      transactionRepository.save.mockResolvedValue(input);

      const result = await service.create(userId, spaceId, input);

      expect(result.previous_balance).toBe(0);
      expect(result.wallet.balance).toBe(50);
    });

    it('stores an absent description as null and converts a date-only timestamp to local midnight', async () => {
      await service.create(userId, spaceId, dto({ timestamp: '2026-01-15' }));

      expect(transactionRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({ description: null, timestamp: new Date(2026, 0, 15) }),
      );
    });
  });

  describe('getAll', () => {
    const from = new Date(2026, 0, 1);
    const to = new Date(2026, 0, 31);

    it('rejects a non-member before querying', async () => {
      spaceAccessService.assertMembership.mockRejectedValue(forbidden());

      await expect(service.getAll(userId, spaceId, from, to)).rejects.toMatchObject(forbidden());
      expect(transactionQueriesService.getForAllWallets).not.toHaveBeenCalled();
    });

    it('nulls out the wallet on transactions whose wallet was soft-deleted', async () => {
      transactionQueriesService.getForAllWallets.mockResolvedValue([
        { id: 1, wallet: { id: 1, is_deleted: 0 } },
        { id: 2, wallet: { id: 2, is_deleted: 1 } },
      ]);

      const result = await service.getAll(userId, spaceId, from, to);

      expect(spaceAccessService.assertMembership).toHaveBeenCalledTimes(1);
      expect(spaceAccessService.assertMembership).toHaveBeenCalledWith(spaceId, userId);
      expect(transactionQueriesService.getForAllWallets).toHaveBeenCalledWith(spaceId, from, to);
      expect(result[0].wallet).toEqual({ id: 1, is_deleted: 0 });
      expect(result[1].wallet).toBeNull();
    });
  });

  describe('getLatest', () => {
    it('rejects a non-member before querying', async () => {
      spaceAccessService.assertMembership.mockRejectedValue(forbidden());

      await expect(service.getLatest(userId, spaceId)).rejects.toMatchObject(forbidden());
      expect(transactionQueriesService.getLatest).not.toHaveBeenCalled();
    });

    it('returns null when the space has no transactions', async () => {
      transactionQueriesService.getLatest.mockResolvedValue(null);

      const result = await service.getLatest(userId, spaceId);

      expect(spaceAccessService.assertMembership).toHaveBeenCalledTimes(1);
      expect(transactionQueriesService.getLatest).toHaveBeenCalledWith(spaceId);
      expect(result).toBeNull();
    });

    it('nulls out the wallet when it was soft-deleted', async () => {
      transactionQueriesService.getLatest.mockResolvedValue({ id: 1, wallet: { id: 1, is_deleted: 1 } });

      const result = await service.getLatest(userId, spaceId);

      expect(result.wallet).toBeNull();
    });

    it('keeps the wallet when it is active', async () => {
      transactionQueriesService.getLatest.mockResolvedValue({ id: 1, wallet: { id: 1, is_deleted: 0 } });

      const result = await service.getLatest(userId, spaceId);

      expect(result.wallet).toEqual({ id: 1, is_deleted: 0 });
    });
  });

  describe('remove', () => {
    it('rejects a non-member before loading the transaction', async () => {
      spaceAccessService.assertMembership.mockRejectedValue(forbidden());

      await expect(service.remove(userId, spaceId, 'tx-1')).rejects.toMatchObject(forbidden());
      expect(transactionQueriesService.getOneWithWallet).not.toHaveBeenCalled();
      expect(transactionRepository.delete).not.toHaveBeenCalled();
    });

    it.each([
      ['does not exist', null],
      ['belongs to a different space', { id: 'tx-1', wallet: { id: 1, space_id: 20 } }],
    ])('rejects when the transaction %s', async (_, transaction) => {
      transactionQueriesService.getOneWithWallet.mockResolvedValue(transaction);

      await expect(service.remove(userId, spaceId, 'tx-1')).rejects.toMatchObject(
        new HttpException(ErrorMessages.FORBIDDEN_WALLET, 403),
      );
      expect(transactionRepository.delete).not.toHaveBeenCalled();
    });

    it('deletes the transaction when its wallet belongs to the space', async () => {
      transactionQueriesService.getOneWithWallet.mockResolvedValue({
        id: 'tx-1',
        wallet: { id: 1, space_id: spaceId },
      });

      await service.remove(userId, spaceId, 'tx-1');

      expect(spaceAccessService.assertMembership).toHaveBeenCalledTimes(1);
      expect(transactionQueriesService.getOneWithWallet).toHaveBeenCalledWith('tx-1');
      expect(transactionRepository.delete).toHaveBeenCalledWith('tx-1');
    });
  });
});
