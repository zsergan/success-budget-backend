import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';

import { WalletsService } from './wallets.service';
import { Wallet } from '@entities/wallet.entity';
import { Category } from '@entities/category.entity';
import { Transaction } from '@entities/transaction.entity';
import { SpacesService } from '@modules/spaces/spaces.service';
import { TransactionType } from '@shared/enums';

describe('WalletsService', () => {
  let service: WalletsService;
  let repository: jest.Mocked<Repository<Wallet>>;
  let spacesService: jest.Mocked<SpacesService>;
  let walletRepositoryInTx: { create: jest.Mock; save: jest.Mock };
  let categoryRepositoryInTx: { findOneOrFail: jest.Mock };
  let transactionRepositoryInTx: { create: jest.Mock; save: jest.Mock };
  let dataSource: { transaction: jest.Mock };

  beforeEach(async () => {
    const queryBuilder = {
      where: jest.fn().mockReturnThis(),
      getMany: jest.fn(),
    };

    walletRepositoryInTx = { create: jest.fn((entity) => entity), save: jest.fn((entity) => entity) };
    categoryRepositoryInTx = { findOneOrFail: jest.fn() };
    transactionRepositoryInTx = { create: jest.fn((entity) => entity), save: jest.fn((entity) => entity) };
    const manager = {
      getRepository: jest.fn((entity) => {
        if (entity === Wallet) return walletRepositoryInTx;
        if (entity === Category) return categoryRepositoryInTx;
        if (entity === Transaction) return transactionRepositoryInTx;
        throw new Error(`Unexpected entity: ${entity}`);
      }),
    };
    dataSource = { transaction: jest.fn((callback) => callback(manager)) };

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
        { provide: SpacesService, useValue: { getOne: jest.fn() } },
        { provide: DataSource, useValue: dataSource },
      ],
    }).compile();

    service = module.get(WalletsService);
    repository = module.get(getRepositoryToken(Wallet));
    spacesService = module.get(SpacesService);
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
    it('returns only non-deleted wallets for the space', async () => {
      const wallets = [{ id: 1 }] as Wallet[];
      const queryBuilder = repository.createQueryBuilder();
      (queryBuilder.getMany as jest.Mock).mockResolvedValue(wallets);

      const result = await service.getAll(9);

      expect(queryBuilder.where).toHaveBeenCalledWith({ space_id: 9, is_deleted: 0 });
      expect(result).toBe(wallets);
    });
  });

  describe('create', () => {
    it('creates the wallet with no starting transaction when initial_balance is 0', async () => {
      const dto = { wallet_name: 'Cash', initial_balance: '0', design: 'slate' } as any;

      const result = await service.create(5, dto);

      // the create() mock argument is asserted after the call: it's the
      // same object the service later mutates in place to set balance
      expect(walletRepositoryInTx.create).toHaveBeenCalledWith(
        expect.objectContaining({ space_id: 5, wallet_name: 'Cash', design: 'slate' }),
      );
      expect(categoryRepositoryInTx.findOneOrFail).not.toHaveBeenCalled();
      expect(transactionRepositoryInTx.create).not.toHaveBeenCalled();
      expect(result).toEqual({ wallet: expect.objectContaining({ balance: 0 }), transaction: null });
    });

    it('records a starting-balance transaction against the space system category when initial_balance > 0', async () => {
      const dto = { wallet_name: 'Cash', initial_balance: '100.00', design: 'slate' } as any;
      walletRepositoryInTx.save.mockResolvedValue({ id: 7 });
      categoryRepositoryInTx.findOneOrFail.mockResolvedValue({ id: 3, is_system: 1 });

      const result = await service.create(5, dto);

      expect(categoryRepositoryInTx.findOneOrFail).toHaveBeenCalledWith({ where: { space_id: 5, is_system: 1 } });
      expect(transactionRepositoryInTx.create).toHaveBeenCalledWith({
        wallet_id: 7,
        category_id: 3,
        transaction_type: TransactionType.INCOME,
        amount: 100,
        timestamp: expect.any(Date),
      });
      expect(result.wallet).toEqual(expect.objectContaining({ id: 7, balance: 100 }));
      expect(result.transaction).toBeDefined();
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

  describe('buildOverview', () => {
    const baseSpace = { id: 1, currency_id: 1, currency: { id: 1, code: 'USD' } } as any;

    it('sums wallet balances from the derived-balance map and computes the period delta', async () => {
      spacesService.getOne.mockResolvedValue(baseSpace);
      const wallets = [{ id: 1 }, { id: 2 }] as Wallet[];
      const transactions = [
        { wallet_id: 1, transaction_type: TransactionType.INCOME, amount: '200' },
        { wallet_id: 2, transaction_type: TransactionType.EXPENSE, amount: '50' },
      ] as any;
      const balances = new Map([
        [1, 1000],
        [2, 500],
      ]);

      const result = await service.buildOverview(9, wallets, transactions, balances);

      expect(spacesService.getOne).toHaveBeenCalledWith(9);
      // total_balance = 1500, net = 200 - 50 = 150, base = 1500 - 150 = 1350
      expect(result.total_balance).toBe(1500);
      expect(result.total_balance_currency).toBe('USD');
      expect(result.delta_percent).toBeCloseTo((150 / 1350) * 100, 1);
      expect(result.wallets).toHaveLength(2);
    });

    it('returns a 0% delta when there are no wallets', async () => {
      spacesService.getOne.mockResolvedValue(baseSpace);

      const result = await service.buildOverview(9, [], [], new Map());

      expect(result.total_balance).toBe(0);
      expect(result.delta_percent).toBe(0);
    });

    it('returns a 0% delta when the balance at the start of the period was zero', async () => {
      spacesService.getOne.mockResolvedValue(baseSpace);
      const wallets = [{ id: 1 }] as Wallet[];
      const transactions = [{ wallet_id: 1, transaction_type: TransactionType.INCOME, amount: '200' }] as any;
      const balances = new Map([[1, 200]]);

      const result = await service.buildOverview(9, wallets, transactions, balances);

      expect(result.total_balance).toBe(200);
      expect(result.delta_percent).toBe(0);
    });
  });
});
