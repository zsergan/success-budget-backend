import { Test } from '@nestjs/testing';
import { BadRequestException, HttpException } from '@nestjs/common';
import { DataSource, type EntityManager } from 'typeorm';

import { SpaceTransactionsService } from './space-transactions.service';
import { TransactionWrites } from './transaction-writes';
import { TransactionFeedReader } from './transaction-feed-reader';
import type { TransactionFeedQueryV2Dto } from './dto/transaction-feed-query-v2.dto';
import { CategoriesService } from '@modules/categories/categories.service';
import type { CreateTransactionV2Dto, UpdateTransactionV2Dto } from './dto/transaction-v2.dto';
import { Transaction } from '@entities/transaction.entity';
import { TransactionOperation } from '@entities/transaction-operation.entity';
import { Category } from '@entities/category.entity';
import { AssignmentKind, AuthorSource, PersonStatus, TransactionType } from '@shared/enums';
import { ErrorMessages } from '@shared/error-messages';
import { withRelations } from '@shared/utils';
import { TransactionQueriesService } from '@modules/transaction-queries/transaction-queries.service';
import { SpaceAccessService } from '@modules/space-access/space-access.service';
import { IdempotencyService } from '@modules/idempotency/idempotency.service';
import { buildCategory, buildSpaceMember, buildTransaction, buildUser } from '@testing';
import { toTransactionViewV2 } from './transaction-view';

