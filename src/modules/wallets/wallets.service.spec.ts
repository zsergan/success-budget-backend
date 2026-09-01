import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { WalletsService } from './wallets.service';
import { Wallet } from '../../entities/wallet.entity';
import { TransactionType } from '../../shared/enums';

describe('WalletsService', () => {
  let service: WalletsService;
  let repository: jest.Mocked<Repository<Wallet>>;

  beforeEach(async () => {
    const queryBuilder = {
      innerJoinAndSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      getMany: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WalletsService,
        {
          provide: getRepositoryToken(Wallet),
          useValue: {
            findOne: jest.fn(),
            create: jest.fn(),
            save: jest.fn(),
            update: jest.fn(),
            createQueryBuilder: jest.fn().mockReturnValue(queryBuilder),
          },
        },
      ],
    }).compile();

    service = module.get(WalletsService);
    repository = module.get(getRepositoryToken(Wallet));
  });

  describe('getOne', () => {
    it('finds a wallet by id', async () => {
      const wallet = { id: 1 } as Wallet;
      repository.findOne.mockResolvedValue(wallet);

      const result = await service.getOne(1);

      expect(repository.findOne).toHaveBeenCalledWith({ where: { id: 1 } });
      expect(result).toBe(wallet);
    });
  });

  describe('getAll', () => {
    it('returns only non-deleted wallets for the user', async () => {
      const wallets = [{ id: 1 }] as Wallet[];
      const queryBuilder = repository.createQueryBuilder();
      (queryBuilder.getMany as jest.Mock).mockResolvedValue(wallets);

      const result = await service.getAll(9);

      expect(queryBuilder.where).toHaveBeenCalledWith({ user_id: 9, is_deleted: 0 });
      expect(result).toBe(wallets);
    });
  });

  describe('create', () => {
    it('creates and persists a wallet for the user', async () => {
      const dto = { wallet_name: 'Cash', balance: 0, currency_id: 1 } as any;
      const created = { ...dto, user_id: 5 } as Wallet;
      repository.create.mockReturnValue(created);

      const result = await service.create(5, dto);

      expect(repository.create).toHaveBeenCalledWith({ ...dto, user_id: 5 });
      expect(repository.save).toHaveBeenCalledWith(created);
      expect(result).toBe(created);
    });
  });

  describe('update', () => {
    it('updates the wallet by id', async () => {
      await service.update(1, { wallet_name: 'Renamed' } as any);

      expect(repository.update).toHaveBeenCalledWith({ id: 1 }, { wallet_name: 'Renamed' });
    });
  });

  describe('delete', () => {
    it('soft-deletes the wallet', async () => {
      await service.delete(1);

      expect(repository.update).toHaveBeenCalledWith({ id: 1 }, expect.objectContaining({ is_deleted: 1 }));
    });
  });

  describe('summarize', () => {
    it('aggregates spend and income per wallet from its own transactions', () => {
      const wallets = [{ id: 1 }, { id: 2 }] as Wallet[];
      const transactions = [
        { wallet_id: 1, transaction_type: TransactionType.INCOME, amount: '100' },
        { wallet_id: 1, transaction_type: TransactionType.EXPENSE, amount: '30' },
      ] as any;

      const result = service.summarize(wallets, transactions);

      expect(result[0]).toMatchObject({ total_income: 100, total_spend: 30 });
      expect(result[1]).toMatchObject({ total_income: 0, total_spend: 0 });
    });
  });
});
