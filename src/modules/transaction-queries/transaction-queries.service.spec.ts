import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import type { EntityManager } from 'typeorm';

import { TransactionQueriesService, type TransactionFilters, toSearchPattern } from './transaction-queries.service';
import { Transaction } from '@entities/transaction.entity';
import { AssignmentKind, TransactionKind, TransactionType } from '@shared/enums';

describe('TransactionQueriesService', () => {
  let service: TransactionQueriesService;
  let queryBuilder: Record<string, jest.Mock>;
  let transactionRepository: { createQueryBuilder: jest.Mock; manager: { createQueryBuilder: jest.Mock } };
  let manager: EntityManager;

  beforeEach(async () => {
    queryBuilder = {
      select: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      innerJoin: jest.fn().mockReturnThis(),
      innerJoinAndSelect: jest.fn().mockReturnThis(),
      leftJoin: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      setParameter: jest.fn().mockReturnThis(),
      setParameters: jest.fn().mockReturnThis(),
      groupBy: jest.fn().mockReturnThis(),
      addGroupBy: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      addOrderBy: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      getMany: jest.fn(),
      getOne: jest.fn(),
      getCount: jest.fn(),
      getExists: jest.fn().mockResolvedValue(false),
      getRawMany: jest.fn().mockResolvedValue([]),
      getRawOne: jest.fn(),
    };

    manager = { createQueryBuilder: jest.fn().mockReturnValue(queryBuilder) } as unknown as EntityManager;
    transactionRepository = {
      createQueryBuilder: jest.fn().mockReturnValue(queryBuilder),
      manager: { createQueryBuilder: jest.fn().mockReturnValue(queryBuilder) },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TransactionQueriesService,
        { provide: getRepositoryToken(Transaction), useValue: transactionRepository },
      ],
    }).compile();

    service = module.get(TransactionQueriesService);
  });

  describe('getExpensesByCategory', () => {
    it('keeps a SUM above the single-amount range exact', async () => {
      queryBuilder.getRawMany.mockResolvedValue([{ category_id: 1, spent: '1234567890123.45' }]);

      const result = await service.getExpensesByCategory(9, new Date(), new Date());

      expect(result.get(1)).toBe(123456789012345n);
    });

    it('sums expenses per category for a space in one grouped query', async () => {
      const from = new Date('2026-01-01');
      const to = new Date('2026-01-31');
      queryBuilder.getRawMany.mockResolvedValue([
        { category_id: 10, spent: '350.29' },
        { category_id: 20, spent: '50.00' },
      ]);

      const result = await service.getExpensesByCategory(9, from, to);

      expect(queryBuilder.innerJoin).not.toHaveBeenCalled();
      expect(queryBuilder.where).toHaveBeenCalledWith('transaction.space_id = :spaceId', { spaceId: 9 });
      expect(queryBuilder.andWhere).toHaveBeenCalledWith('transaction.transaction_type = :expense', {
        expense: TransactionType.EXPENSE,
      });
      expect(queryBuilder.groupBy).toHaveBeenCalledWith('transaction.category_id');
      expect(result).toEqual(
        new Map([
          [10, 35029n],
          [20, 5000n],
        ]),
      );
    });

    it('returns an empty map when there are no expenses', async () => {
      const result = await service.getExpensesByCategory(9, new Date(), new Date());

      expect(result).toEqual(new Map());
    });
  });

  const count = (filters: TransactionFilters = {}, from = new Date('2026-01-01'), to = new Date('2026-01-31')) =>
    service.countSelection({ spaceId: 9, from, to, filters });

  describe('countSelection', () => {
    beforeEach(() => queryBuilder.getCount.mockResolvedValue(0));

    it.each([
      [
        'beyond both ends',
        '1960-01-01T00:00:00.000Z',
        '2100-01-01T00:00:00.000Z',
        '1970-01-01T00:00:01.000Z',
        '2038-01-19T03:14:07.999Z',
      ],
      [
        'ending inside the last stored second',
        '2038-01-19T03:14:07.000Z',
        '2038-01-19T03:14:07.500Z',
        '2038-01-19T03:14:07.000Z',
        '2038-01-19T03:14:07.500Z',
      ],
      [
        'starting at the last stored millisecond',
        '2038-01-19T03:14:07.999Z',
        '2100-01-01T00:00:00.000Z',
        '2038-01-19T03:14:07.999Z',
        '2038-01-19T03:14:07.999Z',
      ],
    ])('bounds a period %s by what a TIMESTAMP(3) column holds', async (_, from, to, storedFrom, storedTo) => {
      await count({}, new Date(from), new Date(to));

      expect(queryBuilder.andWhere).toHaveBeenCalledWith('transaction.timestamp >= :from', {
        from: new Date(storedFrom),
      });
      expect(queryBuilder.andWhere).toHaveBeenCalledWith('transaction.timestamp <= :to', { to: new Date(storedTo) });
      expect(queryBuilder.andWhere).not.toHaveBeenCalledWith('FALSE');
    });

    it.each([
      ['after the last stored millisecond', '2038-01-19T03:14:08.000Z', '2100-01-01T00:00:00.000Z'],
      ['before the first stored second', '1960-01-01T00:00:00.000Z', '1970-01-01T00:00:00.999Z'],
    ])('selects nothing for a period wholly %s', async (_, from, to) => {
      await count({}, new Date(from), new Date(to));

      expect(queryBuilder.andWhere).toHaveBeenCalledWith('FALSE');
    });

    it('counts the records of the space by their own space', async () => {
      await count();

      expect(queryBuilder.where).toHaveBeenCalledWith('transaction.space_id = :spaceId', { spaceId: 9 });
      expect(queryBuilder.innerJoin).toHaveBeenCalledWith('transaction.category', 'category');
      expect(queryBuilder.innerJoin).toHaveBeenCalledTimes(1);
      expect(queryBuilder.andWhere).toHaveBeenCalledTimes(2);
    });

    it('adds only the filters that are set', async () => {
      await count({ transactionType: TransactionType.EXPENSE });

      expect(queryBuilder.andWhere).toHaveBeenCalledWith('transaction.transaction_type = :transactionType', {
        transactionType: 'expense',
      });
      expect(queryBuilder.andWhere).toHaveBeenCalledTimes(3);
      expect(queryBuilder.andWhere).not.toHaveBeenCalledWith(
        'transaction.category_id = :categoryId',
        expect.anything(),
      );
      expect(queryBuilder.andWhere).not.toHaveBeenCalledWith(expect.stringContaining('is_system'));
      expect(queryBuilder.andWhere).not.toHaveBeenCalledWith(expect.stringContaining('assignment'), expect.anything());
    });

    it.each([
      [TransactionKind.REGULAR, 'category.is_system = 0'],
      [TransactionKind.INITIAL_BALANCE, 'category.is_system = 1'],
    ])('filters kind %s by the system flag of the category', async (kind, condition) => {
      await count({ kind });

      expect(queryBuilder.andWhere).toHaveBeenCalledWith(condition);
    });

    it('counts the joined selection without loading rows', async () => {
      queryBuilder.getCount.mockResolvedValue(4);

      await expect(count({ categoryId: 5, kind: TransactionKind.REGULAR })).resolves.toBe(4);

      expect(queryBuilder.andWhere).toHaveBeenCalledWith('category.is_system = 0');
      expect(queryBuilder.andWhere).toHaveBeenCalledWith('transaction.category_id = :categoryId', { categoryId: 5 });
      expect(queryBuilder.getMany).not.toHaveBeenCalled();
    });

    it('takes a member assignment by its user, former members alike', async () => {
      await count({ assignment: { kind: AssignmentKind.MEMBER, userId: 31 } });

      expect(queryBuilder.andWhere).toHaveBeenCalledWith('transaction.assignment_kind = :assignmentKind', {
        assignmentKind: 'member',
      });
      expect(queryBuilder.andWhere).toHaveBeenCalledWith('transaction.assigned_user_id = :assignedUserId', {
        assignedUserId: 31,
      });
    });

    it('takes the member assignments of deleted accounts apart from unassigned records', async () => {
      await count({ assignment: { kind: 'deleted_member' } });

      expect(queryBuilder.andWhere).toHaveBeenCalledWith('transaction.assignment_kind = :assignmentKind', {
        assignmentKind: 'member',
      });
      expect(queryBuilder.andWhere).toHaveBeenCalledWith('transaction.assigned_user_id IS NULL');
    });

    it.each([AssignmentKind.SPACE, AssignmentKind.UNASSIGNED] as const)('takes %s by its kind alone', async (kind) => {
      await count({ assignment: { kind } });

      expect(queryBuilder.andWhere).toHaveBeenCalledWith('transaction.assignment_kind = :assignmentKind', {
        assignmentKind: kind,
      });
      expect(queryBuilder.andWhere).not.toHaveBeenCalledWith(expect.stringContaining('assigned_user_id'));
    });
  });

  describe('search', () => {
    it.each([
      ['coffee', '%coffee%'],
      ['100%', '%100!%%'],
      ['a_b', '%a!_b%'],
      ['wow!', '%wow!!%'],
      ['back\\slash', '%back\\slash%'],
    ])('escapes %p as %p', (search, pattern) => {
      expect(toSearchPattern(search)).toBe(pattern);
    });

    const searchCondition = () => queryBuilder.andWhere.mock.calls.find(([sql]) => String(sql).includes('LIKE'));

    it('binds the trimmed text and compares descriptions and category names in a fixed collation', async () => {
      queryBuilder.getCount.mockResolvedValue(0);

      await count({ search: '  latte ' });

      const [condition, parameters] = searchCondition();
      expect(parameters).toEqual({ searchPattern: '%latte%' });
      expect(condition).toContain('transaction.description');
      expect(condition).toContain('category.name');
      expect(condition.match(/COLLATE utf8mb4_0900_ai_ci/g)).toHaveLength(4);
      expect(condition).not.toContain('latte');
    });

    it('adds no text condition for blank text', async () => {
      queryBuilder.getCount.mockResolvedValue(0);

      await count({ search: '   ' });

      expect(queryBuilder.andWhere).toHaveBeenCalledTimes(2);
    });
  });

  describe('getFeedPage', () => {
    const selection = { spaceId: 9, from: new Date('2026-01-01'), to: new Date('2026-01-31') };

    it('reads one more id than the page in the history order, then loads the page', async () => {
      queryBuilder.getRawMany.mockResolvedValueOnce([{ id: 'b' }, { id: 'a' }, { id: 'z' }]);
      queryBuilder.getMany.mockResolvedValue([
        { id: 'a', category: {} },
        { id: 'b', category: {} },
      ]);

      const page = await service.getFeedPage(selection, { limit: 2 });

      expect(queryBuilder.orderBy).toHaveBeenCalledWith('transaction.timestamp', 'DESC');
      expect(queryBuilder.addOrderBy).toHaveBeenCalledWith('transaction.id', 'DESC');
      expect(queryBuilder.limit).toHaveBeenCalledWith(3);
      expect(page.items.map((item) => item.id)).toEqual(['b', 'a']);
      expect(page.hasMore).toBe(true);
    });

    it('reads newer records upwards from a position and lists them newest first', async () => {
      const position = { timestamp: new Date('2026-01-10T00:00:00Z'), id: 'm' };
      queryBuilder.getRawMany.mockResolvedValueOnce([{ id: 'n' }, { id: 'o' }]);
      queryBuilder.getMany.mockResolvedValue([
        { id: 'n', category: {} },
        { id: 'o', category: {} },
      ]);

      const page = await service.getFeedPage(selection, { limit: 5, before: position });

      expect(queryBuilder.andWhere).toHaveBeenCalledWith(
        'transaction.timestamp >= :positionTimestamp AND ' +
          '(transaction.timestamp > :positionTimestamp OR transaction.id > :positionId)',
        { positionTimestamp: position.timestamp, positionId: 'm' },
      );
      expect(queryBuilder.orderBy).toHaveBeenCalledWith('transaction.timestamp', 'ASC');
      expect(page.items.map((item) => item.id)).toEqual(['o', 'n']);
      expect(page.hasMore).toBe(false);
    });
  });

  describe('people', () => {
    it('lists the members in joining order', async () => {
      queryBuilder.getRawMany.mockResolvedValue([{ user_id: '31', name: 'Lena' }]);

      await expect(service.getMembers(9)).resolves.toEqual([{ userId: 31, name: 'Lena' }]);
      expect(queryBuilder.orderBy).toHaveBeenCalledWith('member.created_at', 'ASC');
      expect(queryBuilder.addOrderBy).toHaveBeenCalledWith('member.id', 'ASC');
    });

    it('lists the existing users with records assigned to them', async () => {
      queryBuilder.getRawMany.mockResolvedValue([{ user_id: '44', name: 'Mark' }]);

      await expect(service.getAssignedUsers(9)).resolves.toEqual([{ userId: 44, name: 'Mark' }]);
      expect(queryBuilder.innerJoin).toHaveBeenCalledWith('transaction.assignedUser', 'assignedUser');
      expect(queryBuilder.groupBy).toHaveBeenCalledWith('transaction.assigned_user_id');
    });

    it('tells whether records are assigned to deleted accounts', async () => {
      queryBuilder.getExists.mockResolvedValue(true);

      await expect(service.hasDeletedAssignees(9)).resolves.toBe(true);
      expect(queryBuilder.andWhere).toHaveBeenCalledWith('transaction.assigned_user_id IS NULL');
    });

    it('knows a member, and a former member by their assignments', async () => {
      queryBuilder.getRawMany.mockResolvedValue([{ user_id: 31 }]);

      await expect(service.isKnownAssignee(9, 31)).resolves.toBe(true);
      expect(queryBuilder.getExists).not.toHaveBeenCalled();

      queryBuilder.getExists.mockResolvedValue(true);
      await expect(service.isKnownAssignee(9, 44)).resolves.toBe(true);
      expect(queryBuilder.andWhere).toHaveBeenCalledWith('transaction.assigned_user_id = :userId', { userId: 44 });
    });
  });

  describe('getOneInSpace', () => {
    it('loads the transaction with its relations, scoped by its own space', async () => {
      queryBuilder.getOne.mockResolvedValue(null);

      expect(await service.getOneInSpace(9, 'tx-1')).toBeNull();

      expect(queryBuilder.innerJoinAndSelect).toHaveBeenCalledTimes(1);
      expect(queryBuilder.innerJoinAndSelect).toHaveBeenCalledWith('transaction.category', 'category');
      expect(queryBuilder.where).toHaveBeenCalledWith('transaction.id = :transactionId', { transactionId: 'tx-1' });
      expect(queryBuilder.andWhere).toHaveBeenCalledWith('transaction.space_id = :spaceId', { spaceId: 9 });
    });

    it('loads only the id and name of the author and the assignee', async () => {
      queryBuilder.getOne.mockResolvedValue(null);

      await service.getOneInSpace(9, 'tx-1');

      expect(queryBuilder.leftJoin).toHaveBeenCalledWith('transaction.author', 'author');
      expect(queryBuilder.addSelect).toHaveBeenCalledWith(['author.id', 'author.name']);
      expect(queryBuilder.leftJoin).toHaveBeenCalledWith('transaction.assignedUser', 'assignedUser');
      expect(queryBuilder.addSelect).toHaveBeenCalledWith(['assignedUser.id', 'assignedUser.name']);
    });

    it('reads through the given manager', async () => {
      const getRepository = jest.fn().mockReturnValue(transactionRepository);
      queryBuilder.getOne.mockResolvedValue(null);

      await service.getOneInSpace(9, 'tx-1', { getRepository } as unknown as EntityManager);

      expect(getRepository).toHaveBeenCalledWith(Transaction);
    });
  });

  describe('getLatest', () => {
    it('orders by timestamp descending and limits to one row', async () => {
      queryBuilder.getOne.mockResolvedValue(null);

      await service.getLatest(9);

      expect(queryBuilder.where).toHaveBeenCalledWith('transaction.space_id = :spaceId', { spaceId: 9 });
      expect(queryBuilder.orderBy).toHaveBeenCalledWith('transaction.timestamp', 'DESC');
      expect(queryBuilder.addOrderBy).toHaveBeenCalledWith('transaction.id', 'DESC');
      expect(queryBuilder.limit).toHaveBeenCalledWith(1);
    });
  });

  describe('getStatisticsTotals', () => {
    const from = new Date('2026-08-31T21:00:00.000Z');
    const to = new Date('2026-09-28T12:00:00.000Z');

    it('scopes to the space without starting balances, both bounds inclusive', async () => {
      queryBuilder.getRawOne.mockResolvedValue({
        income: '3000.00',
        income_count: '1',
        expense: '810.50',
        expense_count: '9',
      });

      const result = await service.getStatisticsTotals(7, from, to, manager);

      expect(result).toEqual({ income: 300000n, incomeCount: 1, expense: 81050n, expenseCount: 9 });
      expect(manager.createQueryBuilder).toHaveBeenCalledWith(Transaction, 'transaction');
      expect(transactionRepository.createQueryBuilder).not.toHaveBeenCalled();
      expect(queryBuilder.innerJoin).toHaveBeenCalledTimes(1);
      expect(queryBuilder.innerJoin).toHaveBeenCalledWith('transaction.category', 'category');
      expect(queryBuilder.where).toHaveBeenCalledWith('transaction.space_id = :spaceId', { spaceId: 7 });
      expect(queryBuilder.andWhere).toHaveBeenCalledWith('category.is_system = 0');
      expect(queryBuilder.andWhere).toHaveBeenCalledWith('transaction.timestamp >= :from', { from });
      expect(queryBuilder.andWhere).toHaveBeenCalledWith('transaction.timestamp <= :to', { to });
      expect(queryBuilder.andWhere).not.toHaveBeenCalledWith(expect.stringContaining('is_deleted'));
    });

    it('reads the NULL sums of an empty selection as zero', async () => {
      queryBuilder.getRawOne.mockResolvedValue({
        income: null,
        income_count: null,
        expense: null,
        expense_count: null,
      });

      const result = await service.getStatisticsTotals(7, from, to, manager);

      expect(result).toEqual({ income: 0n, incomeCount: 0, expense: 0n, expenseCount: 0 });
    });
  });

  describe('getStatisticsIntervalTotals', () => {
    const from = new Date('2026-08-31T21:00:00.000Z');
    const to = new Date('2026-09-28T12:00:00.000Z');
    const ends = [new Date('2026-09-06T20:59:59.999Z'), new Date('2026-09-13T20:59:59.999Z'), to];

    it('maps each transaction to its interval in one grouped query and fills the gaps with zeros', async () => {
      queryBuilder.getRawMany.mockResolvedValue([
        { interval_index: '2', income: '0.00', income_count: '0', expense: '10.00', expense_count: '1' },
        { interval_index: '0', income: '3000.00', income_count: '1', expense: '570.25', expense_count: '2' },
      ]);

      const result = await service.getStatisticsIntervalTotals(7, from, to, ends);

      expect(result).toEqual([
        { income: 300000n, incomeCount: 1, expense: 57025n, expenseCount: 2 },
        { income: 0n, incomeCount: 0, expense: 0n, expenseCount: 0 },
        { income: 0n, incomeCount: 0, expense: 1000n, expenseCount: 1 },
      ]);
      expect(queryBuilder.addSelect).toHaveBeenCalledWith(
        'CASE WHEN transaction.timestamp <= :intervalEnd0 THEN 0 WHEN transaction.timestamp <= :intervalEnd1 THEN 1 ELSE 2 END',
        'interval_index',
      );
      expect(queryBuilder.setParameters).toHaveBeenCalledWith({ intervalEnd0: ends[0], intervalEnd1: ends[1] });
      expect(queryBuilder.groupBy).toHaveBeenCalledWith('interval_index');
      expect(queryBuilder.andWhere).toHaveBeenCalledWith('transaction.timestamp <= :to', { to });
    });

    it('puts everything into a single interval', async () => {
      queryBuilder.getRawMany.mockResolvedValue([
        { interval_index: 0, income: null, income_count: null, expense: '5.00', expense_count: '1' },
      ]);

      const result = await service.getStatisticsIntervalTotals(7, from, to, [to]);

      expect(result).toEqual([{ income: 0n, incomeCount: 0, expense: 500n, expenseCount: 1 }]);
      expect(queryBuilder.addSelect).toHaveBeenCalledWith('0', 'interval_index');
    });
  });

  describe('statistics groups', () => {
    const from = new Date('2026-08-31T21:00:00.000Z');
    const to = new Date('2026-09-28T12:00:00.000Z');

    it('sums the transactions of the type per category in SQL', async () => {
      queryBuilder.getRawMany.mockResolvedValue([
        { id: 14, name: 'Gifts', icon: 'gift', color: 'rose', is_active: 0, amount: '80.00', count: '1' },
      ]);

      const result = await service.getStatisticsByCategory(7, TransactionType.EXPENSE, from, to, manager);

      expect(result).toEqual([
        { id: 14, name: 'Gifts', icon: 'gift', color: 'rose', isArchived: true, amount: 8000n, count: 1 },
      ]);
      expect(queryBuilder.andWhere).toHaveBeenCalledWith('category.is_system = 0');
      expect(queryBuilder.andWhere).toHaveBeenCalledWith('transaction.transaction_type = :transactionType', {
        transactionType: 'expense',
      });
      expect(queryBuilder.groupBy).toHaveBeenCalledWith('category.id');
    });
  });

  describe('getStatisticsByAssignment', () => {
    const from = new Date('2026-08-31T21:00:00.000Z');
    const to = new Date('2026-09-28T12:00:00.000Z');

    it('groups by assignment, telling members, former members and deleted accounts apart', async () => {
      queryBuilder.getRawMany.mockResolvedValue([
        { kind: 'member', user_id: '31', name: 'Lena', member_id: '5', amount: '450.00', count: '3' },
        { kind: 'member', user_id: '44', name: 'Mark', member_id: null, amount: '20.00', count: '1' },
        { kind: 'member', user_id: null, name: null, member_id: null, amount: '7.00', count: '1' },
        { kind: 'space', user_id: null, name: null, member_id: null, amount: '1100.00', count: '4' },
        { kind: 'unassigned', user_id: null, name: null, member_id: null, amount: '150.00', count: '2' },
      ]);

      const result = await service.getStatisticsByAssignment(7, TransactionType.EXPENSE, from, to, manager);

      expect(result).toEqual([
        { kind: 'member', userId: 31, name: 'Lena', isMember: true, amount: 45000n, count: 3 },
        { kind: 'member', userId: 44, name: 'Mark', isMember: false, amount: 2000n, count: 1 },
        { kind: 'deleted_member', userId: null, name: null, isMember: false, amount: 700n, count: 1 },
        { kind: 'space', userId: null, name: null, isMember: false, amount: 110000n, count: 4 },
        { kind: 'unassigned', userId: null, name: null, isMember: false, amount: 15000n, count: 2 },
      ]);
      expect(queryBuilder.where).toHaveBeenCalledWith('transaction.space_id = :spaceId', { spaceId: 7 });
      expect(queryBuilder.andWhere).toHaveBeenCalledWith('category.is_system = 0');
      expect(queryBuilder.groupBy).toHaveBeenCalledWith('transaction.assignment_kind');
      expect(queryBuilder.addGroupBy).toHaveBeenCalledWith('transaction.assigned_user_id');
    });
  });

  describe('getLastStatisticsTimestamp', () => {
    const to = new Date('2026-09-28T12:00:00.000Z');

    it('looks at the whole history up to the bound', async () => {
      const timestamp = new Date('2026-09-27T21:30:00.000Z');
      queryBuilder.getOne.mockResolvedValue({ id: 1, timestamp });

      await expect(service.getLastStatisticsTimestamp(7, to, manager)).resolves.toBe(timestamp);
      expect(queryBuilder.andWhere).toHaveBeenCalledWith('category.is_system = 0');
      expect(queryBuilder.andWhere).toHaveBeenCalledWith('transaction.timestamp <= :to', { to });
      expect(queryBuilder.andWhere).not.toHaveBeenCalledWith('transaction.timestamp >= :from', expect.anything());
      expect(queryBuilder.orderBy).toHaveBeenCalledWith('transaction.timestamp', 'DESC');
    });

    it('returns null without transactions', async () => {
      queryBuilder.getOne.mockResolvedValue(null);

      await expect(service.getLastStatisticsTimestamp(7, to, manager)).resolves.toBeNull();
    });
  });
});
