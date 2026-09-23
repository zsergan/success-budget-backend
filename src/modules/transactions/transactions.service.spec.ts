import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { TransactionsService } from './transactions.service';
import { Transaction } from '@entities/transaction.entity';
import { Wallet } from '@entities/wallet.entity';
import { TransactionType } from '@shared/enums';
import { TransactionQueriesService } from '@modules/transaction-queries/transaction-queries.service';

describe('TransactionsService', () => {
  let service: TransactionsService;
  let transactionRepository: { create: jest.Mock; save: jest.Mock; delete: jest.Mock };
  let transactionQueriesService: { getBalances: jest.Mock };

  beforeEach(async () => {
    transactionRepository = {
      create: jest.fn((entity) => entity),
      save: jest.fn(),
      delete: jest.fn(),
    };
    transactionQueriesService = { getBalances: jest.fn(async (ids: number[]) => new Map(ids.map((id) => [id, 0]))) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TransactionsService,
        { provide: getRepositoryToken(Transaction), useValue: transactionRepository },
        { provide: TransactionQueriesService, useValue: transactionQueriesService },
      ],
    }).compile();

    service = module.get(TransactionsService);
  });

  describe('create', () => {
    it('creates the transaction and derives the wallet balance from its previous history', async () => {
      const wallet = { id: 1 } as Wallet;
      transactionQueriesService.getBalances.mockResolvedValue(new Map([[1, 100]]));
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
      expect(transactionQueriesService.getBalances).toHaveBeenCalledWith([1]);
    });

    it('subtracts the amount for an expense transaction', async () => {
      const wallet = { id: 1 } as Wallet;
      transactionQueriesService.getBalances.mockResolvedValue(new Map([[1, 100]]));
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
});
