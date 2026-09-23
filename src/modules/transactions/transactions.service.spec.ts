import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { TransactionsService } from './transactions.service';
import { Transaction } from '@entities/transaction.entity';
import { Wallet } from '@entities/wallet.entity';
import { TransactionType } from '@shared/enums';

describe('TransactionsService', () => {
  let service: TransactionsService;
  let queryBuilder: Record<string, jest.Mock>;
  let transactionRepository: { create: jest.Mock; save: jest.Mock; delete: jest.Mock; createQueryBuilder: jest.Mock };

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
      create: jest.fn((entity) => entity),
      save: jest.fn(),
      delete: jest.fn(),
      createQueryBuilder: jest.fn().mockReturnValue(queryBuilder),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [TransactionsService, { provide: getRepositoryToken(Transaction), useValue: transactionRepository }],
    }).compile();

    service = module.get(TransactionsService);
  });

  describe('create', () => {
    it('creates the transaction and derives the wallet balance from its previous history', async () => {
      const wallet = { id: 1 } as Wallet;
      queryBuilder.getRawMany.mockResolvedValue([{ wallet_id: '1', balance: '100' }]);
      const dto = { wallet_id: 1, amount: 10, transaction_type: TransactionType.INCOME } as any;
      transactionRepository.save.mockResolvedValue({ ...dto, id: 'tx-1' });

      const result = await service.create(wallet, dto);

      expect(transactionRepository.create).toHaveBeenCalledWith(dto);
      expect(transactionRepository.save).toHaveBeenCalledWith(dto);
      expect(result).toEqual({
        transaction: { ...dto, id: 'tx-1' },
        wallet: { id: 1, balance: 110 },
        previous_balance: 100,
      });
      expect(result.wallet).toBe(wallet);
    });

    it('subtracts the amount for an expense transaction', async () => {
      const wallet = { id: 1 } as Wallet;
      queryBuilder.getRawMany.mockResolvedValue([{ wallet_id: '1', balance: '100' }]);
      const dto = { wallet_id: 1, amount: 30, transaction_type: TransactionType.EXPENSE } as any;
      transactionRepository.save.mockResolvedValue(dto);

      const result = await service.create(wallet, dto);

      expect(result.previous_balance).toBe(100);
      expect(result.wallet.balance).toBe(70);
    });

    it('starts from a balance of 0 when the wallet has no transactions yet', async () => {
      const wallet = { id: 1 } as Wallet;
      const dto = { wallet_id: 1, amount: 50, transaction_type: TransactionType.INCOME } as any;
      transactionRepository.save.mockResolvedValue(dto);

      const result = await service.create(wallet, dto);

      expect(result.previous_balance).toBe(0);
      expect(result.wallet.balance).toBe(50);
    });
  });

  describe('remove', () => {
    it('deletes the transaction with no wallet-side effect', async () => {
      const transaction = { id: 'tx-1', wallet_id: 1, amount: 50, transaction_type: TransactionType.INCOME } as any;

      await service.remove(transaction);

      expect(transactionRepository.delete).toHaveBeenCalledWith('tx-1');
    });
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
          [1, 0],
          [2, 0],
        ]),
      );
    });

    it('sums income and expense transactions per wallet', async () => {
      queryBuilder.getRawMany.mockResolvedValue([
        { wallet_id: '1', balance: '150' },
        { wallet_id: '2', balance: '-20' },
      ]);

      const result = await service.getBalances([1, 2, 3]);

      expect(queryBuilder.where).toHaveBeenCalledWith('transaction.wallet_id IN (:...walletIds)', {
        walletIds: [1, 2, 3],
      });
      expect(queryBuilder.setParameter).toHaveBeenCalledWith('income', TransactionType.INCOME);
      expect(queryBuilder.groupBy).toHaveBeenCalledWith('transaction.wallet_id');
      expect(result).toEqual(
        new Map([
          [1, 150],
          [2, -20],
          [3, 0],
        ]),
      );
    });
  });

  describe('getAll', () => {
    it('filters transactions by wallet and date range', async () => {
      const from = new Date('2026-01-01');
      const to = new Date('2026-01-31');
      queryBuilder.getMany.mockResolvedValue([]);

      await service.getAll(5, from, to);

      expect(queryBuilder.where).toHaveBeenCalledWith({ wallet_id: 5 });
      expect(queryBuilder.andWhere).toHaveBeenNthCalledWith(1, 'transaction.timestamp >= :from', { from });
      expect(queryBuilder.andWhere).toHaveBeenNthCalledWith(2, 'transaction.timestamp <= :to', { to });
    });
  });

  describe('getWalletTotals', () => {
    it('returns an all-zero map without querying when there are no wallets', async () => {
      const result = await service.getWalletTotals([], new Date(), new Date());

      expect(result).toEqual(new Map());
      expect(transactionRepository.createQueryBuilder).not.toHaveBeenCalled();
    });

    it('defaults every requested wallet to zero totals when none has transactions', async () => {
      const result = await service.getWalletTotals([1, 2], new Date(), new Date());

      expect(result).toEqual(
        new Map([
          [1, { balance: 0, period_income: 0, period_spend: 0 }],
          [2, { balance: 0, period_income: 0, period_spend: 0 }],
        ]),
      );
    });

    it('combines the all-time balance and period income/spend in one grouped query', async () => {
      const from = new Date('2026-01-01');
      const to = new Date('2026-01-31');
      queryBuilder.getRawMany.mockResolvedValue([
        { wallet_id: '1', balance: '1000', period_income: '200', period_spend: '0' },
        { wallet_id: '2', balance: '500', period_income: '0', period_spend: '50' },
      ]);

      const result = await service.getWalletTotals([1, 2, 3], from, to);

      expect(queryBuilder.where).toHaveBeenCalledWith('transaction.wallet_id IN (:...walletIds)', {
        walletIds: [1, 2, 3],
      });
      expect(queryBuilder.setParameter).toHaveBeenCalledWith('from', from);
      expect(queryBuilder.setParameter).toHaveBeenCalledWith('to', to);
      expect(queryBuilder.groupBy).toHaveBeenCalledWith('transaction.wallet_id');
      expect(result).toEqual(
        new Map([
          [1, { balance: 1000, period_income: 200, period_spend: 0 }],
          [2, { balance: 500, period_income: 0, period_spend: 50 }],
          [3, { balance: 0, period_income: 0, period_spend: 0 }],
        ]),
      );
    });
  });

  describe('getExpenseTotals', () => {
    it('sums expenses per category and overall for a space in one grouped query', async () => {
      const from = new Date('2026-01-01');
      const to = new Date('2026-01-31');
      queryBuilder.getRawMany.mockResolvedValue([
        { category_id: 10, spent: '350' },
        { category_id: 20, spent: '50' },
      ]);

      const result = await service.getExpenseTotals(9, from, to);

      expect(queryBuilder.innerJoin).toHaveBeenCalledWith('transaction.wallet', 'wallet');
      expect(queryBuilder.where).toHaveBeenCalledWith('wallet.space_id = :spaceId', { spaceId: 9 });
      expect(queryBuilder.andWhere).toHaveBeenCalledWith('transaction.transaction_type = :expense', {
        expense: TransactionType.EXPENSE,
      });
      expect(queryBuilder.groupBy).toHaveBeenCalledWith('transaction.category_id');
      expect(result.total).toBe(400);
      expect(result.byCategory).toEqual(
        new Map([
          [10, 350],
          [20, 50],
        ]),
      );
    });

    it('returns a zero total and an empty map when there are no expenses', async () => {
      const result = await service.getExpenseTotals(9, new Date(), new Date());

      expect(result.total).toBe(0);
      expect(result.byCategory).toEqual(new Map());
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
