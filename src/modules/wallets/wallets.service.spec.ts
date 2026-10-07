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
import { AppColor, TransactionType } from '@shared/enums';
import { withRelations } from '@shared/utils';
import type { CreateWalletDto } from './dto/create-wallet.dto';
import { buildCategory, buildCurrency, buildSpace, buildSpaceMember, buildWallet } from '@testing';
import { ErrorMessages } from '@shared/error-messages';

describe('WalletsService', () => {
  let service: WalletsService;
  let repository: jest.Mocked<Repository<Wallet>>;
  let queryBuilder: { where: jest.Mock; getMany: jest.Mock };
  let spacesService: jest.Mocked<SpacesService>;
  let spaceAccessService: jest.Mocked<SpaceAccessService>;
  let transactionQueriesService: jest.Mocked<TransactionQueriesService>;
  let walletRepositoryInTx: { create: jest.Mock; save: jest.Mock; update: jest.Mock; createQueryBuilder: jest.Mock };
  let transactionRepositoryInTx: { create: jest.Mock; save: jest.Mock };
  let walletLock: { setLock: jest.Mock; whereInIds: jest.Mock; orderBy: jest.Mock; getMany: jest.Mock };
  let systemCategoryLock: { setLock: jest.Mock; where: jest.Mock; getOneOrFail: jest.Mock };
  let manager: { getRepository: jest.Mock; createQueryBuilder: jest.Mock };
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

    walletRepositoryInTx = {
      create: jest.fn((entity) => entity),
      save: jest.fn((entity) => entity),
      update: jest.fn(),
      createQueryBuilder: jest.fn().mockReturnValue(queryBuilder),
    };
    transactionRepositoryInTx = { create: jest.fn((entity) => entity), save: jest.fn((entity) => ({ ...entity })) };
    walletLock = {
      setLock: jest.fn().mockReturnThis(),
      whereInIds: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolvedValue([buildWallet({ id: 1, space_id: spaceId })]),
    };
    systemCategoryLock = {
      setLock: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      getOneOrFail: jest.fn(),
    };
    manager = {
      getRepository: jest.fn((entity) => {
        if (entity === Wallet) return walletRepositoryInTx;
        if (entity === Transaction) return transactionRepositoryInTx;
        throw new Error(`Unexpected entity: ${entity}`);
      }),
      createQueryBuilder: jest.fn((entity) => {
        if (entity === Wallet) return walletLock;
        if (entity === Category) return systemCategoryLock;
        throw new Error(`Unexpected entity: ${entity}`);
      }),
    };
    dataSource = { transaction: jest.fn((_isolation, callback) => callback(manager)) };

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
        {
          provide: SpaceAccessService,
          useValue: {
            assertMembership: jest.fn().mockResolvedValue(buildSpaceMember({ space_id: spaceId, user_id: userId })),
            lockMembership: jest.fn().mockResolvedValue(buildSpaceMember({ space_id: spaceId, user_id: userId })),
            lockSpace: jest.fn(),
          },
        },
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
      const wallet = buildWallet({ id: 1 });
      repository.findOne.mockResolvedValue(wallet);

      const result = await service.getOne(1);

      expect(repository.findOne).toHaveBeenCalledWith({ where: { id: 1 } });
      expect(result).toBe(wallet);
    });
  });

  describe('getAll', () => {
    it('returns only non-deleted wallets for the space', async () => {
      const wallets = [buildWallet({ id: 1 })];
      queryBuilder.getMany.mockResolvedValue(wallets);

      const result = await service.getAll(9);

      expect(queryBuilder.where).toHaveBeenCalledWith({ space_id: 9, is_deleted: 0 });
      expect(result).toBe(wallets);
    });
  });

  describe('create', () => {
    it('checks membership under its lock, in the write transaction, before creating anything', async () => {
      spaceAccessService.lockMembership.mockRejectedValue(forbiddenSpace);

      await expect(
        service.create(userId, 5, { wallet_name: 'Cash', initial_balance: '0', design: AppColor.SLATE }),
      ).rejects.toMatchObject(forbiddenSpace);
      expect(dataSource.transaction).toHaveBeenCalledWith('READ COMMITTED', expect.any(Function));
      expect(spaceAccessService.lockMembership).toHaveBeenCalledWith(5, userId, manager);
      expect(spaceAccessService.assertMembership).not.toHaveBeenCalled();
      expect(walletRepositoryInTx.save).not.toHaveBeenCalled();
    });

    it('creates the wallet with no starting transaction when initial_balance is 0', async () => {
      const dto: CreateWalletDto = { wallet_name: 'Cash', initial_balance: '0', design: AppColor.SLATE };

      const result = await service.create(userId, 5, dto);

      expect(spaceAccessService.lockMembership).toHaveBeenCalledTimes(1);
      expect(spaceAccessService.lockSpace).toHaveBeenCalledWith(5, manager, 'shared');
      // the create() mock argument is asserted after the call: it's the
      // same object the service later mutates in place to set balance
      expect(walletRepositoryInTx.create).toHaveBeenCalledWith(
        expect.objectContaining({ space_id: 5, wallet_name: 'Cash', design: 'slate' }),
      );
      expect(systemCategoryLock.getOneOrFail).not.toHaveBeenCalled();
      expect(transactionRepositoryInTx.create).not.toHaveBeenCalled();
      expect(result).toEqual({ wallet: expect.objectContaining({ balance: 0 }), transaction: null });
    });

    it('records a starting-balance transaction against the space system category when initial_balance > 0', async () => {
      const dto: CreateWalletDto = { wallet_name: 'Cash', initial_balance: '100.00', design: AppColor.SLATE };
      walletRepositoryInTx.save.mockResolvedValue(buildWallet({ id: 7, space_id: 5 }));
      systemCategoryLock.getOneOrFail.mockResolvedValue(buildCategory({ id: 3, space_id: 5, is_system: 1 }));

      const result = await service.create(userId, 5, dto);

      expect(systemCategoryLock.setLock).toHaveBeenCalledWith('pessimistic_read');
      expect(systemCategoryLock.where).toHaveBeenCalledWith('category.space_id = :spaceId AND category.is_system = 1', {
        spaceId: 5,
      });
      expect(transactionRepositoryInTx.create).toHaveBeenCalledWith({
        wallet_id: 7,
        category_id: 3,
        transaction_type: TransactionType.INCOME,
        amount: '100.00',
        timestamp: expect.any(Date),
      });
      expect(result.wallet).toEqual(expect.objectContaining({ id: 7, balance: 100 }));
      expect(result.transaction).toEqual(expect.objectContaining({ amount: 100 }));
    });

    it('locks member, space, the new wallet and the system category in the transaction write order', async () => {
      const dto: CreateWalletDto = { wallet_name: 'Cash', initial_balance: '100.00', design: AppColor.SLATE };
      systemCategoryLock.getOneOrFail.mockResolvedValue(buildCategory({ id: 3, space_id: 5, is_system: 1 }));

      await service.create(userId, 5, dto);

      const order = [
        spaceAccessService.lockMembership,
        spaceAccessService.lockSpace,
        walletRepositoryInTx.save,
        systemCategoryLock.getOneOrFail,
        transactionRepositoryInTx.save,
      ].map((mock) => mock.mock.invocationCallOrder[0]);
      expect(order).toEqual([...order].sort((a, b) => a - b));
    });
  });

  describe.each([
    ['update', (walletId: number) => service.update(userId, spaceId, walletId, { wallet_name: 'Renamed' })],
    ['delete', (walletId: number) => service.delete(userId, spaceId, walletId)],
  ])('%s', (_, run) => {
    it('rejects a non-member under the member lock without locking the wallet', async () => {
      spaceAccessService.lockMembership.mockRejectedValue(forbiddenSpace);

      await expect(run(1)).rejects.toMatchObject(forbiddenSpace);
      expect(spaceAccessService.lockMembership).toHaveBeenCalledWith(spaceId, userId, manager);
      expect(spaceAccessService.assertMembership).not.toHaveBeenCalled();
      expect(walletLock.getMany).not.toHaveBeenCalled();
      expect(walletRepositoryInTx.update).not.toHaveBeenCalled();
    });

    it('rejects a wallet that belongs to a different space', async () => {
      walletLock.getMany.mockResolvedValue([buildWallet({ id: 1, space_id: 20 })]);

      await expect(run(1)).rejects.toMatchObject(forbiddenWallet);
      expect(walletRepositoryInTx.update).not.toHaveBeenCalled();
    });

    it('rejects a wallet that does not exist', async () => {
      walletLock.getMany.mockResolvedValue([]);

      await expect(run(1)).rejects.toMatchObject(forbiddenWallet);
      expect(walletRepositoryInTx.update).not.toHaveBeenCalled();
    });

    it('locks member, space and then the wallet row exclusively before writing', async () => {
      await run(1);

      expect(spaceAccessService.lockSpace).toHaveBeenCalledWith(spaceId, manager, 'shared');
      expect(walletLock.setLock).toHaveBeenCalledWith('pessimistic_write');
      expect(walletLock.whereInIds).toHaveBeenCalledWith([1]);
      const order = [
        spaceAccessService.lockMembership,
        spaceAccessService.lockSpace,
        walletLock.getMany,
        walletRepositoryInTx.update,
      ].map((mock) => mock.mock.invocationCallOrder[0]);
      expect(order).toEqual([...order].sort((a, b) => a - b));
    });
  });

  describe('update', () => {
    it('renames a wallet of the space', async () => {
      await service.update(userId, spaceId, 1, { wallet_name: 'Renamed' });

      expect(walletRepositoryInTx.update).toHaveBeenCalledWith({ id: 1 }, { wallet_name: 'Renamed' });
      expect(repository.update).not.toHaveBeenCalled();
    });
  });

  describe('delete', () => {
    it('soft-deletes a wallet of the space', async () => {
      await service.delete(userId, spaceId, 1);

      expect(walletRepositoryInTx.update).toHaveBeenCalledWith({ id: 1 }, expect.objectContaining({ is_deleted: 1 }));
      expect(repository.update).not.toHaveBeenCalled();
    });
  });

  describe('getOverview', () => {
    const baseSpace = withRelations(buildSpace({ id: spaceId, currency: buildCurrency() }), 'currency');
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

    it('reads the wallets, totals, balances and space in one REPEATABLE READ snapshot', async () => {
      await service.getOverview(userId, spaceId, from, to);

      expect(dataSource.transaction).toHaveBeenCalledWith('REPEATABLE READ', expect.any(Function));
      expect(walletRepositoryInTx.createQueryBuilder).toHaveBeenCalledWith('wallet');
      expect(repository.createQueryBuilder).not.toHaveBeenCalled();
      const membership = spaceAccessService.assertMembership.mock.invocationCallOrder[0];
      expect(membership).toBeLessThan(dataSource.transaction.mock.invocationCallOrder[0]);
    });

    it('sums wallet balances and the period delta from the aggregated maps', async () => {
      queryBuilder.getMany.mockResolvedValue([buildWallet({ id: 1 }), buildWallet({ id: 2 })]);
      transactionQueriesService.getPeriodTotals.mockResolvedValue(
        new Map([
          [1, { income: 20000n, spend: 0n }],
          [2, { income: 0n, spend: 5000n }],
        ]),
      );
      transactionQueriesService.getBalances.mockResolvedValue(
        new Map([
          [1, 100000n],
          [2, 50000n],
        ]),
      );

      const result = await service.getOverview(userId, spaceId, from, to);

      expect(spaceAccessService.assertMembership).toHaveBeenCalledTimes(1);
      expect(spaceAccessService.assertMembership).toHaveBeenCalledWith(spaceId, userId);
      expect(transactionQueriesService.getPeriodTotals).toHaveBeenCalledWith([1, 2], from, to, manager);
      expect(transactionQueriesService.getBalances).toHaveBeenCalledWith([1, 2], manager);
      expect(spacesService.getOne).toHaveBeenCalledWith(spaceId, manager);
      // total_balance = 1500, net = 200 - 50 = 150, base = 1500 - 150 = 1350
      expect(result.total_balance).toBe(1500);
      expect(result.total_balance_currency).toBe('USD');
      expect(result.delta_percent).toBe(11.1);
      expect(result.wallets).toEqual([
        { wallet: expect.objectContaining({ id: 1, balance: 1000 }), total_income: 200, total_spend: 0 },
        { wallet: expect.objectContaining({ id: 2, balance: 500 }), total_income: 0, total_spend: 50 },
      ]);
    });

    it('defaults a wallet missing from the aggregates to zero totals and balance', async () => {
      queryBuilder.getMany.mockResolvedValue([buildWallet({ id: 1 })]);

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
      queryBuilder.getMany.mockResolvedValue([buildWallet({ id: 1 })]);
      transactionQueriesService.getPeriodTotals.mockResolvedValue(new Map([[1, { income: 20000n, spend: 0n }]]));
      transactionQueriesService.getBalances.mockResolvedValue(new Map([[1, 20000n]]));

      const result = await service.getOverview(userId, spaceId, from, to);

      expect(result.total_balance).toBe(200);
      expect(result.delta_percent).toBe(0);
    });

    it('sums balances and period totals in cents without float error', async () => {
      queryBuilder.getMany.mockResolvedValue([buildWallet({ id: 1 }), buildWallet({ id: 2 })]);
      transactionQueriesService.getPeriodTotals.mockResolvedValue(
        new Map([
          [1, { income: 10n, spend: 0n }],
          [2, { income: 20n, spend: 0n }],
        ]),
      );
      transactionQueriesService.getBalances.mockResolvedValue(
        new Map([
          [1, 10n],
          [2, 20n],
        ]),
      );

      const result = await service.getOverview(userId, spaceId, from, to);

      expect(result.total_balance).toBe(0.3);
      expect(result.wallets.map(({ total_income }) => total_income)).toEqual([0.1, 0.2]);
    });

    it.each([
      ['a positive half up', 10225n, 225n, 2.3],
      ['a negative half toward zero', 9775n, -225n, -2.2],
      ['a negative start balance with the sign flipped', -9000n, 1000n, -10],
    ])('rounds delta_percent for %s', async (_, balance, net, delta) => {
      queryBuilder.getMany.mockResolvedValue([buildWallet({ id: 1 })]);
      transactionQueriesService.getPeriodTotals.mockResolvedValue(
        new Map([[1, net >= 0n ? { income: net, spend: 0n } : { income: 0n, spend: -net }]]),
      );
      transactionQueriesService.getBalances.mockResolvedValue(new Map([[1, balance]]));

      const result = await service.getOverview(userId, spaceId, from, to);

      expect(result.delta_percent).toBe(delta);
    });
  });
});
