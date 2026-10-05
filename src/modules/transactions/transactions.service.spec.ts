import { Test, TestingModule } from '@nestjs/testing';
import { HttpException } from '@nestjs/common';
import { DataSource, type EntityManager, type Repository } from 'typeorm';

import { TransactionsService } from './transactions.service';
import type { CreateTransactionDto } from './dto/create-transaction.dto';
import { toTransactionView } from './transaction-view';
import { Transaction } from '@entities/transaction.entity';
import { Category } from '@entities/category.entity';
import { Wallet } from '@entities/wallet.entity';
import { TransactionType } from '@shared/enums';
import { ErrorMessages } from '@shared/error-messages';
import { withRelations } from '@shared/utils';
import { TransactionQueriesService } from '@modules/transaction-queries/transaction-queries.service';
import { WalletsService } from '@modules/wallets/wallets.service';
import { CategoriesService } from '@modules/categories/categories.service';
import { SpaceAccessService } from '@modules/space-access/space-access.service';
import { IdempotencyService } from '@modules/idempotency/idempotency.service';
import { buildCategory, buildSpaceMember, buildTransaction, buildWallet } from '@testing';

describe('TransactionsService', () => {
  let service: TransactionsService;
  let transactionRepository: jest.Mocked<Pick<Repository<Transaction>, 'create' | 'save' | 'delete'>>;
  let transactionQueriesService: jest.Mocked<
    Pick<TransactionQueriesService, 'getBalances' | 'getForAllWallets' | 'getLatest' | 'getOneInSpace'>
  >;
  let walletsService: jest.Mocked<Pick<WalletsService, 'getOne'>>;
  let categoriesService: jest.Mocked<Pick<CategoriesService, 'getOne'>>;
  let spaceAccessService: jest.Mocked<Pick<SpaceAccessService, 'assertMembership' | 'lockMembership' | 'lockSpace'>>;
  let idempotencyService: { run: jest.Mock; purgeExpired: jest.Mock };
  let manager: EntityManager;
  let lockedRows: Map<unknown, unknown[]>;
  let updateQuery: Record<'update' | 'set' | 'where' | 'execute', jest.Mock>;

  const userId = 1;
  const spaceId = 10;

  const loadedTransaction = (id: string, wallet: Partial<Wallet>) =>
    withRelations(
      buildTransaction({ id, wallet: buildWallet({ space_id: spaceId, ...wallet }), category: buildCategory() }),
      'wallet',
      'category',
    );

  beforeEach(async () => {
    transactionRepository = {
      create: jest.fn().mockImplementation((entityLike) => Object.assign(new Transaction(), entityLike)),
      save: jest.fn(async (entity) => Object.assign(new Transaction(), entity, { id: 'tx-new' })) as never,
      delete: jest.fn(),
    };
    transactionQueriesService = {
      getBalances: jest.fn(async (ids: number[]) => new Map(ids.map((id) => [id, 0n]))),
      getForAllWallets: jest.fn(),
      getLatest: jest.fn(),
      getOneInSpace: jest.fn(),
    };
    walletsService = { getOne: jest.fn().mockResolvedValue(buildWallet({ id: 1, space_id: spaceId })) };
    categoriesService = {
      getOne: jest
        .fn()
        .mockResolvedValue(buildCategory({ id: 5, space_id: spaceId, transaction_type: TransactionType.INCOME })),
    };
    const member = buildSpaceMember({ space_id: spaceId, user_id: userId });
    spaceAccessService = {
      assertMembership: jest.fn().mockResolvedValue(member),
      lockMembership: jest.fn().mockResolvedValue(member),
      lockSpace: jest.fn(),
    };
    lockedRows = new Map<unknown, unknown[]>([
      [Wallet, [buildWallet({ id: 1, space_id: spaceId })]],
      [Category, [buildCategory({ id: 5, space_id: spaceId, transaction_type: TransactionType.INCOME })]],
    ]);
    updateQuery = {
      update: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      execute: jest.fn(),
    };
    manager = {
      createQueryBuilder: jest.fn((entity?: unknown) =>
        entity === undefined
          ? updateQuery
          : {
              setLock: jest.fn().mockReturnThis(),
              whereInIds: jest.fn().mockReturnThis(),
              orderBy: jest.fn().mockReturnThis(),
              getMany: jest.fn(async () => lockedRows.get(entity) ?? []),
            },
      ),
      getRepository: jest.fn(() => transactionRepository),
    } as unknown as EntityManager;
    idempotencyService = {
      run: jest.fn((_manager, _request, work) => work()),
      purgeExpired: jest.fn(),
    };
    const dataSource = {
      transaction: jest.fn((_level: string, work: (m: EntityManager) => Promise<unknown>) => work(manager)),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TransactionsService,
        { provide: TransactionQueriesService, useValue: transactionQueriesService },
        { provide: WalletsService, useValue: walletsService },
        { provide: CategoriesService, useValue: categoriesService },
        { provide: SpaceAccessService, useValue: spaceAccessService },
        { provide: DataSource, useValue: dataSource },
        { provide: IdempotencyService, useValue: idempotencyService },
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
    const created = loadedTransaction('tx-new', { id: 1 });

    beforeEach(() => {
      transactionQueriesService.getOneInSpace.mockResolvedValue(created);
    });

    it('rejects a non-member before loading anything', async () => {
      spaceAccessService.lockMembership.mockRejectedValue(forbidden());

      await expect(service.create(userId, spaceId, dto())).rejects.toMatchObject(forbidden());
      expect(manager.createQueryBuilder).not.toHaveBeenCalled();
      expect(transactionRepository.save).not.toHaveBeenCalled();
    });

    it('locks the membership, the space shared, the wallet and the category, in that order', async () => {
      const order: string[] = [];
      spaceAccessService.lockMembership.mockImplementation(async () => {
        order.push('member');
        return buildSpaceMember();
      });
      spaceAccessService.lockSpace.mockImplementation(async () => {
        order.push('space');
      });
      jest.mocked(manager.createQueryBuilder).mockImplementation(((entity: unknown) => {
        order.push(entity === Wallet ? 'wallet' : 'category');
        return {
          setLock: (mode: string) => {
            order.push(mode);
            return { whereInIds: () => ({ orderBy: () => ({ getMany: async () => lockedRows.get(entity) }) }) };
          },
        };
      }) as unknown as EntityManager['createQueryBuilder']);

      await service.create(userId, spaceId, dto());

      expect(order).toEqual(['member', 'space', 'wallet', 'pessimistic_write', 'category', 'pessimistic_read']);
      expect(spaceAccessService.lockMembership).toHaveBeenCalledWith(spaceId, userId, manager);
      expect(spaceAccessService.lockSpace).toHaveBeenCalledWith(spaceId, manager, 'shared');
    });

    it.each<[string, Wallet[], string, number]>([
      ['does not exist', [], ErrorMessages.FORBIDDEN_WALLET, 403],
      ['belongs to a different space', [buildWallet({ id: 1, space_id: 20 })], ErrorMessages.FORBIDDEN_WALLET, 403],
      [
        'was deleted',
        [buildWallet({ id: 1, space_id: spaceId, is_deleted: 1, deleted_at: new Date() })],
        ErrorMessages.WALLET_DELETED,
        400,
      ],
    ])('rejects when the wallet %s, before loading the category', async (_, wallets, message, status) => {
      lockedRows.set(Wallet, wallets);

      await expect(service.create(userId, spaceId, dto())).rejects.toMatchObject(new HttpException(message, status));
      expect(manager.createQueryBuilder).not.toHaveBeenCalledWith(Category, 'row');
      expect(transactionRepository.save).not.toHaveBeenCalled();
    });

    it.each<[string, Category[], string, number]>([
      ['does not exist', [], ErrorMessages.FORBIDDEN_CATEGORY, 403],
      ['belongs to a different space', [buildCategory({ id: 5, space_id: 20 })], ErrorMessages.FORBIDDEN_CATEGORY, 403],
      [
        'is the system category',
        [buildCategory({ id: 5, space_id: spaceId, is_system: 1 })],
        ErrorMessages.FORBIDDEN_CATEGORY,
        403,
      ],
      [
        'is archived',
        [buildCategory({ id: 5, space_id: spaceId, is_active: 0, transaction_type: TransactionType.INCOME })],
        ErrorMessages.CATEGORY_ARCHIVED,
        400,
      ],
      [
        'has the other type',
        [buildCategory({ id: 5, space_id: spaceId, transaction_type: TransactionType.EXPENSE })],
        ErrorMessages.CATEGORY_TYPE_MISMATCH,
        400,
      ],
    ])('rejects when the category %s', async (_, categories, message, status) => {
      lockedRows.set(Category, categories);

      await expect(service.create(userId, spaceId, dto())).rejects.toMatchObject(new HttpException(message, status));
      expect(transactionRepository.save).not.toHaveBeenCalled();
    });

    it('saves the transaction and returns it as the read view', async () => {
      await service.create(userId, spaceId, dto({ description: 'Lunch' }));

      expect(transactionRepository.create).toHaveBeenCalledWith({
        wallet_id: 1,
        category_id: 5,
        transaction_type: TransactionType.INCOME,
        amount: '10',
        timestamp: new Date('2026-01-15T10:00:00.000Z'),
        description: 'Lunch',
      });
      expect(transactionQueriesService.getOneInSpace).toHaveBeenCalledWith(spaceId, 'tx-new', manager);
    });

    it('returns the view of the stored record, not the request echo', async () => {
      const result = await service.create(userId, spaceId, dto());

      expect(result.transaction).toEqual(toTransactionView(created));
    });

    it('reads both balances from history, before and after the insert', async () => {
      const wallet = buildWallet({ id: 1, space_id: spaceId });
      lockedRows.set(Wallet, [wallet]);
      transactionQueriesService.getBalances
        .mockImplementationOnce(async () => {
          expect(transactionRepository.save).not.toHaveBeenCalled();
          return new Map([[1, 10000n]]);
        })
        .mockImplementationOnce(async () => {
          expect(transactionRepository.save).toHaveBeenCalled();
          // a concurrent write cannot happen under the wallet lock; this only
          // shows that the after-balance is read, not computed
          return new Map([[1, 10777n]]);
        });

      const result = await service.create(userId, spaceId, dto());

      expect(result.previous_balance).toBe(100);
      expect(result.wallet).toBe(wallet);
      expect(result.wallet.balance).toBe(107.77);
      expect(transactionQueriesService.getBalances).toHaveBeenCalledWith([1], manager);
    });

    it('fails, so the transaction rolls back, when a balance cannot be returned to the cent', async () => {
      transactionQueriesService.getBalances.mockResolvedValue(new Map([[1, 9007199254740993n]]));

      await expect(service.create(userId, spaceId, dto())).rejects.toThrow(RangeError);
    });

    it('stores a blank description as null and converts a date-only timestamp to local midnight', async () => {
      await service.create(userId, spaceId, dto({ timestamp: '2026-01-15', description: '   ' }));

      expect(transactionRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({ description: null, timestamp: new Date(2026, 0, 15) }),
      );
    });
  });

  describe('idempotency', () => {
    const dto: CreateTransactionDto = {
      wallet_id: 1,
      category_id: 5,
      amount: '10',
      transaction_type: TransactionType.INCOME,
      timestamp: '2026-01-15T10:00:00.000Z',
    };

    beforeEach(() => {
      transactionQueriesService.getOneInSpace.mockResolvedValue(loadedTransaction('tx-new', { id: 1 }));
    });

    it('writes without a key, outside the idempotency store', async () => {
      await service.create(userId, spaceId, dto);

      expect(idempotencyService.run).not.toHaveBeenCalled();
      expect(idempotencyService.purgeExpired).not.toHaveBeenCalled();
    });

    it('runs a keyed create through the store, after the access locks', async () => {
      spaceAccessService.lockSpace.mockImplementation(async () => {
        expect(idempotencyService.run).not.toHaveBeenCalled();
      });

      await service.create(userId, spaceId, dto, { idempotencyKey: 'key-1' });

      expect(idempotencyService.run).toHaveBeenCalledWith(
        manager,
        { operation: 'transactions.create', key: 'key-1', payload: dto, userId, spaceId },
        expect.any(Function),
      );
      expect(idempotencyService.purgeExpired).toHaveBeenCalled();
    });

    it('returns a stored result without writing again', async () => {
      const stored = { transaction: { id: 'tx-1' } };
      idempotencyService.run.mockResolvedValue(stored);

      await expect(service.create(userId, spaceId, dto, { idempotencyKey: 'key-1' })).resolves.toBe(stored);
      expect(transactionRepository.save).not.toHaveBeenCalled();
    });

    it('keys a delete by the transaction and the expected version', async () => {
      const transaction = loadedTransaction('tx-1', { id: 1 });
      lockedRows.set(Transaction, [transaction]);
      transactionQueriesService.getOneInSpace.mockResolvedValue(transaction);

      await service.remove(userId, spaceId, 'tx-1', { idempotencyKey: 'key-2' });

      expect(idempotencyService.run).toHaveBeenCalledWith(
        manager,
        {
          operation: 'transactions.delete',
          key: 'key-2',
          payload: { transactionId: 'tx-1', expectedVersion: null },
          userId,
          spaceId,
        },
        expect.any(Function),
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
      const deleted = loadedTransaction('2', { id: 2, is_deleted: 1, deleted_at: new Date() });
      transactionQueriesService.getForAllWallets.mockResolvedValue([active, deleted]);

      const result = await service.getAll(userId, spaceId, from, to);

      expect(spaceAccessService.assertMembership).toHaveBeenCalledTimes(1);
      expect(spaceAccessService.assertMembership).toHaveBeenCalledWith(spaceId, userId);
      expect(transactionQueriesService.getForAllWallets).toHaveBeenCalledWith(spaceId, from, to, {});
      expect(walletsService.getOne).not.toHaveBeenCalled();
      expect(categoriesService.getOne).not.toHaveBeenCalled();
      expect(result).toEqual([toTransactionView(active), toTransactionView(deleted)]);
      expect(result[0].wallet).toEqual(expect.objectContaining({ id: 1 }));
      expect(result[1].wallet).toBeNull();
    });

    it('filters by an archived category of the space and by an active wallet', async () => {
      categoriesService.getOne.mockResolvedValue(
        buildCategory({ id: 5, space_id: spaceId, is_active: 0, archived_at: new Date() }),
      );
      transactionQueriesService.getForAllWallets.mockResolvedValue([]);
      const filters = { transactionType: TransactionType.EXPENSE, categoryId: 5, walletId: 1 };

      await service.getAll(userId, spaceId, from, to, filters);

      expect(categoriesService.getOne).toHaveBeenCalledWith(5);
      expect(walletsService.getOne).toHaveBeenCalledWith(1);
      expect(transactionQueriesService.getForAllWallets).toHaveBeenCalledWith(spaceId, from, to, filters);
    });

    it.each([
      ['missing', null],
      ['of a different space', buildCategory({ id: 5, space_id: 20 })],
      ['the system one', buildCategory({ id: 5, space_id: spaceId, is_system: 1 })],
    ])('refuses a category filter that is %s', async (_, category) => {
      categoriesService.getOne.mockResolvedValue(category as Category | null);

      await expect(service.getAll(userId, spaceId, from, to, { categoryId: 5 })).rejects.toMatchObject({
        message: ErrorMessages.FORBIDDEN_CATEGORY,
        status: 403,
      });
      expect(transactionQueriesService.getForAllWallets).not.toHaveBeenCalled();
    });

    it.each([
      ['missing', null],
      ['of a different space', buildWallet({ id: 1, space_id: 20 })],
      ['soft-deleted', buildWallet({ id: 1, space_id: spaceId, is_deleted: 1, deleted_at: new Date() })],
    ])('refuses a wallet filter that is %s', async (_, wallet) => {
      walletsService.getOne.mockResolvedValue(wallet as Wallet | null);

      await expect(service.getAll(userId, spaceId, from, to, { walletId: 1 })).rejects.toMatchObject({
        message: ErrorMessages.FORBIDDEN_WALLET,
        status: 403,
      });
      expect(transactionQueriesService.getForAllWallets).not.toHaveBeenCalled();
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
      transactionQueriesService.getLatest.mockResolvedValue(latest);

      const result = await service.getLatest(userId, spaceId);

      expect(result).toEqual(toTransactionView(latest));
      expect(result?.wallet).toEqual(expect.objectContaining({ id: 1 }));
    });
  });

  describe('getById', () => {
    it('rejects a non-member before loading the transaction', async () => {
      spaceAccessService.assertMembership.mockRejectedValue(forbidden());

      await expect(service.getById(userId, spaceId, 'tx-1')).rejects.toMatchObject(forbidden());
      expect(transactionQueriesService.getOneInSpace).not.toHaveBeenCalled();
    });

    it('reports a transaction outside the space as not found', async () => {
      transactionQueriesService.getOneInSpace.mockResolvedValue(null);

      await expect(service.getById(userId, spaceId, 'tx-1')).rejects.toMatchObject({
        status: 404,
        response: { code: 'TRANSACTION_NOT_FOUND', message: ErrorMessages.TRANSACTION_NOT_FOUND },
      });
      expect(transactionQueriesService.getOneInSpace).toHaveBeenCalledWith(spaceId, 'tx-1');
    });

    it('returns the view of a transaction on a soft-deleted wallet', async () => {
      const transaction = loadedTransaction('tx-1', { id: 1, is_deleted: 1, deleted_at: new Date() });
      transactionQueriesService.getOneInSpace.mockResolvedValue(transaction);

      const result = await service.getById(userId, spaceId, 'tx-1');

      expect(spaceAccessService.assertMembership).toHaveBeenCalledTimes(1);
      expect(result).toEqual(toTransactionView(transaction));
      expect(result.wallet).toBeNull();
    });
  });

  describe('remove', () => {
    const lockedTransaction = (overrides: Partial<Transaction> = {}) => {
      const transaction = Object.assign(loadedTransaction('tx-1', { id: 1 }), overrides);
      lockedRows.set(Transaction, [transaction]);
      transactionQueriesService.getOneInSpace.mockResolvedValue(transaction);
      return transaction;
    };

    it('rejects a non-member before loading the transaction', async () => {
      spaceAccessService.lockMembership.mockRejectedValue(forbidden());

      await expect(service.remove(userId, spaceId, 'tx-1')).rejects.toMatchObject(forbidden());
      expect(manager.createQueryBuilder).not.toHaveBeenCalled();
      expect(transactionRepository.delete).not.toHaveBeenCalled();
    });

    it('locks the transaction row, then reads it in the space, then locks its wallet', async () => {
      lockedTransaction();

      await service.remove(userId, spaceId, 'tx-1');

      expect(jest.mocked(manager.createQueryBuilder).mock.calls.map(([entity]) => entity)).toEqual([
        Transaction,
        Wallet,
      ]);
      expect(transactionQueriesService.getOneInSpace).toHaveBeenCalledWith(spaceId, 'tx-1', manager);
      expect(spaceAccessService.lockSpace).toHaveBeenCalledWith(spaceId, manager, 'shared');
    });

    it('is not found when no row could be locked', async () => {
      await expect(service.remove(userId, spaceId, 'tx-1')).rejects.toMatchObject(
        new HttpException(ErrorMessages.TRANSACTION_NOT_FOUND, 404),
      );
      expect(transactionQueriesService.getOneInSpace).not.toHaveBeenCalled();
    });

    it('is not found when the transaction belongs to another space', async () => {
      lockedTransaction();
      transactionQueriesService.getOneInSpace.mockResolvedValue(null);

      await expect(service.remove(userId, spaceId, 'tx-1')).rejects.toMatchObject(
        new HttpException(ErrorMessages.TRANSACTION_NOT_FOUND, 404),
      );
      expect(transactionRepository.delete).not.toHaveBeenCalled();
    });

    it('refuses the initial balance, even with the right version', async () => {
      lockedTransaction({ category: buildCategory({ is_system: 1 }) });

      await expect(service.remove(userId, spaceId, 'tx-1', { expectedVersion: 1 })).rejects.toMatchObject(
        new HttpException(ErrorMessages.TRANSACTION_IS_SYSTEM, 400),
      );
      expect(transactionRepository.delete).not.toHaveBeenCalled();
    });

    it('refuses a stale version', async () => {
      lockedTransaction({ version: 3 });

      await expect(service.remove(userId, spaceId, 'tx-1', { expectedVersion: 2 })).rejects.toMatchObject(
        new HttpException(ErrorMessages.TRANSACTION_VERSION_CONFLICT, 409),
      );
      expect(transactionRepository.delete).not.toHaveBeenCalled();
    });

    it.each([
      ['the matching version', 3],
      ['no version', undefined],
    ])('deletes with %s', async (_, version) => {
      lockedTransaction({ version: 3 });

      await service.remove(userId, spaceId, 'tx-1', { expectedVersion: version });

      expect(transactionRepository.delete).toHaveBeenCalledWith('tx-1');
    });
  });
});
