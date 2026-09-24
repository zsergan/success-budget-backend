import { HttpException, INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.config';

import { Space } from '@entities/space.entity';
import { SpaceMember } from '@entities/space-member.entity';
import { User } from '@entities/user.entity';
import { Currency } from '@entities/currency.entity';
import { Category } from '@entities/category.entity';
import { LimitsService } from '@modules/limits/limits.service';
import { AppColor, CategoryIcon, LimitType, SpaceRole, SpaceType, TransactionType } from '@shared/enums';
import { ErrorMessages } from '@shared/error-messages';

const ROUNDS = 5;

describe('Concurrent limit writes (e2e)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let limitsService: LimitsService;
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
    limitsService = moduleFixture.get(LimitsService);

    const [currency] = await dataSource.getRepository(Currency).find({ take: 1 });
    currencyId = currency.id;
  });

  afterAll(async () => {
    try {
      if (spaceIds.length) {
        await dataSource.query(
          'DELETE lc FROM limit_categories lc INNER JOIN limits l ON l.id = lc.limit_id WHERE l.space_id IN (?)',
          [spaceIds],
        );
        await dataSource.query('DELETE FROM limits WHERE space_id IN (?)', [spaceIds]);
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

  async function createSpaceWithOwner(): Promise<{ spaceId: number; userId: number }> {
    const space = await dataSource.getRepository(Space).save({
      name: `e2e-limit-race-${Date.now()}-${Math.random()}`,
      type: SpaceType.PERSONAL,
      currency_id: currencyId,
    });
    spaceIds.push(space.id);

    const user = await dataSource.getRepository(User).save({
      email: `e2e-limit-race-${Date.now()}-${Math.random()}@example.com`,
      name: 'E2E limit race',
      password: 'DevTest#2026',
    });
    userIds.push(user.id);

    await dataSource.getRepository(SpaceMember).save({ space_id: space.id, user_id: user.id, role: SpaceRole.OWNER });

    return { spaceId: space.id, userId: user.id };
  }

  async function createCategory(spaceId: number): Promise<number> {
    const category = await dataSource.getRepository(Category).save({
      space_id: spaceId,
      name: 'Race',
      transaction_type: TransactionType.EXPENSE,
      icon: CategoryIcon.OTHER,
      color: AppColor.SLATE,
      is_active: 1,
      is_system: 0,
    });

    return category.id;
  }

  function expectOneWinner(results: PromiseSettledResult<unknown>[]): void {
    const rejected = results.filter((result) => result.status === 'rejected');

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toMatchObject(new HttpException(ErrorMessages.LIMIT_EXISTS, 400));
  }

  async function linkedLimitIds(categoryId: number): Promise<number[]> {
    const rows: { limit_id: number }[] = await dataSource.query(
      'SELECT limit_id FROM limit_categories WHERE category_id = ?',
      [categoryId],
    );

    return rows.map((row) => row.limit_id);
  }

  it('creates only one monthly total limit per space', async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const { spaceId, userId } = await createSpaceWithOwner();

      const results = await Promise.allSettled([
        limitsService.create(userId, spaceId, { amount: '100' }),
        limitsService.create(userId, spaceId, { amount: '200' }),
      ]);

      expectOneWinner(results);
      const totals = await dataSource.query('SELECT id FROM limits WHERE space_id = ? AND limit_type = ?', [
        spaceId,
        LimitType.OTHERS,
      ]);
      expect(totals).toHaveLength(1);
    }
  });

  it('assigns a category to only one newly created limit', async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const { spaceId, userId } = await createSpaceWithOwner();
      const categoryId = await createCategory(spaceId);

      const results = await Promise.allSettled([
        limitsService.create(userId, spaceId, { category_ids: [categoryId], amount: '100' }),
        limitsService.create(userId, spaceId, { category_ids: [categoryId], amount: '200' }),
      ]);

      expectOneWinner(results);
      expect(await linkedLimitIds(categoryId)).toHaveLength(1);
      const limits = await dataSource.query('SELECT id FROM limits WHERE space_id = ?', [spaceId]);
      expect(limits).toHaveLength(1);
    }
  });

  it('moves a category to only one of two limits updated at once, leaving the loser unchanged', async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const { spaceId, userId } = await createSpaceWithOwner();
      const [first, second, contested] = [
        await createCategory(spaceId),
        await createCategory(spaceId),
        await createCategory(spaceId),
      ];
      const firstLimit = await limitsService.create(userId, spaceId, { category_ids: [first], amount: '100' });
      const secondLimit = await limitsService.create(userId, spaceId, { category_ids: [second], amount: '100' });

      const results = await Promise.allSettled([
        limitsService.update(userId, spaceId, firstLimit.id, { category_ids: [contested], amount: '300' }),
        limitsService.update(userId, spaceId, secondLimit.id, { category_ids: [contested], amount: '300' }),
      ]);

      expectOneWinner(results);
      const [winner] = await linkedLimitIds(contested);
      expect(await linkedLimitIds(contested)).toHaveLength(1);

      const loser = winner === firstLimit.id ? secondLimit : firstLimit;
      const loserCategory = winner === firstLimit.id ? second : first;
      expect(await linkedLimitIds(loserCategory)).toEqual([loser.id]);
      const [loserRow] = await dataSource.query('SELECT amount FROM limits WHERE id = ?', [loser.id]);
      expect(loserRow.amount).toBe('100.00');
    }
  });

  it('turns only one of two category limits into the monthly total', async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const { spaceId, userId } = await createSpaceWithOwner();
      const firstLimit = await limitsService.create(userId, spaceId, {
        category_ids: [await createCategory(spaceId)],
        amount: '100',
      });
      const secondLimit = await limitsService.create(userId, spaceId, {
        category_ids: [await createCategory(spaceId)],
        amount: '100',
      });

      const results = await Promise.allSettled([
        limitsService.update(userId, spaceId, firstLimit.id, { category_ids: [] }),
        limitsService.update(userId, spaceId, secondLimit.id, { category_ids: [] }),
      ]);

      expectOneWinner(results);
      const totals = await dataSource.query('SELECT id FROM limits WHERE space_id = ? AND limit_type = ?', [
        spaceId,
        LimitType.OTHERS,
      ]);
      expect(totals).toHaveLength(1);
    }
  });
});