describe('SpaceTransactionsService', () => {
  const userId = 1;
  const spaceId = 10;
  const lena = 31;
  const former = 44;
  const transactionId = '9b1d6c2e-0f4a-4c2b-9d8e-3a7f5b6c1d20';

  let service: SpaceTransactionsService;
  let queries: Record<
    | 'getOneInSpace'
    | 'getMemberUserIds'
    | 'getLatest'
    | 'countSelection'
    | 'getFeedPage'
    | 'getFeedSummary'
    | 'getFeedIntervalNets'
    | 'getMembers'
    | 'getAssignedUsers'
    | 'hasDeletedAssignees'
    | 'isKnownAssignee'
    | 'findFeedPosition',
    jest.Mock
  >;
  let categories: { getOne: jest.Mock };
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
        category_id: 3,
        author_user_id: userId,
        author: buildUser({ id: userId, name: 'Zakhar' }),
        assignment_kind: AssignmentKind.MEMBER,
        assigned_user_id: former,
        assignedUser: buildUser({ id: former, name: 'Mark' }),
        category: buildCategory({ id: 3, space_id: spaceId }),
        ...overrides,
      }),
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
      countSelection: jest.fn().mockResolvedValue(3),
      getFeedPage: jest.fn().mockResolvedValue({ items: [stored()], hasMore: false }),
      getFeedSummary: jest.fn().mockResolvedValue({ count: 1, income: 0n, expense: 1230n }),
      getFeedIntervalNets: jest.fn(async (_selection, intervals: unknown[]) => intervals.map(() => -1230n)),
      getMembers: jest.fn().mockResolvedValue([
        { userId: userId, name: 'Zakhar' },
        { userId: lena, name: 'Lena' },
      ]),
      getAssignedUsers: jest.fn().mockResolvedValue([
        { userId: lena, name: 'Lena' },
        { userId: 52, name: 'Zoe' },
        { userId: former, name: 'Mark' },
      ]),
      hasDeletedAssignees: jest.fn().mockResolvedValue(true),
      isKnownAssignee: jest.fn().mockResolvedValue(true),
      findFeedPosition: jest.fn().mockResolvedValue(null),
    };
    categories = { getOne: jest.fn().mockResolvedValue(buildCategory({ id: 3, space_id: spaceId })) };
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
        TransactionFeedReader,
        { provide: CategoriesService, useValue: categories },
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

    it('records the space, the caller as the author and the assignment', async () => {
      await service.create(userId, spaceId, dto());

      expect(repositories.get(Transaction)!.create).toHaveBeenCalledWith({
        space_id: spaceId,
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

    it('refuses a used operation id before the category', async () => {
      repositories.get(TransactionOperation)!.exists.mockResolvedValue(true);

      await expect(
        service.create(userId, spaceId, dto({ client_operation_id: '0f8e3b1c-5d2a-4e8f-9a61-2c7d4b5e6f70' })),
      ).rejects.toMatchObject(new HttpException(ErrorMessages.TRANSACTION_OPERATION_EXISTS, 409));
      expect(manager.createQueryBuilder).not.toHaveBeenCalledWith(Category, 'row');
    });

    it('locks the actor, the space and then the category, and nothing else', async () => {
      await service.create(userId, spaceId, dto({ assignment: { kind: AssignmentKind.SPACE } }));

      expect((manager.createQueryBuilder as jest.Mock).mock.calls.map(([entity]) => entity)).toEqual([Category]);
      expect(access.lockMembership.mock.invocationCallOrder[0]).toBeLessThan(
        access.lockSpace.mock.invocationCallOrder[0],
      );
    });

    it('writes without a key, outside the idempotency store', async () => {
      await service.create(userId, spaceId, dto());

      expect(idempotency.run).not.toHaveBeenCalled();
    });

    it('runs a keyed create through the store, after the access locks', async () => {
      access.lockSpace.mockImplementation(async () => {
        expect(idempotency.run).not.toHaveBeenCalled();
      });

      await service.create(userId, spaceId, dto(), { idempotencyKey: 'key-1' });

      expect(idempotency.run).toHaveBeenCalledWith(
        manager,
        { operation: 'transactions.v2.create', key: 'key-1', payload: dto(), userId, spaceId },
        expect.any(Function),
      );
    });

    it('returns a stored result without writing again', async () => {
      const result = { transaction: { id: transactionId } };
      idempotency.run.mockResolvedValue(result);

      await expect(service.create(userId, spaceId, dto(), { idempotencyKey: 'key-1' })).resolves.toBe(result);
      expect(repositories.get(Transaction)!.save).not.toHaveBeenCalled();
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

    it('requires the version the client read, before any access check', async () => {
      await expect(service.update(userId, spaceId, transactionId, {}, {})).rejects.toMatchObject(
        new HttpException(ErrorMessages.TRANSACTION_VERSION_REQUIRED, 428),
      );
      expect(access.lockMembership).not.toHaveBeenCalled();
    });

    it('is not found when no row could be locked', async () => {
      lockedRows.set(Transaction, []);

      await expect(update({ amount: '1' })).rejects.toMatchObject(
        new HttpException(ErrorMessages.TRANSACTION_NOT_FOUND, 404),
      );
    });

    it('locks only the record, then reads it in the space', async () => {
      await update({ amount: '20' });

      expect((manager.createQueryBuilder as jest.Mock).mock.calls.map(([entity]) => entity)).toEqual([
        Transaction,
        undefined,
      ]);
      expect(queries.getOneInSpace).toHaveBeenCalledWith(spaceId, transactionId, manager);
    });

    it('writes only the fields that change', async () => {
      queries.getOneInSpace.mockResolvedValue(stored({ amount: '12.30', description: 'Lunch' }));

      await update({ amount: '20', description: '  Dinner ', transaction_type: TransactionType.EXPENSE });

      expect(updateQuery.set).toHaveBeenCalledWith({ amount: '20', description: 'Dinner' });
      expect(updateQuery.where).toHaveBeenCalledWith('id = :id', { id: transactionId });
    });

    it.each<[string, UpdateTransactionV2Dto]>([
      ['an empty body', {}],
      [
        'the current values in another spelling',
        {
          category_id: 3,
          transaction_type: TransactionType.EXPENSE,
          amount: '12.3',
          timestamp: '2026-09-15T12:00:00.000+02:00',
          description: ' Lunch ',
          assignment: { kind: AssignmentKind.MEMBER, user_id: former },
        },
      ],
    ])('writes nothing and keeps the version for %s', async (_, body) => {
      queries.getOneInSpace.mockResolvedValue(
        stored({ amount: '12.30', timestamp: new Date('2026-09-15T10:00:00.000Z'), description: 'Lunch' }),
      );

      const result = await update(body);

      expect(updateQuery.execute).not.toHaveBeenCalled();
      expect(result.transaction.version).toBe(1);
    });

    it('treats a cleared legacy blank description as unchanged', async () => {
      queries.getOneInSpace.mockResolvedValue(stored({ description: '' }));

      await update({ description: null });

      expect(updateQuery.execute).not.toHaveBeenCalled();
    });

    it('clears the description with null', async () => {
      queries.getOneInSpace.mockResolvedValue(stored({ description: 'Lunch' }));

      await update({ description: null });

      expect(updateQuery.set).toHaveBeenCalledWith({ description: null });
    });

    it.each<[string, UpdateTransactionV2Dto, string]>([
      ['a zero amount', { amount: '0.00' }, 'amount must be greater than 0'],
      ['a future timestamp', { timestamp: '2999-01-01T00:00:00.000Z' }, 'timestamp must not be in the future'],
    ])('refuses %s as a new value', async (_, body, error) => {
      await expect(update(body)).rejects.toMatchObject({
        response: { message: [{ field: Object.keys(body)[0], error }] },
        status: 400,
      });
    });

    it('keeps a legacy zero amount and future timestamp when other fields change', async () => {
      queries.getOneInSpace.mockResolvedValue(
        stored({ amount: '0.00', timestamp: new Date('2999-01-01T00:00:00.000Z') }),
      );

      await update({ amount: '0', timestamp: '2999-01-01T00:00:00.000Z', description: 'x' });

      expect(updateQuery.set).toHaveBeenCalledWith({ description: 'x' });
    });

    it('keeps its own archived category', async () => {
      queries.getOneInSpace.mockResolvedValue(
        stored({ category: buildCategory({ id: 3, space_id: spaceId, is_active: 0 }) }),
      );

      await update({ category_id: 3, amount: '1' });

      expect(updateQuery.set).toHaveBeenCalledWith({ amount: '1' });
    });

    it.each<[string, Category[], string, number]>([
      ['missing', [], ErrorMessages.FORBIDDEN_CATEGORY, 403],
      ['of another space', [buildCategory({ id: 6, space_id: 20 })], ErrorMessages.FORBIDDEN_CATEGORY, 403],
      [
        'the system one',
        [buildCategory({ id: 6, space_id: spaceId, is_system: 1 })],
        ErrorMessages.FORBIDDEN_CATEGORY,
        403,
      ],
      ['archived', [buildCategory({ id: 6, space_id: spaceId, is_active: 0 })], ErrorMessages.CATEGORY_ARCHIVED, 400],
      [
        'of the other type',
        [buildCategory({ id: 6, space_id: spaceId, transaction_type: TransactionType.INCOME })],
        ErrorMessages.CATEGORY_TYPE_MISMATCH,
        400,
      ],
    ])('refuses moving to a %s category', async (_, targets, message, status) => {
      lockedRows.set(Category, targets);

      await expect(update({ category_id: 6 })).rejects.toMatchObject(new HttpException(message, status));
      expect(updateQuery.execute).not.toHaveBeenCalled();
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
      queries.getOneInSpace.mockResolvedValue(
        stored({ category: buildCategory({ id: 3, space_id: spaceId, transaction_type: TransactionType.INCOME }) }),
      );

      await update({ amount: '1' });

      expect(updateQuery.set).toHaveBeenCalledWith({ amount: '1' });
    });

    it('returns the record as read after the write', async () => {
      const after = stored({ amount: '20.00', version: 2 });
      queries.getOneInSpace.mockResolvedValueOnce(stored()).mockResolvedValueOnce(after);

      const result = await update({ amount: '20' });

      expect(result.transaction).toEqual(toTransactionViewV2(after, new Set([userId, lena])));
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

    it('keys the edit by the transaction, the version and the body, apart from v1', async () => {
      await service.update(
        userId,
        spaceId,
        transactionId,
        { amount: '20' },
        { expectedVersion: 1, idempotencyKey: 'k' },
      );

      expect(idempotency.run).toHaveBeenCalledWith(
        manager,
        expect.objectContaining({
          operation: 'transactions.v2.update',
          key: 'k',
          payload: { transactionId, expectedVersion: 1, body: { amount: '20' } },
        }),
        expect.any(Function),
      );
    });
  });

  describe('remove', () => {
    it('requires the version the client read, before any access check', async () => {
      await expect(service.remove(userId, spaceId, transactionId)).rejects.toMatchObject(
        new HttpException(ErrorMessages.TRANSACTION_VERSION_REQUIRED, 428),
      );
      expect(access.lockMembership).not.toHaveBeenCalled();
    });

    it('rejects a non-member before loading the transaction', async () => {
      access.lockMembership.mockRejectedValue(forbidden);

      await expect(service.remove(userId, spaceId, transactionId, { expectedVersion: 1 })).rejects.toMatchObject(
        forbidden,
      );
      expect(manager.createQueryBuilder).not.toHaveBeenCalled();
    });

    it('locks only the transaction row, then reads it in the space', async () => {
      await service.remove(userId, spaceId, transactionId, { expectedVersion: 1 });

      expect((manager.createQueryBuilder as jest.Mock).mock.calls.map(([entity]) => entity)).toEqual([Transaction]);
      expect(queries.getOneInSpace).toHaveBeenCalledWith(spaceId, transactionId, manager);
      expect(access.lockSpace).toHaveBeenCalledWith(spaceId, manager, 'shared');
    });

    it.each<[string, () => void]>([
      ['no row could be locked', () => lockedRows.set(Transaction, [])],
      ['the transaction belongs to another space', () => queries.getOneInSpace.mockResolvedValue(null)],
    ])('is not found when %s', async (_, arrange) => {
      arrange();

      await expect(service.remove(userId, spaceId, transactionId, { expectedVersion: 1 })).rejects.toMatchObject(
        new HttpException(ErrorMessages.TRANSACTION_NOT_FOUND, 404),
      );
      expect(repositories.get(Transaction)!.delete).not.toHaveBeenCalled();
    });

    it('refuses the initial balance even with the right version, and a stale version', async () => {
      queries.getOneInSpace.mockResolvedValue(stored({ category: buildCategory({ is_system: 1 }) }));
      await expect(service.remove(userId, spaceId, transactionId, { expectedVersion: 1 })).rejects.toMatchObject(
        new HttpException(ErrorMessages.TRANSACTION_IS_SYSTEM, 400),
      );

      queries.getOneInSpace.mockResolvedValue(stored({ version: 3 }));
      await expect(service.remove(userId, spaceId, transactionId, { expectedVersion: 2 })).rejects.toMatchObject(
        new HttpException(ErrorMessages.TRANSACTION_VERSION_CONFLICT, 409),
      );
      expect(repositories.get(Transaction)!.delete).not.toHaveBeenCalled();
    });

    it('keys a delete by the transaction and the expected version', async () => {
      await service.remove(userId, spaceId, transactionId, { expectedVersion: 1, idempotencyKey: 'key-2' });

      expect(idempotency.run).toHaveBeenCalledWith(
        manager,
        {
          operation: 'transactions.v2.delete',
          key: 'key-2',
          payload: { transactionId, expectedVersion: 1 },
          userId,
          spaceId,
        },
        expect.any(Function),
      );
    });

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

  describe('history', () => {
    const query = (overrides: Partial<TransactionFeedQueryV2Dto> = {}): TransactionFeedQueryV2Dto => ({
      from: '2026-09-30T21:00:00.000Z',
      to: '2026-10-31T20:59:59.999Z',
      time_zone: 'Europe/Moscow',
      limit: 50,
      ...overrides,
    });

    it('reads the feed of the selection with the assignment, as v2 views', async () => {
      const feed = await service.getFeed(userId, spaceId, query({ assignment: 'member:44', q: ' tea ' }));

      expect(queries.getFeedPage).toHaveBeenCalledWith(
        {
          spaceId,
          from: new Date('2026-09-30T21:00:00.000Z'),
          to: new Date('2026-10-31T20:59:59.999Z'),
          filters: expect.objectContaining({
            assignment: { kind: AssignmentKind.MEMBER, userId: former },
            search: ' tea ',
          }),
        },
        { limit: 50 },
        manager,
      );
      expect(feed.summary).toEqual({ count: 1, income: '0.00', expense: '12.30' });
      expect(feed.day_totals).toEqual([{ date: '2026-01-01', net: '-12.30' }]);
    });

    const rows = (count: number, prefix: string) =>
      Array.from({ length: count }, (_, i) => stored({ id: `${prefix}-${i}` }));

    it('reads the first page as limit + 1 rows from the top, without probing newer ones', async () => {
      queries.getFeedPage.mockResolvedValue({ items: rows(5, 'a'), hasMore: true });

      const page = await service.getFeed(userId, spaceId, query({ limit: 5 }));

      expect(queries.getFeedPage).toHaveBeenCalledTimes(1);
      expect(queries.getFeedPage).toHaveBeenCalledWith(expect.anything(), { limit: 5 }, manager);
      expect(page.page_info.previous_cursor).toBeNull();
      expect(page.page_info.next_cursor).toEqual(expect.any(String));
    });

    it('reads a window around a record outward from its position, not from the period start', async () => {
      const target = stored({ id: 'target' });
      const position = { timestamp: target.timestamp, id: target.id };
      queries.getOneInSpace.mockResolvedValue(target);
      queries.findFeedPosition.mockResolvedValue(position);
      queries.getFeedPage
        .mockResolvedValueOnce({ items: rows(4, 'newer'), hasMore: true })
        .mockResolvedValueOnce({ items: rows(1, 'older'), hasMore: false });

      const page = await service.getFeed(userId, spaceId, query({ limit: 5, around_id: transactionId }));

      expect(queries.getFeedPage).toHaveBeenNthCalledWith(
        1,
        expect.anything(),
        { limit: 4, before: position },
        manager,
      );
      expect(queries.getFeedPage).toHaveBeenNthCalledWith(2, expect.anything(), { limit: 4, after: position }, manager);
      expect(page.items.map((item) => item.id)).toEqual(['newer-1', 'newer-2', 'newer-3', 'target', 'older-0']);
      expect(page.page_info.previous_cursor).toEqual(expect.any(String));
      expect(page.page_info.next_cursor).toBeNull();
    });

    it('reads the totals in the snapshot of the rows, one interval per local day of the page', async () => {
      const at = (id: string, timestamp: string) => stored({ id, timestamp: new Date(timestamp) });
      queries.getFeedPage.mockResolvedValue({
        items: [
          at('a', '2026-10-03T20:59:59.999Z'),
          at('b', '2026-10-02T21:00:00.000Z'),
          at('c', '2026-10-02T20:00:00.000Z'),
        ],
        hasMore: false,
      });
      queries.getFeedSummary.mockResolvedValue({ count: 40, income: 1_000_000_000_00n, expense: 5n });
      queries.getFeedIntervalNets.mockResolvedValue([-1230n, 0n]);

      const feed = await service.getFeed(userId, spaceId, query());

      expect(queries.getFeedSummary).toHaveBeenCalledWith(expect.anything(), manager);
      expect(queries.getFeedIntervalNets).toHaveBeenCalledWith(
        expect.anything(),
        [
          { from: new Date('2026-10-02T21:00:00.000Z'), to: new Date('2026-10-03T20:59:59.999Z') },
          { from: new Date('2026-10-01T21:00:00.000Z'), to: new Date('2026-10-02T20:59:59.999Z') },
        ],
        manager,
      );
      expect(feed.summary).toEqual({ count: 40, income: '1000000000.00', expense: '0.05' });
      expect(feed.day_totals).toEqual([
        { date: '2026-10-03', net: '-12.30' },
        { date: '2026-10-02', net: '0.00' },
      ]);
    });

    it('reads no totals for an empty first page: the selection is empty', async () => {
      queries.getFeedPage.mockResolvedValue({ items: [], hasMore: false });

      const feed = await service.getFeed(userId, spaceId, query({ q: 'nothing' }));

      expect(queries.getFeedSummary).not.toHaveBeenCalled();
      expect(queries.getFeedIntervalNets).not.toHaveBeenCalled();
      expect(feed).toMatchObject({
        items: [],
        page_info: { next_cursor: null, previous_cursor: null },
        summary: { count: 0, income: '0.00', expense: '0.00' },
        day_totals: [],
      });
    });

    it('checks the request shape before membership', async () => {
      access.assertMembership.mockRejectedValue(forbidden);

      await expect(service.getFeed(userId, spaceId, query({ cursor: 'bogus' }))).rejects.toThrow(BadRequestException);
      await expect(service.getFeed(userId, spaceId, query({ from: query().to, to: query().from }))).rejects.toThrow(
        BadRequestException,
      );
      expect(access.assertMembership).not.toHaveBeenCalled();
    });

    it('tells a record of the space outside the selection from a missing one', async () => {
      queries.getOneInSpace.mockResolvedValueOnce(null);
      await expect(service.getFeed(userId, spaceId, query({ around_id: transactionId }))).rejects.toMatchObject({
        code: 'TRANSACTION_NOT_FOUND',
      });

      queries.findFeedPosition.mockResolvedValueOnce(null);
      await expect(service.getFeed(userId, spaceId, query({ around_id: transactionId }))).rejects.toMatchObject({
        code: 'TRANSACTION_NOT_IN_FEED',
      });
      await expect(service.getFeed(userId, spaceId, query({ around_id: 'nope' }))).rejects.toMatchObject({
        code: 'TRANSACTION_NOT_FOUND',
      });
    });

    it('refuses a member filter of a user the space does not know', async () => {
      queries.isKnownAssignee.mockResolvedValue(false);

      await expect(service.getFeed(userId, spaceId, query({ assignment: 'member:99' }))).rejects.toMatchObject(
        new HttpException(ErrorMessages.FORBIDDEN_MEMBER, 403),
      );
      await expect(service.count(userId, spaceId, { ...query(), assignment: 'member:99' })).rejects.toMatchObject(
        new HttpException(ErrorMessages.FORBIDDEN_MEMBER, 403),
      );
      expect(queries.isKnownAssignee).toHaveBeenCalledWith(spaceId, 99);
    });

    it('takes the space, unassigned and deleted accounts without asking about users', async () => {
      for (const assignment of ['space', 'unassigned', 'deleted_member']) {
        await service.count(userId, spaceId, { ...query(), assignment });
      }

      expect(queries.isKnownAssignee).not.toHaveBeenCalled();
      expect(queries.countSelection).toHaveBeenLastCalledWith(
        expect.objectContaining({ filters: expect.objectContaining({ assignment: { kind: 'deleted_member' } }) }),
      );
    });

    it('refuses a foreign category filter and from after to', async () => {
      categories.getOne.mockResolvedValue(buildCategory({ id: 3, space_id: 99 }));
      await expect(service.count(userId, spaceId, { ...query(), category_id: 3 })).rejects.toMatchObject(
        new HttpException(ErrorMessages.FORBIDDEN_CATEGORY, 403),
      );

      await expect(
        service.count(userId, spaceId, { ...query(), from: '2026-11-01T00:00:00.000Z' }),
      ).rejects.toMatchObject({ response: { message: [{ field: 'from', error: 'from must not be after to' }] } });
    });

    it('counts the same selection', async () => {
      await expect(service.count(userId, spaceId, { ...query(), kind: undefined })).resolves.toEqual({ count: 3 });
    });

    it('lists the assignee options: members in order, former members by name, deleted accounts', async () => {
      await expect(service.getAssignees(userId, spaceId)).resolves.toEqual({
        members: [
          { key: 'member:1', user_id: userId, name: 'Zakhar', status: PersonStatus.MEMBER },
          { key: 'member:31', user_id: lena, name: 'Lena', status: PersonStatus.MEMBER },
        ],
        former_members: [
          { key: 'member:44', user_id: former, name: 'Mark', status: PersonStatus.FORMER_MEMBER },
          { key: 'member:52', user_id: 52, name: 'Zoe', status: PersonStatus.FORMER_MEMBER },
        ],
        has_deleted_members: true,
      });
    });
  });
});
