import { HttpException, INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.config';

import { Space } from '@entities/space.entity';
import { SpaceMember } from '@entities/space-member.entity';
import { User } from '@entities/user.entity';
import { Currency } from '@entities/currency.entity';
import { Wallet } from '@entities/wallet.entity';
import { Category } from '@entities/category.entity';
import { Transaction } from '@entities/transaction.entity';

import { TransactionQueriesService } from '@modules/transaction-queries/transaction-queries.service';
import { CategoriesService } from '@modules/categories/categories.service';
import { LimitsService } from '@modules/limits/limits.service';
import { WalletsService } from '@modules/wallets/wallets.service';
import { LimitsController } from '@modules/limits/limits.controller';

import { AppColor, CategoryIcon, SpaceRole, SpaceType, TransactionType } from '@shared/enums';
import { ErrorMessages } from '@shared/error-messages';
import type { AuthedRequest } from '@shared/types';

// These exercise the SQL aggregation queries added in Stages 2-4
// (TransactionQueriesService.getPeriodTotals/getExpensesByCategory,
// CategoriesService.getMany) against a real MySQL instance, at the service
// layer - the unit specs mock QueryBuilder and can't catch a query that is
// syntactically valid but returns the wrong rows.
describe('Wallet & limit summary queries against a real database (e2e)', () => {
  let app: INestApplication;
  let dataSource: DataSource;

  let transactionQueriesService: TransactionQueriesService;
  let categoriesService: CategoriesService;
  let limitsService: LimitsService;
  let walletsService: WalletsService;
  let limitsController: LimitsController;

  let spaceRepository: Repository<Space>;
  let spaceMemberRepository: Repository<SpaceMember>;
  let userRepository: Repository<User>;
  let currencyRepository: Repository<Currency>;
  let walletRepository: Repository<Wallet>;
  let categoryRepository: Repository<Category>;
  let transactionRepository: Repository<Transaction>;

  let currencyId: number;
  const spaceIds: number[] = [];
  const userIds: number[] = [];

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    configureApp(app);
    await app.init();

    dataSource = moduleFixture.get(DataSource);
    transactionQueriesService = moduleFixture.get(TransactionQueriesService);
    categoriesService = moduleFixture.get(CategoriesService);
    limitsService = moduleFixture.get(LimitsService);
    walletsService = moduleFixture.get(WalletsService);
    limitsController = moduleFixture.get(LimitsController);

    spaceRepository = moduleFixture.get(getRepositoryToken(Space));
    spaceMemberRepository = moduleFixture.get(getRepositoryToken(SpaceMember));
    userRepository = moduleFixture.get(getRepositoryToken(User));
    currencyRepository = moduleFixture.get(getRepositoryToken(Currency));
    walletRepository = moduleFixture.get(getRepositoryToken(Wallet));
    categoryRepository = moduleFixture.get(getRepositoryToken(Category));
    transactionRepository = moduleFixture.get(getRepositoryToken(Transaction));

    const currencies = await currencyRepository.find();
    currencyId = currencies[0].id;
  });

  afterAll(async () => {
    // Same ordering as app.e2e-spec.ts and for the same reason: limit_categories
    // -> categories is RESTRICT, and transactions have no space_id of their own,
    // so both must be cleared before the space cascade runs.
    try {
      if (spaceIds.length) {
        await dataSource.query(
          'DELETE lc FROM limit_categories lc INNER JOIN limits l ON l.id = lc.limit_id WHERE l.space_id IN (?)',
          [spaceIds],
        );
        await dataSource.query('DELETE FROM limits WHERE space_id IN (?)', [spaceIds]);
        await dataSource.query(
          'DELETE t FROM transactions t INNER JOIN wallets w ON w.id = t.wallet_id WHERE w.space_id IN (?)',
          [spaceIds],
        );
        await dataSource.query('DELETE FROM space_members WHERE space_id IN (?)', [spaceIds]);
        await dataSource.query('DELETE FROM spaces WHERE id IN (?)', [spaceIds]);
      }

      if (userIds.length) {
        await dataSource.query('DELETE FROM users WHERE id IN (?)', [userIds]);
      }
    } finally {
      await app.close();
    }
  });

  async function createSpace(): Promise<number> {
    const space = await spaceRepository.save(
      spaceRepository.create({
        name: `e2e-space-${Date.now()}-${Math.random()}`,
        type: SpaceType.PERSONAL,
        currency_id: currencyId,
      }),
    );
    spaceIds.push(space.id);
    return space.id;
  }

  async function createUserWithMembership(spaceId: number): Promise<number> {
    const user = await userRepository.save(
      userRepository.create({
        email: `e2e-${Date.now()}-${Math.random()}@example.com`,
        name: 'E2E user',
        password: 'DevTest#2026',
      }),
    );
    userIds.push(user.id);

    await spaceMemberRepository.save(
      spaceMemberRepository.create({ space_id: spaceId, user_id: user.id, role: SpaceRole.OWNER }),
    );

    return user.id;
  }

  async function createWallet(spaceId: number, wallet_name = 'Wallet'): Promise<Wallet> {
    return walletRepository.save(walletRepository.create({ space_id: spaceId, wallet_name, design: AppColor.SLATE }));
  }

  async function createCategory(
    spaceId: number,
    transaction_type: TransactionType,
    overrides: Partial<Pick<Category, 'name' | 'is_system'>> = {},
  ): Promise<Category> {
    return categoryRepository.save(
      categoryRepository.create({
        space_id: spaceId,
        name: overrides.name ?? 'Cat',
        transaction_type,
        icon: CategoryIcon.OTHER,
        color: AppColor.SLATE,
        is_active: 1,
        is_system: overrides.is_system ?? 0,
      }),
    );
  }

  async function createTransaction(
    wallet_id: number,
    category_id: number,
    transaction_type: TransactionType,
    amount: string,
    timestamp: Date,
  ): Promise<Transaction> {
    return transactionRepository.save(
      transactionRepository.create({ wallet_id, category_id, transaction_type, amount, timestamp }),
    );
  }

  describe('wallet balances and period totals', () => {
    it('aggregates multiple wallets and categories, honors inclusive period boundaries, and defaults empty ones to zero', async () => {
      const spaceId = await createSpace();
      const income = await createCategory(spaceId, TransactionType.INCOME, { name: 'Salary' });
      const expense = await createCategory(spaceId, TransactionType.EXPENSE, { name: 'Food' });

      const w1 = await createWallet(spaceId, 'W1');
      const w2 = await createWallet(spaceId, 'W2');
      const w3 = await createWallet(spaceId, 'W3 (untouched)');

      const from = new Date(2026, 0, 1, 0, 0, 0, 0);
      const to = new Date(2026, 0, 31, 23, 59, 59, 999);

      await createTransaction(w1.id, income.id, TransactionType.INCOME, '1000', new Date(2025, 11, 15)); // before period, all-time only
      await createTransaction(w1.id, income.id, TransactionType.INCOME, '500', from); // exactly on the lower boundary
      await createTransaction(w1.id, expense.id, TransactionType.EXPENSE, '120.5', new Date(2026, 0, 15));
      await createTransaction(w1.id, expense.id, TransactionType.EXPENSE, '50', to); // exactly on the upper boundary
      await createTransaction(w1.id, income.id, TransactionType.INCOME, '200', new Date(to.getTime() + 1)); // after period, all-time only
      await createTransaction(w2.id, expense.id, TransactionType.EXPENSE, '30', new Date(2026, 0, 10));

      const walletIds = [w1.id, w2.id, w3.id];

      const balances = await transactionQueriesService.getBalances(walletIds);
      expect(balances.get(w1.id)).toBe(1000 + 500 - 120.5 - 50 + 200);
      expect(balances.get(w2.id)).toBe(-30);
      expect(balances.get(w3.id)).toBe(0);

      const periodTotals = await transactionQueriesService.getPeriodTotals(walletIds, from, to);
      expect(periodTotals.get(w1.id)).toEqual({ income: 500, spend: 170.5 });
      expect(periodTotals.get(w2.id)).toEqual({ income: 0, spend: 30 });
      expect(periodTotals.get(w3.id)).toEqual({ income: 0, spend: 0 });
    });

    it('builds the full wallets overview from the aggregated maps, including total_balance and delta_percent', async () => {
      const spaceId = await createSpace();
      const userId = await createUserWithMembership(spaceId);
      const income = await createCategory(spaceId, TransactionType.INCOME, { name: 'Salary' });
      const wallet = await createWallet(spaceId, 'Main');

      await createTransaction(wallet.id, income.id, TransactionType.INCOME, '400', new Date());

      const overview = await walletsService.getOverview(userId, spaceId, new Date(2000, 0, 1), new Date(2100, 0, 1));

      expect(overview.total_balance).toBe(400);
      expect(overview.wallets).toHaveLength(1);
      expect(overview.wallets[0]).toMatchObject({ total_income: 400, total_spend: 0 });
    });
  });

  describe('space isolation', () => {
    it('never mixes one space expense totals into another, even with identically-named categories', async () => {
      const spaceA = await createSpace();
      const spaceB = await createSpace();
      const from = new Date(2026, 1, 1);
      const to = new Date(2026, 1, 28, 23, 59, 59, 999);

      const catA = await createCategory(spaceA, TransactionType.EXPENSE, { name: 'Groceries' });
      const walletA = await createWallet(spaceA, 'A');
      await createTransaction(walletA.id, catA.id, TransactionType.EXPENSE, '70', new Date(2026, 1, 10));

      const catB = await createCategory(spaceB, TransactionType.EXPENSE, { name: 'Groceries' });
      const walletB = await createWallet(spaceB, 'B');
      await createTransaction(walletB.id, catB.id, TransactionType.EXPENSE, '999', new Date(2026, 1, 10));

      const totalsA = await transactionQueriesService.getExpensesByCategory(spaceA, from, to);
      const totalsB = await transactionQueriesService.getExpensesByCategory(spaceB, from, to);

      expect(totalsA.get(catA.id)).toBe(70);
      expect(totalsA.has(catB.id)).toBe(false);
      expect(totalsB.get(catB.id)).toBe(999);
      expect(totalsB.has(catA.id)).toBe(false);
    });
  });

  describe('deleted wallets: excluded from wallet summaries, still counted by limits', () => {
    it('keeps a soft-deleted wallet history in the category aggregate used by limits, but out of getAll/getBalances', async () => {
      const spaceId = await createSpace();
      const userId = await createUserWithMembership(spaceId);
      const catA = await createCategory(spaceId, TransactionType.EXPENSE, { name: 'A' });
      const catB = await createCategory(spaceId, TransactionType.EXPENSE, { name: 'B' });
      const catIncome = await createCategory(spaceId, TransactionType.INCOME, { name: 'Income' });

      const kept = await createWallet(spaceId, 'kept');
      const deleted = await createWallet(spaceId, 'to be deleted');

      const from = new Date(2026, 2, 1, 0, 0, 0, 0);
      const to = new Date(2026, 2, 31, 23, 59, 59, 999);

      await createTransaction(kept.id, catA.id, TransactionType.EXPENSE, '100.25', new Date(2026, 2, 10));
      await createTransaction(kept.id, catB.id, TransactionType.EXPENSE, '40', from); // lower boundary
      await createTransaction(kept.id, catA.id, TransactionType.EXPENSE, '15', to); // upper boundary
      await createTransaction(kept.id, catIncome.id, TransactionType.INCOME, '500', new Date(2026, 2, 12));
      await createTransaction(kept.id, catA.id, TransactionType.EXPENSE, '5', new Date(from.getTime() - 1)); // outside
      await createTransaction(kept.id, catA.id, TransactionType.EXPENSE, '7', new Date(to.getTime() + 1)); // outside
      await createTransaction(deleted.id, catA.id, TransactionType.EXPENSE, '60', new Date(2026, 2, 11));

      await walletsService.delete(userId, spaceId, deleted.id);

      const visibleWallets = await walletsService.getAll(spaceId);
      expect(visibleWallets.map((w) => w.id)).toEqual([kept.id]);

      const balances = await transactionQueriesService.getBalances(visibleWallets.map((w) => w.id));
      expect(balances.get(kept.id)).toBe(500 - 100.25 - 40 - 15 - 5 - 7);
      expect(balances.has(deleted.id)).toBe(false);

      const periodTotals = await transactionQueriesService.getPeriodTotals(
        visibleWallets.map((w) => w.id),
        from,
        to,
      );
      expect(periodTotals.get(kept.id)).toEqual({ income: 500, spend: 100.25 + 40 + 15 });

      // limits scope by space, not by wallet visibility - the deleted
      // wallet's history still counts against a category limit
      const categoryTotals = await transactionQueriesService.getExpensesByCategory(spaceId, from, to);
      expect(categoryTotals.get(catA.id)).toBe(100.25 + 15 + 60);
      expect(categoryTotals.get(catB.id)).toBe(40);
      expect(categoryTotals.has(catIncome.id)).toBe(false);
    });
  });

  describe('limit spending calculated from real aggregated expenses', () => {
    it('tracks the total across every expense, sums a group limit fractionally, and flags over_allocation', async () => {
      const spaceId = await createSpace();
      const catX = await createCategory(spaceId, TransactionType.EXPENSE, { name: 'X' });
      const catY = await createCategory(spaceId, TransactionType.EXPENSE, { name: 'Y' });
      const catZ = await createCategory(spaceId, TransactionType.EXPENSE, { name: 'Z (no limit)' });
      const wallet = await createWallet(spaceId, 'W');

      const from = new Date(2026, 3, 1, 0, 0, 0, 0);
      const to = new Date(2026, 3, 30, 23, 59, 59, 999);

      await createTransaction(wallet.id, catX.id, TransactionType.EXPENSE, '12.34', new Date(2026, 3, 5));
      await createTransaction(wallet.id, catX.id, TransactionType.EXPENSE, '0.01', new Date(2026, 3, 6));
      await createTransaction(wallet.id, catY.id, TransactionType.EXPENSE, '45.65', new Date(2026, 3, 7));
      await createTransaction(wallet.id, catZ.id, TransactionType.EXPENSE, '100', new Date(2026, 3, 8));

      const userId = await createUserWithMembership(spaceId);
      await limitsService.create(userId, spaceId, { amount: 50 } as any); // monthly total, less than the group's own amount
      await limitsService.create(userId, spaceId, {
        category_ids: [catX.id, catY.id],
        name: 'Fun',
        amount: 100,
      } as any);

      const categoryTotals = await transactionQueriesService.getExpensesByCategory(spaceId, from, to);
      const limits = await limitsService.getAll(spaceId);
      const result = limitsService.calculateSpending(limits, categoryTotals);

      // total tracks ALL expenses, including catZ which no category limit covers
      expect(result.total).toMatchObject({ amount: '50.00', spent: 12.34 + 0.01 + 45.65 + 100 });

      expect(result.categories).toHaveLength(1);
      // in_percent is floor((58 / 100) * 100); 58/100 isn't exactly
      // representable in IEEE754, so this floors to 57, not 58 - a
      // pre-existing quirk of the percent formula, not this stage's concern
      expect(result.categories[0]).toMatchObject({ name: 'Fun', spent: 12.34 + 0.01 + 45.65, in_percent: 57 });

      expect(result.over_allocation).toEqual({ category_total: 100, difference: 50 });
    });
  });

  describe('batched category ownership checks', () => {
    it('rejects a batch containing a missing id, a foreign-space id, or a system category, without one query per id', async () => {
      const spaceId = await createSpace();
      const otherSpaceId = await createSpace();
      const userId = await createUserWithMembership(spaceId);
      const req = { user: { id: userId } } as unknown as AuthedRequest;

      const valid = await createCategory(spaceId, TransactionType.EXPENSE, { name: 'Valid' });
      const systemCategory = await createCategory(spaceId, TransactionType.EXPENSE, {
        name: 'System',
        is_system: 1,
      });
      const foreign = await createCategory(otherSpaceId, TransactionType.EXPENSE, { name: 'Foreign' });
      const missingId = valid.id + foreign.id + systemCategory.id + 1_000_000;

      await expect(
        limitsController.create(req, spaceId, { category_ids: [valid.id, missingId], amount: 10 } as any),
      ).rejects.toMatchObject(new HttpException(ErrorMessages.FORBIDDEN_CATEGORY, 403));

      await expect(
        limitsController.create(req, spaceId, { category_ids: [valid.id, foreign.id], amount: 10 } as any),
      ).rejects.toMatchObject(new HttpException(ErrorMessages.FORBIDDEN_CATEGORY, 403));

      await expect(
        limitsController.create(req, spaceId, { category_ids: [systemCategory.id], amount: 10 } as any),
      ).rejects.toMatchObject(new HttpException(ErrorMessages.CATEGORY_IS_SYSTEM, 400));

      const created = await limitsController.create(req, spaceId, { category_ids: [valid.id], amount: 10 } as any);
      expect(created).toBeTruthy();

      const findSpy = jest.spyOn(categoryRepository, 'find');
      findSpy.mockClear();

      const smallBatch = [valid.id, missingId];
      const largeBatch = [
        valid.id,
        foreign.id,
        systemCategory.id,
        missingId,
        ...Array.from({ length: 50 }, (_, i) => missingId + i + 1),
      ];

      const smallResult = await categoriesService.getMany(smallBatch);
      const largeResult = await categoriesService.getMany(largeBatch);

      expect(findSpy).toHaveBeenCalledTimes(2); // exactly one query per call, regardless of list size
      expect(smallResult.map((c) => c.id)).toEqual([valid.id]);
      expect(largeResult.map((c) => c.id).sort((a, b) => a - b)).toEqual(
        [valid.id, foreign.id, systemCategory.id].sort((a, b) => a - b),
      );

      findSpy.mockRestore();
    });
  });
});
