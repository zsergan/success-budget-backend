import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { HttpException } from '@nestjs/common';
import type { Repository } from 'typeorm';

import { TransactionsService } from './transactions.service';
import type { CreateTransactionDto } from './dto/create-transaction.dto';
import { Transaction } from '@entities/transaction.entity';
import type { Category } from '@entities/category.entity';
import type { Wallet } from '@entities/wallet.entity';
import { TransactionType } from '@shared/enums';
import { ErrorMessages } from '@shared/error-messages';
import { withRelations } from '@shared/utils';
import { TransactionQueriesService } from '@modules/transaction-queries/transaction-queries.service';
import { WalletsService } from '@modules/wallets/wallets.service';
import { CategoriesService } from '@modules/categories/categories.service';
import { SpaceAccessService } from '@modules/space-access/space-access.service';
import { buildCategory, buildSpaceMember, buildTransaction, buildWallet } from '@testing';

describe('TransactionsService', () => {
  let service: TransactionsService;
  let transactionRepository: jest.Mocked<Pick<Repository<Transaction>, 'create' | 'save' | 'delete'>>;
  let transactionQueriesService: jest.Mocked<
    Pick<TransactionQueriesService, 'getBalances' | 'getForAllWallets' | 'getLatest' | 'getOneWithWallet'>
  >;
  let walletsService: jest.Mocked<Pick<WalletsService, 'getOne'>>;
  let categoriesService: jest.Mocked<Pick<CategoriesService, 'getOne'>>;
  let spaceAccessService: jest.Mocked<Pick<SpaceAccessService, 'assertMembership'>>;

  const userId = 1;
  const spaceId = 10;

  const loadedTransaction = (id: string, wallet: Partial<Wallet>) =>
    withRelations(
      buildTransaction({ id, wallet: buildWallet({ space_id: spaceId, ...wallet }), category: buildCategory() }),
      'wallet',
      'category',
    );
  const withWallet = (id: string, wallet: Partial<Wallet>) =>
    withRelations(buildTransaction({ id, wallet: buildWallet(wallet) }), 'wallet');

  beforeEach(async () => {
    transactionRepository = {
      create: jest.fn().mockImplementation((entityLike) => Object.assign(new Transaction(), entityLike)),
      save: jest.fn(),
      delete: jest.fn(),
    };
    transactionQueriesService = {
      getBalances: jest.fn(async (ids: number[]) => new Map(ids.map((id) => [id, 0n]))),
      getForAllWallets: jest.fn(),
      getLatest: jest.fn(),
      getOneWithWallet: jest.fn(),
    };
    walletsService = { getOne: jest.fn().mockResolvedValue(buildWallet({ id: 1, space_id: spaceId })) };
    categoriesService = {
      getOne: jest
        .fn()
        .mockResolvedValue(buildCategory({ id: 5, space_id: spaceId, transaction_type: TransactionType.INCOME })),
    };
    spaceAccessService = {
      assertMembership: jest.fn().mockResolvedValue(buildSpaceMember({ space_id: spaceId, user_id: userId })),
    };

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
    const dto = (overrides: Partial<CreateTransactionDto> = {}): CreateTransactionDto => ({
      wallet_id: 1,
      category_id: 5,
      amount: '10',
      transaction_type: TransactionType.INCOME,
      timestamp: '2026-01-15T10:00:00.000Z',
      ...overrides,
    });

    it('rejects a non-member before loading anything', async () => {
      spaceAccessService.assertMembership.mockRejectedValue(forbidden());

      await expect(service.create(userId, spaceId, dto())).rejects.toMatchObject(forbidden());
      expect(walletsService.getOne).not.toHaveBeenCalled();
      expect(categoriesService.getOne).not.toHaveBeenCalled();
      expect(transactionRepository.save).not.toHaveBeenCalled();
    });

    it.each<[string, Wallet | null]>([
      ['does not exist', null],
      ['belongs to a different space', buildWallet({ id: 1, space_id: 20 })],
      ['was soft-deleted', buildWallet({ id: 1, space_id: spaceId, is_deleted: 1, deleted_at: new Date() })],
    ])('rejects when the wallet %s, before loading the category', async (_, wallet) => {
      walletsService.getOne.mockResolvedValue(wallet);

      await expect(service.create(userId, spaceId, dto())).rejects.toMatchObject(
        new HttpException(ErrorMessages.FORBIDDEN_WALLET, 403),
      );
      expect(categoriesService.getOne).not.toHaveBeenCalled();
      expect(transactionRepository.save).not.toHaveBeenCalled();
    });

    it.each<[string, Category | null]>([
      ['does not exist', null],
      ['belongs to a different space', buildCategory({ id: 5, space_id: 20 })],
      ['is a system category', buildCategory({ id: 5, space_id: spaceId, is_system: 1 })],
    ])('rejects when the category %s', async (_, category) => {
      categoriesService.getOne.mockResolvedValue(category);

      await expect(service.create(userId, spaceId, dto())).rejects.toMatchObject(
        new HttpException(ErrorMessages.FORBIDDEN_CATEGORY, 403),
      );
      expect(transactionRepository.save).not.toHaveBeenCalled();
    });

    it('creates the transaction and derives the wallet balance from its previous history', async () => {
      const wallet = buildWallet({ id: 1, space_id: spaceId });
      walletsService.getOne.mockResolvedValue(wallet);
      transactionQueriesService.getBalances.mockResolvedValue(new Map([[1, 10000n]]));
      const input = dto({ description: 'Lunch' });
      const entity = {
        wallet_id: 1,
        category_id: 5,
        transaction_type: TransactionType.INCOME,
        amount: '10',
        timestamp: new Date('2026-01-15T10:00:00.000Z'),
        description: 'Lunch',
      };
      const saved = buildTransaction({ ...entity, id: 'tx-1' });
      transactionRepository.save.mockResolvedValue(saved);

      const result = await service.create(userId, spaceId, input);

      expect(spaceAccessService.assertMembership).toHaveBeenCalledTimes(1);
      expect(spaceAccessService.assertMembership).toHaveBeenCalledWith(spaceId, userId);
      expect(walletsService.getOne).toHaveBeenCalledWith(1);
      expect(categoriesService.getOne).toHaveBeenCalledWith(5);
      expect(transactionRepository.create).toHaveBeenCalledWith(entity);
      expect(transactionRepository.save).toHaveBeenCalledWith(entity);
      expect(result).toEqual({ transaction: saved, wallet: { ...wallet, balance: 110 }, previous_balance: 100 });
      expect(result.wallet).toBe(wallet);
      expect(transactionQueriesService.getBalances).toHaveBeenCalledWith([1]);
    });

    it('subtracts the amount for an expense transaction', async () => {
      transactionQueriesService.getBalances.mockResolvedValue(new Map([[1, 10000n]]));
      const input = dto({ amount: '30', transaction_type: TransactionType.EXPENSE });
      transactionRepository.save.mockResolvedValue(
        buildTransaction({ amount: '30', transaction_type: TransactionType.EXPENSE }),
      );

      const result = await service.create(userId, spaceId, input);

      expect(result.previous_balance).toBe(100);
      expect(result.wallet.balance).toBe(70);
    });

    it.each([
      [TransactionType.INCOME, '0.2', 0.3],
      [TransactionType.EXPENSE, '0.3', -0.2],
    ])('adds a %s of %p to a 0.10 balance without float error', async (transaction_type, amount, balance) => {
      transactionQueriesService.getBalances.mockResolvedValue(new Map([[1, 10n]]));
      transactionRepository.save.mockResolvedValue(buildTransaction({ amount, transaction_type }));

      const result = await service.create(userId, spaceId, dto({ amount, transaction_type }));

      expect(result.previous_balance).toBe(0.1);
      expect(result.wallet.balance).toBe(balance);
    });

    it('starts from a balance of 0 when the wallet has no transactions yet', async () => {
      const input = dto({ amount: '50' });
      transactionRepository.save.mockResolvedValue(buildTransaction({ amount: '50' }));

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
      const active = loadedTransaction('1', { id: 1 });
      const activeWallet = active.wallet;
      const deleted = loadedTransaction('2', { id: 2, is_deleted: 1, deleted_at: new Date() });
      transactionQueriesService.getForAllWallets.mockResolvedValue([active, deleted]);

      const result = await service.getAll(userId, spaceId, from, to);

      expect(spaceAccessService.assertMembership).toHaveBeenCalledTimes(1);
      expect(spaceAccessService.assertMembership).toHaveBeenCalledWith(spaceId, userId);
      expect(transactionQueriesService.getForAllWallets).toHaveBeenCalledWith(spaceId, from, to);
      expect(result[0].wallet).toBe(activeWallet);
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
      transactionQueriesService.getLatest.mockResolvedValue(
        loadedTransaction('1', { id: 1, is_deleted: 1, deleted_at: new Date() }),
      );

      const result = await service.getLatest(userId, spaceId);

      expect(result?.wallet).toBeNull();
    });

    it('keeps the wallet when it is active', async () => {
      const latest = loadedTransaction('1', { id: 1 });
      const wallet = latest.wallet;
      transactionQueriesService.getLatest.mockResolvedValue(latest);

      const result = await service.getLatest(userId, spaceId);

      expect(result?.wallet).toBe(wallet);
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
      ['belongs to a different space', withWallet('tx-1', { space_id: 20 })],
    ])('rejects when the transaction %s', async (_, transaction) => {
      transactionQueriesService.getOneWithWallet.mockResolvedValue(transaction);

      await expect(service.remove(userId, spaceId, 'tx-1')).rejects.toMatchObject(
        new HttpException(ErrorMessages.FORBIDDEN_WALLET, 403),
      );
      expect(transactionRepository.delete).not.toHaveBeenCalled();
    });

    it('deletes the transaction when its wallet belongs to the space', async () => {
      transactionQueriesService.getOneWithWallet.mockResolvedValue(withWallet('tx-1', { space_id: spaceId }));

      await service.remove(userId, spaceId, 'tx-1');

      expect(spaceAccessService.assertMembership).toHaveBeenCalledTimes(1);
      expect(transactionQueriesService.getOneWithWallet).toHaveBeenCalledWith('tx-1');
      expect(transactionRepository.delete).toHaveBeenCalledWith('tx-1');
    });
  });
});
