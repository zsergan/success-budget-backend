import { Test, TestingModule } from '@nestjs/testing';
import { HttpException } from '@nestjs/common';
import { DataSource, QueryFailedError, type EntityManager, type Repository } from 'typeorm';

import { TransactionsService } from './transactions.service';
import type { CreateTransactionDto } from './dto/create-transaction.dto';
import type { UpdateTransactionDto } from './dto/update-transaction.dto';
import { toTransactionView } from './transaction-view';
import { Transaction } from '@entities/transaction.entity';
import { TRANSACTION_OPERATION_SCOPE, TransactionOperation } from '@entities/transaction-operation.entity';
import { Category } from '@entities/category.entity';
import { Wallet } from '@entities/wallet.entity';
import { TransactionType } from '@shared/enums';
import { ErrorMessages } from '@shared/error-messages';
import { withRelations } from '@shared/utils';
import {
  TransactionQueriesService,
  type LoadedTransaction,
} from '@modules/transaction-queries/transaction-queries.service';
import { WalletsService } from '@modules/wallets/wallets.service';
import { CategoriesService } from '@modules/categories/categories.service';
import { SpaceAccessService } from '@modules/space-access/space-access.service';
import { IdempotencyService } from '@modules/idempotency/idempotency.service';
import { buildCategory, buildSpaceMember, buildTransaction, buildWallet } from '@testing';

