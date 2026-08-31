import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { TransactionsService } from './transactions.service';
import { Transaction } from '../../entities/transaction.entity';

describe('TransactionsService', () => {
  let service: TransactionsService;
  let repository: jest.Mocked<Repository<Transaction>>;
  let queryBuilder: Record<string, jest.Mock>;

  beforeEach(async () => {
    queryBuilder = {
      innerJoinAndSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      getMany: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TransactionsService,
        {
          provide: getRepositoryToken(Transaction),
          useValue: {
            create: jest.fn(),
            save: jest.fn(),
            createQueryBuilder: jest.fn().mockReturnValue(queryBuilder),
          },
        },
      ],
    }).compile();

    service = module.get(TransactionsService);
    repository = module.get(getRepositoryToken(Transaction));
  });

  describe('create', () => {
    it('creates a transaction stamped with the wallet currency', async () => {
      const dto = { wallet_id: 1, amount: 10 } as any;
      const created = { ...dto, currency_id: 3 } as Transaction;
      repository.create.mockReturnValue(created);
      repository.save.mockResolvedValue(created);

      const result = await service.create(3, dto);

      expect(repository.create).toHaveBeenCalledWith({ ...dto, currency_id: 3 });
      expect(result).toBe(created);
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

  describe('getForAllWallets', () => {
    it('filters transactions across all of a user wallets by date range', async () => {
      const from = new Date('2026-01-01');
      const to = new Date('2026-01-31');
      queryBuilder.getMany.mockResolvedValue([]);

      await service.getForAllWallets(9, from, to);

      expect(queryBuilder.where).toHaveBeenCalledWith('wallet.user_id = :userId', { userId: 9 });
    });
  });
});
