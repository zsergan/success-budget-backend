import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { HttpException } from '@nestjs/common';
import { DataSource, Repository } from 'typeorm';

import { WalletsService } from './wallets.service';
import { Wallet } from '@entities/wallet.entity';
import { Category } from '@entities/category.entity';
import { Transaction } from '@entities/transaction.entity';
import { SpacesService } from '@modules/spaces/spaces.service';
import { SpaceAccessService } from '@modules/space-access/space-access.service';
import { TransactionQueriesService } from '@modules/transaction-queries/transaction-queries.service';
import { TransactionType } from '@shared/enums';
import { ErrorMessages } from '@shared/error-messages';

describe('WalletsService', () => {
  let service: WalletsService;
  let repository: jest.Mocked<Repository<Wallet>>;
  let queryBuilder: { where: jest.Mock; getMany: jest.Mock };
  let spacesService: jest.Mocked<SpacesService>;
  let spaceAccessService: jest.Mocked<SpaceAccessService>;
  let transactionQueriesService: jest.Mocked<TransactionQueriesService>;
  let walletRepositoryInTx: { create: jest.Mock; save: jest.Mock };
  let categoryRepositoryInTx: { findOneOrFail: jest.Mock };
  let transactionRepositoryInTx: { create: jest.Mock; save: jest.Mock };
  let dataSource: { transaction: jest.Mock };

  const userId = 1;
  const spaceId = 9;
  const forbiddenSpace = new HttpException(ErrorMessages.FORBIDDEN_SPACE, 403);
  const forbiddenWallet = new HttpException(ErrorMessages.FORBIDDEN_WALLET, 403);

  beforeEach(async () => {
    queryBuilder = {
      where: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolvedValue([]),
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
        { provide: SpaceAccessService, useValue: { assertMembership: jest.fn() } },
        {
          provide: TransactionQueriesService,
          useValue: {
            getPeriodTotals: jest.fn().mockResolvedValue(new Map()),
            getBalances: jest.fn().mockResolvedValue(new Map()),
          },
        },
        { provide: DataSource, useValue: dataSource },
      ],
    }).compile();

    service = module.get(WalletsService);
    repository = module.get(getRepositoryToken(Wallet));
    spacesService = module.get(SpacesService);
    spaceAccessService = module.get(SpaceAccessService);
    transactionQueriesService = module.get(TransactionQueriesService);
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
      queryBuilder.getMany.mockResolvedValue(wallets);

      const result = await service.getAll(9);

      expect(queryBuilder.where).toHaveBeenCalledWith({ space_id: 9, is_deleted: 0 });
      expect(result).toBe(wallets);
    });
  });

  describe('create', () => {
    it('rejects a non-member before creating anything', async () => {
      spaceAccessService.assertMembership.mockRejectedValue(forbiddenSpace);

      await expect(service.create(userId, 5, { wallet_name: 'Cash' } as any)).rejects.toMatchObject(forbiddenSpace);
      expect(dataSource.transaction).not.toHaveBeenCalled();
    });

    it('creates the wallet with no starting transaction when initial_balance is 0', async () => {
      const dto = { wallet_name: 'Cash', initial_balance: '0', design: 'slate' } as any;

      const result = await service.create(userId, 5, dto);

      expect(spaceAccessService.assertMembership).toHaveBeenCalledTimes(1);
      expect(spaceAccessService.assertMembership).toHaveBeenCalledWith(5, userId);
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

      const result = await service.create(userId, 5, dto);

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
    it('rejects a non-member without loading the wallet', async () => {
      spaceAccessService.assertMembership.mockRejectedValue(forbiddenSpace);

      await expect(service.update(userId, spaceId, 1, {} as any)).rejects.toMatchObject(forbiddenSpace);
      expect(repository.findOne).not.toHaveBeenCalled();
      expect(repository.update).not.toHaveBeenCalled();
    });

    it('rejects a wallet that belongs to a different space', async () => {
      repository.findOne.mockResolvedValue({ id: 1, space_id: 20 } as Wallet);

      await expect(service.update(userId, spaceId, 1, {} as any)).rejects.toMatchObject(forbiddenWallet);
      expect(repository.update).not.toHaveBeenCalled();
    });

    it('rejects a wallet that does not exist', async () => {
      repository.findOne.mockResolvedValue(null);

      await expect(service.update(userId, spaceId, 1, {} as any)).rejects.toMatchObject(forbiddenWallet);
      expect(repository.update).not.toHaveBeenCalled();
    });

    it('updates a wallet of the space', async () => {
      repository.findOne.mockResolvedValue({ id: 1, space_id: spaceId } as Wallet);

      await service.update(userId, spaceId, 1, { wallet_name: 'Renamed' } as any);

      expect(spaceAccessService.assertMembership).toHaveBeenCalledTimes(1);
      expect(spaceAccessService.assertMembership).toHaveBeenCalledWith(spaceId, userId);
      expect(repository.update).toHaveBeenCalledWith({ id: 1 }, { wallet_name: 'Renamed' });
    });
  });

  describe('delete', () => {
    it('rejects a non-member without loading the wallet', async () => {
      spaceAccessService.assertMembership.mockRejectedValue(forbiddenSpace);

      await expect(service.delete(userId, spaceId, 1)).rejects.toMatchObject(forbiddenSpace);
      expect(repository.findOne).not.toHaveBeenCalled();
      expect(repository.update).not.toHaveBeenCalled();
    });

    it('rejects a wallet that belongs to a different space', async () => {
      repository.findOne.mockResolvedValue({ id: 1, space_id: 20 } as Wallet);

      await expect(service.delete(userId, spaceId, 1)).rejects.toMatchObject(forbiddenWallet);
      expect(repository.update).not.toHaveBeenCalled();
    });

    it('soft-deletes a wallet of the space', async () => {
      repository.findOne.mockResolvedValue({ id: 1, space_id: spaceId } as Wallet);

      await service.delete(userId, spaceId, 1);

      expect(spaceAccessService.assertMembership).toHaveBeenCalledTimes(1);
      expect(repository.update).toHaveBeenCalledWith({ id: 1 }, expect.objectContaining({ is_deleted: 1 }));
    });
  });

  describe('getOverview', () => {
    const baseSpace = { id: 1, currency_id: 1, currency: { id: 1, code: 'USD' } } as any;
    const from = new Date('2026-01-01');
    const to = new Date('2026-01-31');

    beforeEach(() => {
      spacesService.getOne.mockResolvedValue(baseSpace);
    });

    it('rejects a non-member without querying wallets or aggregates', async () => {
      spaceAccessService.assertMembership.mockRejectedValue(forbiddenSpace);

      await expect(service.getOverview(userId, spaceId, from, to)).rejects.toMatchObject(forbiddenSpace);
      expect(queryBuilder.getMany).not.toHaveBeenCalled();
      expect(transactionQueriesService.getPeriodTotals).not.toHaveBeenCalled();
      expect(transactionQueriesService.getBalances).not.toHaveBeenCalled();
    });

    it('sums wallet balances and the period delta from the aggregated maps', async () => {
      queryBuilder.getMany.mockResolvedValue([{ id: 1 }, { id: 2 }]);
      transactionQueriesService.getPeriodTotals.mockResolvedValue(
        new Map([
          [1, { income: 200, spend: 0 }],
          [2, { income: 0, spend: 50 }],
        ]),
      );
      transactionQueriesService.getBalances.mockResolvedValue(
        new Map([
          [1, 1000],
          [2, 500],
        ]),
      );

      const result = await service.getOverview(userId, spaceId, from, to);

      expect(spaceAccessService.assertMembership).toHaveBeenCalledTimes(1);
      expect(spaceAccessService.assertMembership).toHaveBeenCalledWith(spaceId, userId);
      expect(transactionQueriesService.getPeriodTotals).toHaveBeenCalledWith([1, 2], from, to);
      expect(transactionQueriesService.getBalances).toHaveBeenCalledWith([1, 2]);
      expect(spacesService.getOne).toHaveBeenCalledWith(spaceId);
      // total_balance = 1500, net = 200 - 50 = 150, base = 1500 - 150 = 1350
      expect(result.total_balance).toBe(1500);
      expect(result.total_balance_currency).toBe('USD');
      expect(result.delta_percent).toBeCloseTo((150 / 1350) * 100, 1);
      expect(result.wallets).toEqual([
        { wallet: expect.objectContaining({ id: 1, balance: 1000 }), total_income: 200, total_spend: 0 },
        { wallet: expect.objectContaining({ id: 2, balance: 500 }), total_income: 0, total_spend: 50 },
      ]);
    });

    it('defaults a wallet missing from the aggregates to zero totals and balance', async () => {
      queryBuilder.getMany.mockResolvedValue([{ id: 1 }]);

      const result = await service.getOverview(userId, spaceId, from, to);

      expect(result.wallets).toEqual([
        { wallet: expect.objectContaining({ id: 1, balance: 0 }), total_income: 0, total_spend: 0 },
      ]);
    });

    it('returns a 0% delta when there are no wallets', async () => {
      const result = await service.getOverview(userId, spaceId, from, to);

      expect(result.total_balance).toBe(0);
      expect(result.delta_percent).toBe(0);
    });

    it('returns a 0% delta when the balance at the start of the period was zero', async () => {
      queryBuilder.getMany.mockResolvedValue([{ id: 1 }]);
      transactionQueriesService.getPeriodTotals.mockResolvedValue(new Map([[1, { income: 200, spend: 0 }]]));
      transactionQueriesService.getBalances.mockResolvedValue(new Map([[1, 200]]));

      const result = await service.getOverview(userId, spaceId, from, to);

      expect(result.total_balance).toBe(200);
      expect(result.delta_percent).toBe(0);
    });
  });
});