describe('TransactionsService', () => {
  let service: TransactionsService;
  let transactionRepository: jest.Mocked<Pick<Repository<Transaction>, 'create' | 'save' | 'delete'>>;
  let transactionQueriesService: jest.Mocked<
    Pick<
      TransactionQueriesService,
      'getBalances' | 'getForAllWallets' | 'countForAllWallets' | 'getLatest' | 'getOneInSpace'
    >
  >;
  let walletsService: jest.Mocked<Pick<WalletsService, 'getOne'>>;
  let categoriesService: jest.Mocked<Pick<CategoriesService, 'getOne'>>;
  let spaceAccessService: jest.Mocked<Pick<SpaceAccessService, 'assertMembership' | 'lockMembership' | 'lockSpace'>>;
  let idempotencyService: { run: jest.Mock };
  let operationRepository: Record<'exists' | 'insert' | 'update' | 'findOne', jest.Mock>;
  let dataSource: { transaction: jest.Mock };
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
      countForAllWallets: jest.fn(),
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
      getRepository: jest.fn((entity: unknown) =>
        entity === TransactionOperation ? operationRepository : transactionRepository,
      ),
    } as unknown as EntityManager;
    operationRepository = {
      exists: jest.fn().mockResolvedValue(false),
      insert: jest.fn(),
      update: jest.fn(),
      findOne: jest.fn().mockResolvedValue(null),
    };
    idempotencyService = {
      run: jest.fn((_manager, _request, work) => work()),
    };
    dataSource = {
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

    describe('client_operation_id', () => {
      const operationId = '0F8E3B1C-5D2A-4E8F-9A61-2C7D4B5E6F70';
      const operationExists = new HttpException(ErrorMessages.TRANSACTION_OPERATION_EXISTS, 409);

      it('records the operation, lowercased, with the created transaction', async () => {
        await service.create(userId, spaceId, dto({ client_operation_id: operationId }));

        expect(operationRepository.exists).toHaveBeenCalledWith({
          where: { space_id: spaceId, operation_id: operationId.toLowerCase() },
        });
        expect(operationRepository.insert).toHaveBeenCalledWith({
          space_id: spaceId,
          operation_id: operationId.toLowerCase(),
          transaction_id: 'tx-new',
          created_at: expect.any(Date),
          deleted_at: null,
        });
      });

      it('records nothing without one', async () => {
        await service.create(userId, spaceId, dto());

        expect(operationRepository.exists).not.toHaveBeenCalled();
        expect(operationRepository.insert).not.toHaveBeenCalled();
      });

      it('refuses a used id before the wallet and category checks', async () => {
        operationRepository.exists.mockResolvedValue(true);
        lockedRows.set(Wallet, [buildWallet({ id: 1, space_id: spaceId, is_deleted: 1 })]);

        await expect(service.create(userId, spaceId, dto({ client_operation_id: operationId }))).rejects.toMatchObject(
          operationExists,
        );
        expect(manager.createQueryBuilder).not.toHaveBeenCalled();
        expect(transactionRepository.save).not.toHaveBeenCalled();
      });

      it('refuses an id a concurrent create recorded first', async () => {
        operationRepository.insert.mockRejectedValue(
          new QueryFailedError(
            'INSERT',
            [],
            Object.assign(new Error('Duplicate'), {
              code: 'ER_DUP_ENTRY',
              sqlMessage: `Duplicate entry for key 'transaction_operations.${TRANSACTION_OPERATION_SCOPE}'`,
            }),
          ),
        );

        await expect(service.create(userId, spaceId, dto({ client_operation_id: operationId }))).rejects.toMatchObject(
          operationExists,
        );
      });
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

    it('stores a blank description as null and the timestamp as the instant sent', async () => {
      await service.create(userId, spaceId, dto({ timestamp: '2026-01-15T03:00:00+03:00', description: '   ' }));

      expect(transactionRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({ description: null, timestamp: new Date('2026-01-15T00:00:00.000Z') }),
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

      await service.remove(userId, spaceId, 'tx-1', { expectedVersion: 1, idempotencyKey: 'key-2' });

      expect(idempotencyService.run).toHaveBeenCalledWith(
        manager,
        {
          operation: 'transactions.delete',
          key: 'key-2',
          payload: { transactionId: 'tx-1', expectedVersion: 1 },
          userId,
          spaceId,
        },
        expect.any(Function),
      );
    });
  });

  describe('update', () => {
    const expense = (overrides: Partial<Category> = {}) =>
      buildCategory({ id: 5, space_id: spaceId, transaction_type: TransactionType.EXPENSE, ...overrides });
    let original: LoadedTransaction;

    const stored = (overrides: Partial<Transaction> = {}) => {
      original = withRelations(
        buildTransaction({
          id: 'tx-1',
          wallet_id: 1,
          category_id: 5,
          transaction_type: TransactionType.EXPENSE,
          amount: '12.30',
          timestamp: new Date('2026-09-15T10:00:00.000Z'),
          description: 'Lunch',
          version: 3,
          wallet: buildWallet({ id: 1, space_id: spaceId }),
          category: expense(),
          ...overrides,
        }),
        'wallet',
        'category',
      );
      lockedRows.set(Transaction, [original]);
      lockedRows.set(Wallet, [original.wallet]);
      transactionQueriesService.getOneInSpace.mockResolvedValue(original);
    };

    const update = (body: UpdateTransactionDto, expectedVersion: number | null = 3) =>
      service.update(userId, spaceId, 'tx-1', body, { expectedVersion: expectedVersion ?? undefined });

    beforeEach(() => stored());

    it('requires the version the client read, before any access check', async () => {
      await expect(update({ amount: '1' }, null)).rejects.toMatchObject(
        new HttpException(ErrorMessages.TRANSACTION_VERSION_REQUIRED, 428),
      );
      expect(spaceAccessService.lockMembership).not.toHaveBeenCalled();
    });

    it('is not found when no row could be locked', async () => {
      lockedRows.set(Transaction, []);

      await expect(update({ amount: '1' })).rejects.toMatchObject(
        new HttpException(ErrorMessages.TRANSACTION_NOT_FOUND, 404),
      );
    });

    it('refuses the initial balance before the version', async () => {
      stored({ category: buildCategory({ is_system: 1 }) });

      await expect(update({ amount: '1' }, 99)).rejects.toMatchObject(
        new HttpException(ErrorMessages.TRANSACTION_IS_SYSTEM, 400),
      );
    });

    it('refuses a stale version', async () => {
      await expect(update({ amount: '1' }, 2)).rejects.toMatchObject(
        new HttpException(ErrorMessages.TRANSACTION_VERSION_CONFLICT, 409),
      );
      expect(updateQuery.execute).not.toHaveBeenCalled();
    });

    it('writes only the fields that change', async () => {
      await update({ amount: '20', description: '  Dinner ', transaction_type: TransactionType.EXPENSE });

      expect(updateQuery.set).toHaveBeenCalledWith({ amount: '20', description: 'Dinner' });
      expect(updateQuery.where).toHaveBeenCalledWith('id = :id', { id: 'tx-1' });
    });

    it.each<[string, UpdateTransactionDto]>([
      ['an empty body', {}],
      [
        'the current values in another spelling',
        {
          wallet_id: 1,
          category_id: 5,
          transaction_type: TransactionType.EXPENSE,
          amount: '12.3',
          timestamp: '2026-09-15T12:00:00.000+02:00',
          description: ' Lunch ',
        },
      ],
    ])('writes nothing and keeps the version for %s', async (_, body) => {
      const result = await update(body);

      expect(updateQuery.execute).not.toHaveBeenCalled();
      expect(result.transaction.version).toBe(3);
    });

    it('treats a cleared legacy blank description as unchanged', async () => {
      stored({ description: '' });

      await update({ description: null });

      expect(updateQuery.execute).not.toHaveBeenCalled();
    });

    it('clears the description with null', async () => {
      await update({ description: null });

      expect(updateQuery.set).toHaveBeenCalledWith({ description: null });
    });

    it.each<[string, UpdateTransactionDto, string]>([
      ['a zero amount', { amount: '0.00' }, 'amount must be greater than 0'],
      ['a future timestamp', { timestamp: '2999-01-01T00:00:00.000Z' }, 'timestamp must not be in the future'],
    ])('refuses %s as a new value', async (_, body, error) => {
      await expect(update(body)).rejects.toMatchObject({
        response: { message: [{ field: Object.keys(body)[0], error }] },
        status: 400,
      });
    });

    it('keeps a legacy zero amount and future timestamp when other fields change', async () => {
      stored({ amount: '0.00', timestamp: new Date('2999-01-01T00:00:00.000Z') });

      await update({ amount: '0', timestamp: '2999-01-01T00:00:00.000Z', description: 'x' });

      expect(updateQuery.set).toHaveBeenCalledWith({ description: 'x' });
    });

    it('keeps its own deleted wallet and archived category', async () => {
      stored({
        wallet: buildWallet({ id: 1, space_id: spaceId, is_deleted: 1 }),
        category: expense({ is_active: 0 }),
      });

      const result = await update({ wallet_id: 1, category_id: 5, amount: '1' });

      expect(updateQuery.set).toHaveBeenCalledWith({ amount: '1' });
      expect(result.wallets).toEqual([{ id: 1, balance: 0, is_deleted: true }]);
    });

    it.each<[string, Wallet[], string, number]>([
      ['missing', [], ErrorMessages.FORBIDDEN_WALLET, 403],
      ['of another space', [buildWallet({ id: 2, space_id: 20 })], ErrorMessages.FORBIDDEN_WALLET, 403],
      ['deleted', [buildWallet({ id: 2, space_id: spaceId, is_deleted: 1 })], ErrorMessages.WALLET_DELETED, 400],
    ])('refuses moving to a %s wallet', async (_, targets, message, status) => {
      lockedRows.set(Wallet, [original.wallet, ...targets]);

      await expect(update({ wallet_id: 2 })).rejects.toMatchObject(new HttpException(message, status));
      expect(updateQuery.execute).not.toHaveBeenCalled();
    });

    it('moves to an active wallet, locking both, and returns both balances, the old one first', async () => {
      lockedRows.set(Wallet, [original.wallet, buildWallet({ id: 2, space_id: spaceId })]);
      transactionQueriesService.getBalances.mockResolvedValue(
        new Map([
          [1, 500n],
          [2, -1230n],
        ]),
      );

      const result = await update({ wallet_id: 2 });

      expect(updateQuery.set).toHaveBeenCalledWith({ wallet_id: 2 });
      expect(transactionQueriesService.getBalances).toHaveBeenCalledWith([1, 2], manager);
      expect(result.wallets).toEqual([
        { id: 1, balance: 5, is_deleted: false },
        { id: 2, balance: -12.3, is_deleted: false },
      ]);
    });

    it.each<[string, Category[], string, number]>([
      ['missing', [], ErrorMessages.FORBIDDEN_CATEGORY, 403],
      ['of another space', [expense({ id: 6, space_id: 20 })], ErrorMessages.FORBIDDEN_CATEGORY, 403],
      ['the system one', [expense({ id: 6, is_system: 1 })], ErrorMessages.FORBIDDEN_CATEGORY, 403],
      ['archived', [expense({ id: 6, is_active: 0 })], ErrorMessages.CATEGORY_ARCHIVED, 400],
      [
        'of the other type',
        [expense({ id: 6, transaction_type: TransactionType.INCOME })],
        ErrorMessages.CATEGORY_TYPE_MISMATCH,
        400,
      ],
    ])('refuses moving to a %s category', async (_, targets, message, status) => {
      lockedRows.set(Category, targets);

      await expect(update({ category_id: 6 })).rejects.toMatchObject(new HttpException(message, status));
    });

    it('refuses a type change the current category does not match', async () => {
      await expect(update({ transaction_type: TransactionType.INCOME })).rejects.toMatchObject(
        new HttpException(ErrorMessages.CATEGORY_TYPE_MISMATCH, 400),
      );
    });

    it('changes the type together with a matching category', async () => {
      lockedRows.set(Category, [buildCategory({ id: 6, space_id: spaceId, transaction_type: TransactionType.INCOME })]);

      await update({ transaction_type: TransactionType.INCOME, category_id: 6 });

      expect(updateQuery.set).toHaveBeenCalledWith({ transaction_type: TransactionType.INCOME, category_id: 6 });
    });

    it('keeps a legacy type mismatch while neither type nor category changes', async () => {
      stored({ category: buildCategory({ id: 5, space_id: spaceId, transaction_type: TransactionType.INCOME }) });

      await update({ amount: '1' });

      expect(updateQuery.set).toHaveBeenCalledWith({ amount: '1' });
    });

    it('returns the record as read after the write', async () => {
      const after = withRelations(
        buildTransaction({ id: 'tx-1', amount: '20.00', version: 4, wallet: original.wallet, category: expense() }),
        'wallet',
        'category',
      );
      transactionQueriesService.getOneInSpace.mockResolvedValueOnce(original).mockResolvedValueOnce(after);

      const result = await update({ amount: '20' });

      expect(result.transaction).toEqual(toTransactionView(after));
    });

    it('keys an idempotent edit by the transaction, the version and the body', async () => {
      await service.update(userId, spaceId, 'tx-1', { amount: '20' }, { expectedVersion: 3, idempotencyKey: 'k' });

      expect(idempotencyService.run).toHaveBeenCalledWith(
        manager,
        expect.objectContaining({
          operation: 'transactions.update',
          key: 'k',
          payload: { transactionId: 'tx-1', expectedVersion: 3, body: { amount: '20' } },
        }),
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

    it('rejects from after to, before the access check', async () => {
      await expect(service.getAll(userId, spaceId, to, from)).rejects.toMatchObject({
        status: 400,
        response: { message: [{ field: 'from', error: 'from must not be after to' }] },
      });
      expect(spaceAccessService.assertMembership).not.toHaveBeenCalled();
    });

    it('accepts from equal to to', async () => {
      transactionQueriesService.getForAllWallets.mockResolvedValue([]);

      await expect(service.getAll(userId, spaceId, from, from)).resolves.toEqual([]);
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

  describe('count', () => {
    const from = new Date(2026, 0, 1);
    const to = new Date(2026, 0, 31);

    it('counts with the checks and filters of the list', async () => {
      transactionQueriesService.countForAllWallets.mockResolvedValue(7);
      const filters = { transactionType: TransactionType.EXPENSE, categoryId: 5, walletId: 1 };

      await expect(service.count(userId, spaceId, from, to, filters)).resolves.toEqual({ count: 7 });
      expect(spaceAccessService.assertMembership).toHaveBeenCalledWith(spaceId, userId);
      expect(categoriesService.getOne).toHaveBeenCalledWith(5);
      expect(walletsService.getOne).toHaveBeenCalledWith(1);
      expect(transactionQueriesService.countForAllWallets).toHaveBeenCalledWith(spaceId, from, to, filters);
      expect(transactionQueriesService.getForAllWallets).not.toHaveBeenCalled();
    });

    it('rejects from after to', async () => {
      await expect(service.count(userId, spaceId, to, from)).rejects.toMatchObject({ status: 400 });
      expect(transactionQueriesService.countForAllWallets).not.toHaveBeenCalled();
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

  describe('getOperation', () => {
    const operationId = '0f8e3b1c-5d2a-4e8f-9a61-2c7d4b5e6f70';
    const createdAt = new Date('2026-09-15T10:00:00.000Z');
    const operation = (deletedAt: Date | null = null) =>
      Object.assign(new TransactionOperation(), {
        space_id: spaceId,
        operation_id: operationId,
        transaction_id: 'tx-1',
        created_at: createdAt,
        deleted_at: deletedAt,
      });
    const notFound = new HttpException(ErrorMessages.TRANSACTION_OPERATION_NOT_FOUND, 404);

    it('rejects a non-member before reading the operation', async () => {
      spaceAccessService.assertMembership.mockRejectedValue(forbidden());

      await expect(service.getOperation(userId, spaceId, operationId)).rejects.toMatchObject(forbidden());
      expect(dataSource.transaction).not.toHaveBeenCalled();
    });

    it('is not found for an id that is not a UUID', async () => {
      await expect(service.getOperation(userId, spaceId, 'nope')).rejects.toMatchObject(notFound);
      expect(dataSource.transaction).not.toHaveBeenCalled();
    });

    it('is not found when no create with the id committed in the space', async () => {
      await expect(service.getOperation(userId, spaceId, operationId.toUpperCase())).rejects.toMatchObject(notFound);
      expect(dataSource.transaction).toHaveBeenCalledWith('REPEATABLE READ', expect.any(Function));
      expect(operationRepository.findOne).toHaveBeenCalledWith({
        where: { space_id: spaceId, operation_id: operationId },
      });
    });

    it('returns the current record of an applied create, edited or not', async () => {
      const transaction = Object.assign(loadedTransaction('tx-1', { id: 1 }), { version: 3 });
      operationRepository.findOne.mockResolvedValue(operation());
      transactionQueriesService.getOneInSpace.mockResolvedValue(transaction);

      await expect(service.getOperation(userId, spaceId, operationId)).resolves.toEqual({
        operation_id: operationId,
        status: 'applied',
        transaction_id: 'tx-1',
        created_at: createdAt,
        deleted_at: null,
        transaction: toTransactionView(transaction),
      });
      expect(transactionQueriesService.getOneInSpace).toHaveBeenCalledWith(spaceId, 'tx-1', manager);
    });

    it('reports a create whose transaction was deleted since', async () => {
      const deletedAt = new Date('2026-09-16T10:00:00.000Z');
      operationRepository.findOne.mockResolvedValue(operation(deletedAt));
      transactionQueriesService.getOneInSpace.mockResolvedValue(null);

      await expect(service.getOperation(userId, spaceId, operationId)).resolves.toMatchObject({
        status: 'deleted',
        transaction_id: 'tx-1',
        deleted_at: deletedAt,
        transaction: null,
      });
    });
  });

  describe('remove', () => {
    const lockedTransaction = (overrides: Partial<Transaction> = {}) => {
      const transaction = Object.assign(loadedTransaction('tx-1', { id: 1 }), overrides);
      lockedRows.set(Transaction, [transaction]);
      transactionQueriesService.getOneInSpace.mockResolvedValue(transaction);
      return transaction;
    };

    it('requires the version the client read, before any access check', async () => {
      await expect(service.remove(userId, spaceId, 'tx-1')).rejects.toMatchObject(
        new HttpException(ErrorMessages.TRANSACTION_VERSION_REQUIRED, 428),
      );
      expect(spaceAccessService.lockMembership).not.toHaveBeenCalled();
    });

    it('rejects a non-member before loading the transaction', async () => {
      spaceAccessService.lockMembership.mockRejectedValue(forbidden());

      await expect(service.remove(userId, spaceId, 'tx-1', { expectedVersion: 1 })).rejects.toMatchObject(forbidden());
      expect(manager.createQueryBuilder).not.toHaveBeenCalled();
      expect(transactionRepository.delete).not.toHaveBeenCalled();
    });

    it('locks the transaction row, then reads it in the space, then locks its wallet', async () => {
      lockedTransaction();

      await service.remove(userId, spaceId, 'tx-1', { expectedVersion: 1 });

      expect(jest.mocked(manager.createQueryBuilder).mock.calls.map(([entity]) => entity)).toEqual([
        Transaction,
        Wallet,
      ]);
      expect(transactionQueriesService.getOneInSpace).toHaveBeenCalledWith(spaceId, 'tx-1', manager);
      expect(spaceAccessService.lockSpace).toHaveBeenCalledWith(spaceId, manager, 'shared');
    });

    it('is not found when no row could be locked', async () => {
      await expect(service.remove(userId, spaceId, 'tx-1', { expectedVersion: 1 })).rejects.toMatchObject(
        new HttpException(ErrorMessages.TRANSACTION_NOT_FOUND, 404),
      );
      expect(transactionQueriesService.getOneInSpace).not.toHaveBeenCalled();
    });

    it('is not found when the transaction belongs to another space', async () => {
      lockedTransaction();
      transactionQueriesService.getOneInSpace.mockResolvedValue(null);

      await expect(service.remove(userId, spaceId, 'tx-1', { expectedVersion: 1 })).rejects.toMatchObject(
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

    it('deletes with the matching version', async () => {
      lockedTransaction({ version: 3 });

      await service.remove(userId, spaceId, 'tx-1', { expectedVersion: 3 });

      expect(transactionRepository.delete).toHaveBeenCalledWith('tx-1');
    });

    it('marks the operation that created the transaction as deleted', async () => {
      lockedTransaction();

      await service.remove(userId, spaceId, 'tx-1', { expectedVersion: 1 });

      expect(operationRepository.update).toHaveBeenCalledWith(
        { transaction_id: 'tx-1' },
        { deleted_at: expect.any(Date) },
      );
    });

    it('deletes a record of a deleted wallet', async () => {
      lockedTransaction({ wallet: buildWallet({ id: 1, space_id: spaceId, is_deleted: 1 }) });

      await service.remove(userId, spaceId, 'tx-1', { expectedVersion: 1 });

      expect(transactionRepository.delete).toHaveBeenCalledWith('tx-1');
    });
  });
});
