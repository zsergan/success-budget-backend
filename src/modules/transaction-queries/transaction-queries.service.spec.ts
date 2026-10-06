import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import type { EntityManager } from 'typeorm';

import { TransactionQueriesService } from './transaction-queries.service';
import { Transaction } from '@entities/transaction.entity';
import { TransactionType } from '@shared/enums';

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
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      setParameter: jest.fn().mockReturnThis(),
      setParameters: jest.fn().mockReturnThis(),
      groupBy: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      addOrderBy: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      getMany: jest.fn(),
      getOne: jest.fn(),
      getCount: jest.fn(),
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

  describe('getBalances', () => {
    it('returns an empty map without querying when there are no wallets', async () => {
      const result = await service.getBalances([]);

      expect(result).toEqual(new Map());
      expect(transactionRepository.createQueryBuilder).not.toHaveBeenCalled();
    });

    it('defaults every requested wallet to 0 when none has transactions', async () => {
      const result = await service.getBalances([1, 2]);

      expect(result).toEqual(
        new Map([
          [1, 0n],
          [2, 0n],
        ]),
      );
    });

    it('sums income and expense transactions per wallet', async () => {
      queryBuilder.getRawMany.mockResolvedValue([
        { wallet_id: '1', balance: '150.10' },
        { wallet_id: '2', balance: '-20.05' },
      ]);

      const result = await service.getBalances([1, 2, 3]);

      expect(queryBuilder.where).toHaveBeenCalledWith('transaction.wallet_id IN (:...walletIds)', {
        walletIds: [1, 2, 3],
      });
      expect(queryBuilder.setParameter).toHaveBeenCalledWith('income', TransactionType.INCOME);
      expect(queryBuilder.groupBy).toHaveBeenCalledWith('transaction.wallet_id');
      expect(result).toEqual(
        new Map([
          [1, 15010n],
          [2, -2005n],
          [3, 0n],
        ]),
      );
    });
  });

  it('keeps a SUM above the single-amount range exact', async () => {
    queryBuilder.getRawMany.mockResolvedValue([{ wallet_id: '1', balance: '1234567890123.45' }]);

    const result = await service.getBalances([1]);

    expect(result.get(1)).toBe(123456789012345n);
  });

  describe('getPeriodTotals', () => {
    it('leaves initial balances out of income', async () => {
      await service.getPeriodTotals([1], new Date(), new Date());

      expect(queryBuilder.innerJoin).toHaveBeenCalledWith('transaction.category', 'category');
      expect(queryBuilder.andWhere).toHaveBeenCalledWith('category.is_system = 0');
    });

    it('returns an all-zero map without querying when there are no wallets', async () => {
      const result = await service.getPeriodTotals([], new Date(), new Date());

      expect(result).toEqual(new Map());
      expect(transactionRepository.createQueryBuilder).not.toHaveBeenCalled();
    });

    it('defaults every requested wallet to zero totals when none has transactions', async () => {
      const result = await service.getPeriodTotals([1, 2], new Date(), new Date());

      expect(result).toEqual(
        new Map([
          [1, { income: 0n, spend: 0n }],
          [2, { income: 0n, spend: 0n }],
        ]),
      );
    });

    it('sums income and expense transactions per wallet within the date range in one grouped query', async () => {
      const from = new Date('2026-01-01');
      const to = new Date('2026-01-31');
      queryBuilder.getRawMany.mockResolvedValue([
        { wallet_id: '1', income: '200.00', spend: '0.00' },
        { wallet_id: '2', income: '0.00', spend: '50.30' },
      ]);

      const result = await service.getPeriodTotals([1, 2, 3], from, to);

      expect(queryBuilder.where).toHaveBeenCalledWith('transaction.wallet_id IN (:...walletIds)', {
        walletIds: [1, 2, 3],
      });
      expect(queryBuilder.andWhere).toHaveBeenNthCalledWith(2, 'transaction.timestamp >= :from', { from });
      expect(queryBuilder.andWhere).toHaveBeenNthCalledWith(3, 'transaction.timestamp <= :to', { to });
      expect(queryBuilder.groupBy).toHaveBeenCalledWith('transaction.wallet_id');
      expect(result).toEqual(
        new Map([
          [1, { income: 20000n, spend: 0n }],
          [2, { income: 0n, spend: 5030n }],
          [3, { income: 0n, spend: 0n }],
        ]),
      );
    });
  });

  describe('getExpensesByCategory', () => {
    it('sums expenses per category for a space in one grouped query', async () => {
      const from = new Date('2026-01-01');
      const to = new Date('2026-01-31');
      queryBuilder.getRawMany.mockResolvedValue([
        { category_id: 10, spent: '350.29' },
        { category_id: 20, spent: '50.00' },
      ]);

      const result = await service.getExpensesByCategory(9, from, to);

      expect(queryBuilder.innerJoin).toHaveBeenCalledWith('transaction.wallet', 'wallet');
      expect(queryBuilder.where).toHaveBeenCalledWith('wallet.space_id = :spaceId', { spaceId: 9 });
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

  describe('getForAllWallets', () => {
    it('filters transactions across all of a space wallets by date range', async () => {
      const from = new Date('2026-01-01');
      const to = new Date('2026-01-31');
      queryBuilder.getMany.mockResolvedValue([]);

      await service.getForAllWallets(9, from, to);

      expect(queryBuilder.where).toHaveBeenCalledWith('wallet.space_id = :spaceId', { spaceId: 9 });
      expect(queryBuilder.andWhere).toHaveBeenCalledTimes(2);
    });

    it('orders newest first, then by id, so equal timestamps keep one order', async () => {
      queryBuilder.getMany.mockResolvedValue([]);

      await service.getForAllWallets(9, new Date('2026-01-01'), new Date('2026-01-31'));

      expect(queryBuilder.orderBy).toHaveBeenCalledWith('transaction.timestamp', 'DESC');
      expect(queryBuilder.addOrderBy).toHaveBeenCalledWith('transaction.id', 'DESC');
    });

    it('adds only the filters that are set', async () => {
      queryBuilder.getMany.mockResolvedValue([]);

      await service.getForAllWallets(9, new Date('2026-01-01'), new Date('2026-01-31'), {
        transactionType: TransactionType.EXPENSE,
        walletId: 3,
      });

      expect(queryBuilder.andWhere).toHaveBeenCalledWith('transaction.transaction_type = :transactionType', {
        transactionType: 'expense',
      });
      expect(queryBuilder.andWhere).toHaveBeenCalledWith('transaction.wallet_id = :walletId', { walletId: 3 });
      expect(queryBuilder.andWhere).not.toHaveBeenCalledWith(
        'transaction.category_id = :categoryId',
        expect.anything(),
      );
    });
  });

  describe('countForAllWallets', () => {
    it('counts with the same scope and filters as the list, without loading rows', async () => {
      queryBuilder.getCount.mockResolvedValue(4);

      await expect(
        service.countForAllWallets(9, new Date('2026-01-01'), new Date('2026-01-31'), { categoryId: 5 }),
      ).resolves.toBe(4);

      expect(queryBuilder.innerJoin).toHaveBeenCalledWith('transaction.wallet', 'wallet');
      expect(queryBuilder.where).toHaveBeenCalledWith('wallet.space_id = :spaceId', { spaceId: 9 });
      expect(queryBuilder.andWhere).toHaveBeenCalledWith('transaction.category_id = :categoryId', { categoryId: 5 });
      expect(queryBuilder.getMany).not.toHaveBeenCalled();
    });
  });

  describe('getOneInSpace', () => {
    it('loads the transaction with both relations, scoped by its wallet space', async () => {
      queryBuilder.getOne.mockResolvedValue(null);

      expect(await service.getOneInSpace(9, 'tx-1')).toBeNull();

      expect(queryBuilder.innerJoinAndSelect).toHaveBeenCalledWith('transaction.wallet', 'wallet');
      expect(queryBuilder.innerJoinAndSelect).toHaveBeenCalledWith('transaction.category', 'category');
      expect(queryBuilder.where).toHaveBeenCalledWith('transaction.id = :transactionId', { transactionId: 'tx-1' });
      expect(queryBuilder.andWhere).toHaveBeenCalledWith('wallet.space_id = :spaceId', { spaceId: 9 });
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

      expect(queryBuilder.where).toHaveBeenCalledWith('wallet.space_id = :spaceId', { spaceId: 9 });
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
      expect(queryBuilder.innerJoin).toHaveBeenCalledWith('transaction.wallet', 'wallet');
      expect(queryBuilder.innerJoin).toHaveBeenCalledWith('transaction.category', 'category');
      expect(queryBuilder.where).toHaveBeenCalledWith('wallet.space_id = :spaceId', { spaceId: 7 });
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

  describe('statistics expense groups', () => {
    const from = new Date('2026-08-31T21:00:00.000Z');
    const to = new Date('2026-09-28T12:00:00.000Z');

    it('sums expenses per category in SQL', async () => {
      queryBuilder.getRawMany.mockResolvedValue([
        { id: 14, name: 'Gifts', icon: 'gift', color: 'rose', is_active: 0, amount: '80.00', count: '1' },
      ]);

      const result = await service.getStatisticsExpenseByCategory(7, from, to, manager);

      expect(result).toEqual([
        { id: 14, name: 'Gifts', icon: 'gift', color: 'rose', isArchived: true, amount: 8000n, count: 1 },
      ]);
      expect(queryBuilder.andWhere).toHaveBeenCalledWith('category.is_system = 0');
      expect(queryBuilder.andWhere).toHaveBeenCalledWith('transaction.transaction_type = :expense', {
        expense: 'expense',
      });
      expect(queryBuilder.groupBy).toHaveBeenCalledWith('category.id');
    });

    it('sums expenses per wallet, deleted ones included', async () => {
      queryBuilder.getRawMany.mockResolvedValue([
        { id: '3', name: 'Old card', design: 'slate', is_deleted: '1', amount: '105.50', count: '2' },
      ]);

      const result = await service.getStatisticsExpenseByWallet(7, from, to, manager);

      expect(result).toEqual([{ id: 3, name: 'Old card', design: 'slate', isDeleted: true, amount: 10550n, count: 2 }]);
      expect(queryBuilder.groupBy).toHaveBeenCalledWith('wallet.id');
      expect(queryBuilder.andWhere).not.toHaveBeenCalledWith(expect.stringContaining('is_deleted'));
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
