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
import { Category } from '@entities/category.entity';
import { Transaction } from '@entities/transaction.entity';

import { TransactionQueriesService } from '@modules/transaction-queries/transaction-queries.service';
import { CategoriesService } from '@modules/categories/categories.service';
import { LimitsService } from '@modules/limits/limits.service';
import { LimitsController } from '@modules/limits/limits.controller';

import {
  AppColor,
  AssignmentKind,
  AuthorSource,
  CategoryIcon,
  SpaceRole,
  SpaceType,
  TransactionType,
} from '@shared/enums';
import { ErrorMessages } from '@shared/error-messages';
import type { AuthedRequest } from '@shared/types';
import { SPACE_ASSIGNMENT } from './support/app';

// These exercise the SQL aggregation queries behind limits
// (TransactionQueriesService.getExpensesByCategory, CategoriesService.getMany)
// against a real MySQL instance, at the service layer - the unit specs mock
// QueryBuilder and can't catch a query that is syntactically valid but
// returns the wrong rows.
describe('Limit summary queries against a real database (e2e)', () => {
  let app: INestApplication;
  let dataSource: DataSource;

  let transactionQueriesService: TransactionQueriesService;
  let categoriesService: CategoriesService;
  let limitsService: LimitsService;
  let limitsController: LimitsController;

  let spaceRepository: Repository<Space>;
  let spaceMemberRepository: Repository<SpaceMember>;
  let userRepository: Repository<User>;
  let currencyRepository: Repository<Currency>;
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
    await app.listen(0, '127.0.0.1');

    dataSource = moduleFixture.get(DataSource);
    transactionQueriesService = moduleFixture.get(TransactionQueriesService);
    categoriesService = moduleFixture.get(CategoriesService);
    limitsService = moduleFixture.get(LimitsService);
    limitsController = moduleFixture.get(LimitsController);

    spaceRepository = moduleFixture.get(getRepositoryToken(Space));
    spaceMemberRepository = moduleFixture.get(getRepositoryToken(SpaceMember));
    userRepository = moduleFixture.get(getRepositoryToken(User));
    currencyRepository = moduleFixture.get(getRepositoryToken(Currency));
    categoryRepository = moduleFixture.get(getRepositoryToken(Category));
    transactionRepository = moduleFixture.get(getRepositoryToken(Transaction));

    const currencies = await currencyRepository.find();
    currencyId = currencies[0].id;
  });

  afterAll(async () => {
    // Same ordering as app.e2e-spec.ts and for the same reason: limit_categories
    // -> categories is RESTRICT, so both must be cleared before the space
    // cascade runs.
    try {
      if (spaceIds.length) {
        await dataSource.query(
          'DELETE lc FROM limit_categories lc INNER JOIN limits l ON l.id = lc.limit_id WHERE l.space_id IN (?)',
          [spaceIds],
        );
        await dataSource.query('DELETE FROM limits WHERE space_id IN (?)', [spaceIds]);
        await dataSource.query('DELETE FROM transactions WHERE space_id IN (?)', [spaceIds]);
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
    space_id: number,
    category_id: number,
    transaction_type: TransactionType,
    amount: string,
    timestamp: Date,
    assignment: Pick<Transaction, 'assignment_kind' | 'assigned_user_id'> = SPACE_ASSIGNMENT,
  ): Promise<Transaction> {
    // some spaces here have no member; the author is not what these tests read
    const member = await spaceMemberRepository.findOneBy({ space_id });

    return transactionRepository.save(
      transactionRepository.create({
        space_id,
        author_user_id: member?.user_id ?? null,
        author_source: AuthorSource.RECORDED,
        ...assignment,
        category_id,
        transaction_type,
        amount,
        timestamp,
      }),
    );
  }

  describe('space isolation', () => {
    it('never mixes one space expense totals into another, even with identically-named categories', async () => {
      const spaceA = await createSpace();
      const spaceB = await createSpace();
      const from = new Date(2026, 1, 1);
      const to = new Date(2026, 1, 28, 23, 59, 59, 999);

      const catA = await createCategory(spaceA, TransactionType.EXPENSE, { name: 'Groceries' });
      await createTransaction(spaceA, catA.id, TransactionType.EXPENSE, '70', new Date(2026, 1, 10));

      const catB = await createCategory(spaceB, TransactionType.EXPENSE, { name: 'Groceries' });
      await createTransaction(spaceB, catB.id, TransactionType.EXPENSE, '999', new Date(2026, 1, 10));

      const totalsA = await transactionQueriesService.getExpensesByCategory(spaceA, from, to);
      const totalsB = await transactionQueriesService.getExpensesByCategory(spaceB, from, to);

      expect(totalsA.get(catA.id)).toBe(7000n);
      expect(totalsA.has(catB.id)).toBe(false);
      expect(totalsB.get(catB.id)).toBe(99900n);
      expect(totalsB.has(catA.id)).toBe(false);
    });
  });

  describe('every expense of the space counts toward limits, whoever it is assigned to', () => {
    it('sums member, space and unassigned expenses of the period by category, bounds included', async () => {
      const spaceId = await createSpace();
      const userId = await createUserWithMembership(spaceId);
      const catA = await createCategory(spaceId, TransactionType.EXPENSE, { name: 'A' });
      const catB = await createCategory(spaceId, TransactionType.EXPENSE, { name: 'B' });
      const catIncome = await createCategory(spaceId, TransactionType.INCOME, { name: 'Income' });
      const member = { assignment_kind: AssignmentKind.MEMBER, assigned_user_id: userId };
      const nobody = { assignment_kind: AssignmentKind.UNASSIGNED, assigned_user_id: null };

      const from = new Date(2026, 2, 1, 0, 0, 0, 0);
      const to = new Date(2026, 2, 31, 23, 59, 59, 999);

      await createTransaction(spaceId, catA.id, TransactionType.EXPENSE, '100.25', new Date(2026, 2, 10), member);
      await createTransaction(spaceId, catB.id, TransactionType.EXPENSE, '40', from, nobody); // lower boundary
      await createTransaction(spaceId, catA.id, TransactionType.EXPENSE, '15', to); // upper boundary
      await createTransaction(spaceId, catIncome.id, TransactionType.INCOME, '500', new Date(2026, 2, 12));
      await createTransaction(spaceId, catA.id, TransactionType.EXPENSE, '5', new Date(from.getTime() - 1)); // outside
      await createTransaction(spaceId, catA.id, TransactionType.EXPENSE, '7', new Date(to.getTime() + 1)); // outside
      await createTransaction(spaceId, catA.id, TransactionType.EXPENSE, '60', new Date(2026, 2, 11), nobody);

      const categoryTotals = await transactionQueriesService.getExpensesByCategory(spaceId, from, to);
      expect(categoryTotals.get(catA.id)).toBe(17525n);
      expect(categoryTotals.get(catB.id)).toBe(4000n);
      expect(categoryTotals.has(catIncome.id)).toBe(false);
    });
  });

  describe('limit spending calculated from real aggregated expenses', () => {
    it('tracks the total across every expense, sums a group limit fractionally, and flags over_allocation', async () => {
      const spaceId = await createSpace();
      const catX = await createCategory(spaceId, TransactionType.EXPENSE, { name: 'X' });
      const catY = await createCategory(spaceId, TransactionType.EXPENSE, { name: 'Y' });
      const catZ = await createCategory(spaceId, TransactionType.EXPENSE, { name: 'Z (no limit)' });

      const from = new Date(2026, 3, 1, 0, 0, 0, 0);
      const to = new Date(2026, 3, 30, 23, 59, 59, 999);

      await createTransaction(spaceId, catX.id, TransactionType.EXPENSE, '12.34', new Date(2026, 3, 5));
      await createTransaction(spaceId, catX.id, TransactionType.EXPENSE, '0.01', new Date(2026, 3, 6));
      await createTransaction(spaceId, catY.id, TransactionType.EXPENSE, '45.65', new Date(2026, 3, 7));
      await createTransaction(spaceId, catZ.id, TransactionType.EXPENSE, '100', new Date(2026, 3, 8));

      const userId = await createUserWithMembership(spaceId);
      await limitsService.create(userId, spaceId, { amount: '50' }); // monthly total, less than the group's own amount
      await limitsService.create(userId, spaceId, {
        category_ids: [catX.id, catY.id],
        name: 'Fun',
        amount: '100',
      });

      const categoryTotals = await transactionQueriesService.getExpensesByCategory(spaceId, from, to);
      const limits = await limitsService.getAll(spaceId);
      const result = limitsService.calculateSpending(limits, categoryTotals);

      // total tracks ALL expenses, including catZ which no category limit covers
      expect(result.total).toMatchObject({ amount: '50.00', spent: 158, in_percent: 316 });

      expect(result.categories).toHaveLength(1);
      expect(result.categories[0]).toMatchObject({ name: 'Fun', spent: 58, in_percent: 58 });

      expect(result.over_allocation).toEqual({ category_total: 100, difference: 50 });
    });
  });

  describe('batched category ownership checks', () => {
    it('rejects a batch containing a missing id, a foreign-space id, or a system category, without one query per id', async () => {
      const spaceId = await createSpace();
      const otherSpaceId = await createSpace();
      const userId = await createUserWithMembership(spaceId);
      const req: AuthedRequest = { user: { id: userId } };

      const valid = await createCategory(spaceId, TransactionType.EXPENSE, { name: 'Valid' });
      const systemCategory = await createCategory(spaceId, TransactionType.EXPENSE, {
        name: 'System',
        is_system: 1,
      });
      const foreign = await createCategory(otherSpaceId, TransactionType.EXPENSE, { name: 'Foreign' });
      const missingId = valid.id + foreign.id + systemCategory.id + 1_000_000;

      await expect(
        limitsController.create(req, spaceId, { category_ids: [valid.id, missingId], amount: '10' }),
      ).rejects.toMatchObject(new HttpException(ErrorMessages.FORBIDDEN_CATEGORY, 403));

      await expect(
        limitsController.create(req, spaceId, { category_ids: [valid.id, foreign.id], amount: '10' }),
      ).rejects.toMatchObject(new HttpException(ErrorMessages.FORBIDDEN_CATEGORY, 403));

      await expect(
        limitsController.create(req, spaceId, { category_ids: [systemCategory.id], amount: '10' }),
      ).rejects.toMatchObject(new HttpException(ErrorMessages.CATEGORY_IS_SYSTEM, 400));

      const created = await limitsController.create(req, spaceId, { category_ids: [valid.id], amount: '10' });
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
