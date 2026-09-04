import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { TransactionsService } from './transactions.service';
import { Transaction } from '@entities/transaction.entity';
import { Wallet } from '@entities/wallet.entity';
import { TransactionType } from '@shared/enums';

describe('TransactionsService', () => {
  let service: TransactionsService;
  let queryBuilder: Record<string, jest.Mock>;
  let walletRepositoryInTx: { findOne: jest.Mock; update: jest.Mock };
  let transactionRepositoryInTx: { create: jest.Mock; save: jest.Mock };
  let dataSource: { transaction: jest.Mock };
  let transactionRepository: { createQueryBuilder: jest.Mock };

  beforeEach(async () => {
    queryBuilder = {
      innerJoinAndSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      getMany: jest.fn(),
      getOne: jest.fn(),
    };

    walletRepositoryInTx = { findOne: jest.fn(), update: jest.fn() };
    transactionRepositoryInTx = { create: jest.fn(), save: jest.fn() };
    const manager = {
      getRepository: jest.fn((entity) => (entity === Wallet ? walletRepositoryInTx : transactionRepositoryInTx)),
    };
    dataSource = { transaction: jest.fn((callback) => callback(manager)) };
    transactionRepository = {
      createQueryBuilder: jest.fn().mockReturnValue(queryBuilder),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TransactionsService,
        {
          provide: getRepositoryToken(Transaction),
          useValue: {
            create: jest.fn(),
            save: jest.fn(),
            ...transactionRepository,
          },
        },
        { provide: DataSource, useValue: dataSource },
      ],
    }).compile();

    service = module.get(TransactionsService);
  });

  describe('create', () => {
    it('locks the wallet row, applies the balance change, and creates the transaction in one DB transaction', async () => {
      const wallet = { id: 1, balance: 100 };
      walletRepositoryInTx.findOne.mockResolvedValue(wallet);
      const dto = { wallet_id: 1, amount: 10, transaction_type: TransactionType.INCOME } as any;
      const created = { ...dto, currency_id: 3 } as Transaction;
      transactionRepositoryInTx.create.mockReturnValue(created);
      transactionRepositoryInTx.save.mockResolvedValue(created);

      const result = await service.create(1, 3, dto);

      expect(dataSource.transaction).toHaveBeenCalled();
      expect(walletRepositoryInTx.findOne).toHaveBeenCalledWith({
        where: { id: 1 },
        lock: { mode: 'pessimistic_write' },
      });
      expect(walletRepositoryInTx.update).toHaveBeenCalledWith(1, { balance: 110 });
      expect(transactionRepositoryInTx.create).toHaveBeenCalledWith({ ...dto, currency_id: 3 });
      expect(result).toEqual({ transaction: created, wallet: { id: 1, balance: 110 }, previous_balance: 100 });
      expect(result.wallet).toBe(wallet);
    });

    it('subtracts the amount for an expense transaction', async () => {
      walletRepositoryInTx.findOne.mockResolvedValue({ id: 1, balance: 100 });
      const dto = { wallet_id: 1, amount: 30, transaction_type: TransactionType.EXPENSE } as any;
      transactionRepositoryInTx.create.mockReturnValue(dto);
      transactionRepositoryInTx.save.mockResolvedValue(dto);

      const result = await service.create(1, 3, dto);

      expect(walletRepositoryInTx.update).toHaveBeenCalledWith(1, { balance: 70 });
      expect(result.previous_balance).toBe(100);
      expect(result.wallet.balance).toBe(70);
    });
  });

  describe('remove', () => {
    it('reverses an income transaction and deletes it in one DB transaction', async () => {
      walletRepositoryInTx.findOne.mockResolvedValue({ id: 1, balance: 150 });
      (transactionRepositoryInTx as any).delete = jest.fn();
      const transaction = {
        id: 'tx-1',
        wallet_id: 1,
        amount: 50,
        transaction_type: TransactionType.INCOME,
      } as any;

      await service.remove(transaction);

      expect(walletRepositoryInTx.update).toHaveBeenCalledWith(1, { balance: 100 });
      expect((transactionRepositoryInTx as any).delete).toHaveBeenCalledWith('tx-1');
    });

    it('reverses an expense transaction and deletes it in one DB transaction', async () => {
      walletRepositoryInTx.findOne.mockResolvedValue({ id: 1, balance: 100 });
      (transactionRepositoryInTx as any).delete = jest.fn();
      const transaction = {
        id: 'tx-2',
        wallet_id: 1,
        amount: 20,
        transaction_type: TransactionType.EXPENSE,
      } as any;

      await service.remove(transaction);

      expect(walletRepositoryInTx.update).toHaveBeenCalledWith(1, { balance: 120 });
      expect((transactionRepositoryInTx as any).delete).toHaveBeenCalledWith('tx-2');
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

  describe('getAllForWallets', () => {
    it('filters transactions for a set of wallets by date range in one query', async () => {
      const from = new Date('2026-01-01');
      const to = new Date('2026-01-31');
      queryBuilder.getMany.mockResolvedValue([]);

      await service.getAllForWallets([1, 2, 3], from, to);

      expect(queryBuilder.where).toHaveBeenCalledWith('transaction.wallet_id IN (:...walletIds)', {
        walletIds: [1, 2, 3],
      });
      expect(queryBuilder.andWhere).toHaveBeenNthCalledWith(1, 'transaction.timestamp >= :from', { from });
      expect(queryBuilder.andWhere).toHaveBeenNthCalledWith(2, 'transaction.timestamp <= :to', { to });
    });

    it('returns an empty array without querying when there are no wallets', async () => {
      const result = await service.getAllForWallets([], new Date(), new Date());

      expect(result).toEqual([]);
      expect(transactionRepository.createQueryBuilder).not.toHaveBeenCalled();
    });
  });

  describe('getForAllWallets', () => {
    it('filters transactions across all of a user wallets by date range', async () => {
      const from = new Date('2026-01-01');
      const to = new Date('2026-01-31');
      queryBuilder.getMany.mockResolvedValue([]);

      await service.getForAllWallets(9, from, to);

      expect(queryBuilder.where).toHaveBeenCalledWith('wallet.user_id = :userId', { userId: 9 });
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

      expect(queryBuilder.where).toHaveBeenCalledWith('wallet.user_id = :userId', { userId: 9 });
      expect(queryBuilder.orderBy).toHaveBeenCalledWith('transaction.timestamp', 'DESC');
      expect(queryBuilder.limit).toHaveBeenCalledWith(1);
    });
  });
});
