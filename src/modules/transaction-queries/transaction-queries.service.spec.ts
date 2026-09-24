import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { TransactionQueriesService } from './transaction-queries.service';
import { Transaction } from '@entities/transaction.entity';
import { TransactionType } from '@shared/enums';

describe('TransactionQueriesService', () => {
  let service: TransactionQueriesService;
  let queryBuilder: Record<string, jest.Mock>;
  let transactionRepository: { createQueryBuilder: jest.Mock };

  beforeEach(async () => {
    queryBuilder = {
      select: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      innerJoin: jest.fn().mockReturnThis(),
      innerJoinAndSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      setParameter: jest.fn().mockReturnThis(),
      groupBy: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      addOrderBy: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      getMany: jest.fn(),
      getOne: jest.fn(),
      getRawMany: jest.fn().mockResolvedValue([]),
    };

    transactionRepository = {
      createQueryBuilder: jest.fn().mockReturnValue(queryBuilder),
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
      expect(queryBuilder.andWhere).toHaveBeenNthCalledWith(1, 'transaction.timestamp >= :from', { from });
      expect(queryBuilder.andWhere).toHaveBeenNthCalledWith(2, 'transaction.timestamp <= :to', { to });
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
    });
  });

  describe('getOneWithWallet', () => {
    it('loads a transaction with its wallet relation', async () => {
      queryBuilder.getOne.mockResolvedValue(null);

      await service.getOneWithWallet('tx-1');

      expect(queryBuilder.innerJoinAndSelect).toHaveBeenCalledWith('transaction.wallet', 'wallet');
      expect(queryBuilder.where).toHaveBeenCalledWith('transaction.id = :transactionId', { transactionId: 'tx-1' });
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
});
