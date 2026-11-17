import { Test } from '@nestjs/testing';
import { HttpException } from '@nestjs/common';
import { DataSource, type EntityManager } from 'typeorm';

import { SpaceTransactionsService } from './space-transactions.service';
import { TransactionWrites } from './transaction-writes';
import type { CreateTransactionV2Dto, UpdateTransactionV2Dto } from './dto/transaction-v2.dto';
import { Transaction } from '@entities/transaction.entity';
import { TransactionOperation } from '@entities/transaction-operation.entity';
import { Category } from '@entities/category.entity';
import { Wallet } from '@entities/wallet.entity';
import { AssignmentKind, AuthorSource, PersonStatus, TransactionType } from '@shared/enums';
import { ErrorMessages } from '@shared/error-messages';
import { withRelations } from '@shared/utils';
import { TransactionQueriesService } from '@modules/transaction-queries/transaction-queries.service';
import { SpaceAccessService } from '@modules/space-access/space-access.service';
import { IdempotencyService } from '@modules/idempotency/idempotency.service';
import { buildCategory, buildSpaceMember, buildTransaction, buildUser, buildWallet } from '@testing';

describe('SpaceTransactionsService', () => {
  const userId = 1;
  const spaceId = 10;
  const lena = 31;
  const former = 44;
  const transactionId = '9b1d6c2e-0f4a-4c2b-9d8e-3a7f5b6c1d20';

  let service: SpaceTransactionsService;
  let queries: Record<'getOneInSpace' | 'getMemberUserIds' | 'getLatest', jest.Mock>;
  let access: Record<'assertMembership' | 'lockMembership' | 'lockMemberships' | 'lockSpace', jest.Mock>;
  let idempotency: { run: jest.Mock };
  let repositories: Map<unknown, Record<string, jest.Mock>>;
  let lockedRows: Map<unknown, unknown[]>;
  let updateQuery: Record<'update' | 'set' | 'where' | 'execute', jest.Mock>;
  let manager: EntityManager;

  const stored = (overrides: Partial<Transaction> = {}) =>
    withRelations(
      buildTransaction({
        id: transactionId,
        space_id: spaceId,
        wallet_id: 5,
        category_id: 3,
        author_user_id: userId,
        author: buildUser({ id: userId, name: 'Zakhar' }),
        assignment_kind: AssignmentKind.MEMBER,
        assigned_user_id: former,
        assignedUser: buildUser({ id: former, name: 'Mark' }),
        wallet: buildWallet({ id: 5, space_id: spaceId }),
        category: buildCategory({ id: 3, space_id: spaceId }),
        ...overrides,
      }),
      'wallet',
      'category',
    );

  const member = (id: number) => buildSpaceMember({ id, space_id: spaceId, user_id: id });
  const forbidden = new HttpException(ErrorMessages.FORBIDDEN_SPACE, 403);
  const notMember = new HttpException(ErrorMessages.ASSIGNEE_NOT_MEMBER, 400);

  beforeEach(async () => {
    queries = {
      getOneInSpace: jest.fn().mockResolvedValue(stored()),
      getMemberUserIds: jest.fn().mockResolvedValue(new Set([userId, lena])),
      getLatest: jest.fn().mockResolvedValue(null),
    };
    access = {
      assertMembership: jest.fn().mockResolvedValue(member(userId)),
      lockMembership: jest.fn().mockResolvedValue(member(userId)),
      lockMemberships: jest.fn(
        async (_space: number, actor: number, others: number[]) =>
          new Map([actor, ...others].filter((id) => id !== former).map((id) => [id, member(id)])),
      ),
      lockSpace: jest.fn(),
    };
    idempotency = { run: jest.fn((_manager, _request, work) => work()) };
    lockedRows = new Map<unknown, unknown[]>([
      [Transaction, [stored()]],
      [Wallet, [buildWallet({ id: 5, space_id: spaceId, compat_space_id: spaceId })]],
      [Category, [buildCategory({ id: 3, space_id: spaceId })]],
    ]);
    repositories = new Map<unknown, Record<string, jest.Mock>>([
      [
        Transaction,
        {
          create: jest.fn((entity) => entity),
          save: jest.fn(async (entity) => ({ ...entity, id: transactionId })),
          delete: jest.fn(),
        },
      ],
      [
        TransactionOperation,
        {
          exists: jest.fn().mockResolvedValue(false),
          insert: jest.fn(),
          update: jest.fn(),
          findOne: jest.fn().mockResolvedValue(null),
        },
      ],
      [Wallet, { findOne: jest.fn().mockResolvedValue({ id: 5 }), create: jest.fn(), save: jest.fn() }],
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
      getRepository: jest.fn((entity: unknown) => repositories.get(entity)),
    } as unknown as EntityManager;

    const module = await Test.createTestingModule({
      providers: [
        SpaceTransactionsService,
        TransactionWrites,
        { provide: TransactionQueriesService, useValue: queries },
        { provide: SpaceAccessService, useValue: access },
        { provide: IdempotencyService, useValue: idempotency },
        { provide: DataSource, useValue: { transaction: jest.fn((_level, work) => work(manager)) } },
      ],
    }).compile();

    service = module.get(SpaceTransactionsService);
  });

  describe('create', () => {
    const dto = (overrides: Partial<CreateTransactionV2Dto> = {}): CreateTransactionV2Dto => ({
      category_id: 3,
      transaction_type: TransactionType.EXPENSE,
      amount: '12.3',
      timestamp: '2026-09-15T10:00:00.000Z',
      description: ' Dinner ',
      assignment: { kind: AssignmentKind.MEMBER, user_id: lena },
      ...overrides,
    });

    it('records the caller as the author and the assignment, in the compatibility wallet', async () => {
      await service.create(userId, spaceId, dto());

      expect(repositories.get(Transaction)!.create).toHaveBeenCalledWith({
        space_id: spaceId,
        wallet_id: 5,
        author_user_id: userId,
        author_source: AuthorSource.RECORDED,
        assignment_kind: AssignmentKind.MEMBER,
        assigned_user_id: lena,
        category_id: 3,
        transaction_type: TransactionType.EXPENSE,
        amount: '12.3',
        timestamp: new Date('2026-09-15T10:00:00.000Z'),
        description: 'Dinner',
      });
    });

    it('locks the assignee with the actor, before the space', async () => {
      await service.create(userId, spaceId, dto());

      expect(access.lockMemberships).toHaveBeenCalledWith(spaceId, userId, [lena], manager);
      expect(access.lockMembership).not.toHaveBeenCalled();
      expect(access.lockMemberships.mock.invocationCallOrder[0]).toBeLessThan(
        access.lockSpace.mock.invocationCallOrder[0],
      );
    });

    it.each([AssignmentKind.SPACE, AssignmentKind.UNASSIGNED])('locks only the actor for %s', async (kind) => {
      await service.create(userId, spaceId, dto({ assignment: { kind } }));

      expect(access.lockMembership).toHaveBeenCalledWith(spaceId, userId, manager);
      expect(access.lockMemberships).not.toHaveBeenCalled();
      expect(repositories.get(Transaction)!.create).toHaveBeenCalledWith(
        expect.objectContaining({ assignment_kind: kind, assigned_user_id: null }),
      );
    });

    it('refuses an assignee who is not a member at commit, after the category checks', async () => {
      lockedRows.set(Category, [buildCategory({ id: 3, space_id: spaceId, is_active: 0 })]);

      await expect(
        service.create(userId, spaceId, dto({ assignment: { kind: AssignmentKind.MEMBER, user_id: former } })),
      ).rejects.toMatchObject(new HttpException(ErrorMessages.CATEGORY_ARCHIVED, 400));

      lockedRows.set(Category, [buildCategory({ id: 3, space_id: spaceId })]);

      await expect(
        service.create(userId, spaceId, dto({ assignment: { kind: AssignmentKind.MEMBER, user_id: former } })),
      ).rejects.toMatchObject(notMember);
      expect(repositories.get(Transaction)!.save).not.toHaveBeenCalled();
    });

    it('keys the create apart from v1 and records its operation id', async () => {
      await service.create(userId, spaceId, dto({ client_operation_id: '0F8E3B1C-5D2A-4E8F-9A61-2C7D4B5E6F70' }), {
        idempotencyKey: 'k',
      });

      expect(idempotency.run).toHaveBeenCalledWith(
        manager,
        expect.objectContaining({ operation: 'transactions.v2.create', key: 'k', userId, spaceId }),
        expect.any(Function),
      );
      expect(repositories.get(TransactionOperation)!.insert).toHaveBeenCalledWith(
        expect.objectContaining({
          operation_id: '0f8e3b1c-5d2a-4e8f-9a61-2c7d4b5e6f70',
          transaction_id: transactionId,
        }),
      );
    });

    it('refuses a used operation id before the wallet and the category', async () => {
      repositories.get(TransactionOperation)!.exists.mockResolvedValue(true);

      await expect(
        service.create(userId, spaceId, dto({ client_operation_id: '0f8e3b1c-5d2a-4e8f-9a61-2c7d4b5e6f70' })),
      ).rejects.toMatchObject(new HttpException(ErrorMessages.TRANSACTION_OPERATION_EXISTS, 409));
      expect(repositories.get(Wallet)!.findOne).not.toHaveBeenCalled();
    });

    it('returns the stored record as the v2 view', async () => {
      queries.getOneInSpace.mockResolvedValue(
        stored({ assigned_user_id: lena, assignedUser: buildUser({ id: lena, name: 'Lena' }) }),
      );

      const { transaction } = await service.create(userId, spaceId, dto());

      expect(transaction.assignment).toEqual({
        kind: AssignmentKind.MEMBER,
        user_id: lena,
        name: 'Lena',
        status: PersonStatus.MEMBER,
      });
      expect(queries.getMemberUserIds).toHaveBeenCalledWith(spaceId, manager);
    });
  });

  describe('update', () => {
    const update = (dto: UpdateTransactionV2Dto) =>
      service.update(userId, spaceId, transactionId, dto, { expectedVersion: 1 });

    it('requires the version the client read', async () => {
      await expect(service.update(userId, spaceId, transactionId, {}, {})).rejects.toMatchObject(
        new HttpException(ErrorMessages.TRANSACTION_VERSION_REQUIRED, 428),
      );
    });

    it('changes the assignment and never the author', async () => {
      await update({ assignment: { kind: AssignmentKind.SPACE } });

      expect(updateQuery.set).toHaveBeenCalledWith({ assignment_kind: AssignmentKind.SPACE, assigned_user_id: null });
    });

    it('keeps an unchanged assignment to a former member and writes nothing', async () => {
      await update({ assignment: { kind: AssignmentKind.MEMBER, user_id: former } });

      expect(updateQuery.execute).not.toHaveBeenCalled();
    });

    it('edits other fields of a record assigned to a former member', async () => {
      await update({ amount: '20' });

      expect(updateQuery.set).toHaveBeenCalledWith({ amount: '20' });
    });

    it('refuses a changed assignment to someone who is not a member', async () => {
      lockedRows.set(Transaction, [stored({ assignment_kind: AssignmentKind.SPACE, assigned_user_id: null })]);
      queries.getOneInSpace.mockResolvedValue(
        stored({ assignment_kind: AssignmentKind.SPACE, assigned_user_id: null }),
      );

      await expect(update({ assignment: { kind: AssignmentKind.MEMBER, user_id: former } })).rejects.toMatchObject(
        notMember,
      );
      expect(updateQuery.execute).not.toHaveBeenCalled();
    });

    it('changes the assignment to a member, locking them with the actor', async () => {
      await update({ assignment: { kind: AssignmentKind.MEMBER, user_id: lena } });

      expect(access.lockMemberships).toHaveBeenCalledWith(spaceId, userId, [lena], manager);
      expect(updateQuery.set).toHaveBeenCalledWith({ assignment_kind: AssignmentKind.MEMBER, assigned_user_id: lena });
    });

    it('locks the record, then its wallet', async () => {
      await update({ amount: '20' });

      const locked = (manager.createQueryBuilder as jest.Mock).mock.calls.map(([entity]) => entity);
      expect(locked.indexOf(Transaction)).toBeLessThan(locked.indexOf(Wallet));
    });

    it('refuses the initial balance and a stale version', async () => {
      queries.getOneInSpace.mockResolvedValue(stored({ category: buildCategory({ is_system: 1 }) }));
      await expect(update({ amount: '20' })).rejects.toMatchObject(
        new HttpException(ErrorMessages.TRANSACTION_IS_SYSTEM, 400),
      );

      queries.getOneInSpace.mockResolvedValue(stored({ version: 2 }));
      await expect(update({ amount: '20' })).rejects.toMatchObject(
        new HttpException(ErrorMessages.TRANSACTION_VERSION_CONFLICT, 409),
      );
    });

    it('keys the edit apart from v1', async () => {
      await service.update(userId, spaceId, transactionId, {}, { expectedVersion: 1, idempotencyKey: 'k' });

      expect(idempotency.run).toHaveBeenCalledWith(
        manager,
        expect.objectContaining({
          operation: 'transactions.v2.update',
          payload: { transactionId, expectedVersion: 1, body: {} },
        }),
        expect.any(Function),
      );
    });
  });

  describe('remove', () => {
    it('deletes the record and marks its operation, keyed apart from v1', async () => {
      await service.remove(userId, spaceId, transactionId, { expectedVersion: 1, idempotencyKey: 'k' });

      expect(repositories.get(Transaction)!.delete).toHaveBeenCalledWith(transactionId);
      expect(repositories.get(TransactionOperation)!.update).toHaveBeenCalledWith(
        { transaction_id: transactionId },
        { deleted_at: expect.any(Date) },
      );
      expect(idempotency.run).toHaveBeenCalledWith(
        manager,
        expect.objectContaining({ operation: 'transactions.v2.delete' }),
        expect.any(Function),
      );
    });
  });

  describe('reads', () => {
    it('reject a non-member before reading', async () => {
      access.assertMembership.mockRejectedValue(forbidden);

      await expect(service.getById(userId, spaceId, transactionId)).rejects.toMatchObject(forbidden);
      await expect(service.getLatest(userId, spaceId)).rejects.toMatchObject(forbidden);
      await expect(service.getOperation(userId, spaceId, transactionId)).rejects.toMatchObject(forbidden);
      expect(queries.getOneInSpace).not.toHaveBeenCalled();
    });

    it('report a malformed or missing id as not found', async () => {
      await expect(service.getById(userId, spaceId, 'nope')).rejects.toMatchObject(
        new HttpException(ErrorMessages.TRANSACTION_NOT_FOUND, 404),
      );
      queries.getOneInSpace.mockResolvedValue(null);
      await expect(service.getById(userId, spaceId, transactionId)).rejects.toMatchObject(
        new HttpException(ErrorMessages.TRANSACTION_NOT_FOUND, 404),
      );
      await expect(service.getOperation(userId, spaceId, 'nope')).rejects.toMatchObject(
        new HttpException(ErrorMessages.TRANSACTION_OPERATION_NOT_FOUND, 404),
      );
    });

    it('resolve people against the members of the space', async () => {
      const view = await service.getById(userId, spaceId, transactionId);

      expect(view.author).toEqual({ user_id: userId, name: 'Zakhar', status: PersonStatus.MEMBER, source: 'recorded' });
      expect(view.assignment).toEqual({
        kind: AssignmentKind.MEMBER,
        user_id: former,
        name: 'Mark',
        status: PersonStatus.FORMER_MEMBER,
      });
    });

    it('return the latest record, or null', async () => {
      await expect(service.getLatest(userId, spaceId)).resolves.toBeNull();

      queries.getLatest.mockResolvedValue(stored());
      await expect(service.getLatest(userId, spaceId)).resolves.toEqual(expect.objectContaining({ id: transactionId }));
    });

    it('report an applied and a deleted create', async () => {
      const operation = {
        operation_id: '0f8e3b1c-5d2a-4e8f-9a61-2c7d4b5e6f70',
        transaction_id: transactionId,
        created_at: new Date('2026-09-15T10:00:01Z'),
        deleted_at: new Date('2026-09-16T10:00:00Z'),
      };
      repositories.get(TransactionOperation)!.findOne.mockResolvedValue(operation);

      await expect(service.getOperation(userId, spaceId, operation.operation_id)).resolves.toEqual(
        expect.objectContaining({ status: 'applied', deleted_at: null, transaction: expect.any(Object) }),
      );

      queries.getOneInSpace.mockResolvedValue(null);
      await expect(service.getOperation(userId, spaceId, operation.operation_id)).resolves.toEqual(
        expect.objectContaining({ status: 'deleted', deleted_at: operation.deleted_at, transaction: null }),
      );
    });

    it('report an operation that never committed as not found', async () => {
      await expect(service.getOperation(userId, spaceId, '0f8e3b1c-5d2a-4e8f-9a61-2c7d4b5e6f70')).rejects.toMatchObject(
        new HttpException(ErrorMessages.TRANSACTION_OPERATION_NOT_FOUND, 404),
      );
    });
  });
});
