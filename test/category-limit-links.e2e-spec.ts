import { HttpException, INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { DataSource, Repository } from 'typeorm';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.config';

import { Space } from '@entities/space.entity';
import { SpaceMember } from '@entities/space-member.entity';
import { User } from '@entities/user.entity';
import { Currency } from '@entities/currency.entity';
import { Category } from '@entities/category.entity';
import { CategoriesService } from '@modules/categories/categories.service';
import { LimitsService } from '@modules/limits/limits.service';
import { AppColor, CategoryIcon, LimitType, SpaceRole, SpaceType, TransactionType } from '@shared/enums';

const ROUNDS = 5;

describe('Category changes and limit links (e2e)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let categoriesService: CategoriesService;
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
    categoriesService = moduleFixture.get(CategoriesService);
    limitsService = moduleFixture.get(LimitsService);

    const [currency] = await dataSource.getRepository(Currency).find({ take: 1 });
    currencyId = currency.id;
  });

  afterEach(() => {
    jest.restoreAllMocks();
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
      name: `e2e-category-links-${Date.now()}-${Math.random()}`,
      type: SpaceType.PERSONAL,
      currency_id: currencyId,
    });
    spaceIds.push(space.id);

    const user = await dataSource.getRepository(User).save({
      email: `e2e-category-links-${Date.now()}-${Math.random()}@example.com`,
      name: 'E2E category links',
      password: 'DevTest#2026',
    });
    userIds.push(user.id);

    await dataSource.getRepository(SpaceMember).save({ space_id: space.id, user_id: user.id, role: SpaceRole.OWNER });

    return { spaceId: space.id, userId: user.id };
  }

  async function createCategory(spaceId: number): Promise<number> {
    const category = await dataSource.getRepository(Category).save({
      space_id: spaceId,
      name: 'Linked',
      transaction_type: TransactionType.EXPENSE,
      icon: CategoryIcon.OTHER,
      color: AppColor.SLATE,
      is_active: 1,
      is_system: 0,
    });

    return category.id;
  }

  async function linkedCategoryIds(limitId: number): Promise<number[]> {
    const rows: { category_id: number }[] = await dataSource.query(
      'SELECT category_id FROM limit_categories WHERE limit_id = ? ORDER BY category_id',
      [limitId],
    );

    return rows.map((row) => row.category_id);
  }

  async function limitExists(limitId: number): Promise<boolean> {
    const rows = await dataSource.query('SELECT id FROM limits WHERE id = ?', [limitId]);

    return rows.length === 1;
  }

  async function expectConsistentLinks(spaceId: number): Promise<void> {
    const archivedOrMissingLinks = await dataSource.query(
      `SELECT lc.category_id FROM limit_categories lc
       INNER JOIN limits l ON l.id = lc.limit_id
       LEFT JOIN categories c ON c.id = lc.category_id
       WHERE l.space_id = ? AND (c.id IS NULL OR c.is_active = 0)`,
      [spaceId],
    );
    const emptyCategoryLimits = await dataSource.query(
      `SELECT l.id FROM limits l
       LEFT JOIN limit_categories lc ON lc.limit_id = l.id
       WHERE l.space_id = ? AND l.limit_type = ? AND lc.limit_id IS NULL`,
      [spaceId, LimitType.CATEGORY],
    );

    expect(archivedOrMissingLinks).toEqual([]);
    expect(emptyCategoryLimits).toEqual([]);
  }

  function expectOnlyBusinessErrors(results: PromiseSettledResult<unknown>[]): void {
    for (const result of results) {
      if (result.status === 'rejected') {
        expect(result.reason).toBeInstanceOf(HttpException);
        expect((result.reason as HttpException).getStatus()).toBeLessThan(500);
      }
    }
  }

  it('keeps a group limit when one of its categories is archived, and deletes it with the last one', async () => {
    const { spaceId, userId } = await createSpaceWithOwner();
    const [first, second] = [await createCategory(spaceId), await createCategory(spaceId)];
    const limit = await limitsService.create(userId, spaceId, {
      category_ids: [first, second],
      name: 'Group',
      amount: '100',
    });

    await categoriesService.update(userId, spaceId, first, { is_active: 0 });

    expect(await limitExists(limit.id)).toBe(true);
    expect(await linkedCategoryIds(limit.id)).toEqual([second]);

    await categoriesService.update(userId, spaceId, second, { is_active: 0 });

    expect(await limitExists(limit.id)).toBe(false);
  });

  it('deletes a category without history that is linked to a limit', async () => {
    const { spaceId, userId } = await createSpaceWithOwner();
    const [kept, deleted] = [await createCategory(spaceId), await createCategory(spaceId)];
    const group = await limitsService.create(userId, spaceId, {
      category_ids: [kept, deleted],
      name: 'Group',
      amount: '100',
    });
    const single = await limitsService.create(userId, spaceId, {
      category_ids: [await createCategory(spaceId)],
      amount: '100',
    });
    const [singleCategory] = await linkedCategoryIds(single.id);

    await expect(categoriesService.deleteOrArchive(userId, spaceId, deleted)).resolves.toEqual({ archived: false });
    await expect(categoriesService.deleteOrArchive(userId, spaceId, singleCategory)).resolves.toEqual({
      archived: false,
    });

    expect(await linkedCategoryIds(group.id)).toEqual([kept]);
    expect(await limitExists(single.id)).toBe(false);
    const remaining = await dataSource.query('SELECT id FROM categories WHERE id IN (?)', [[deleted, singleCategory]]);
    expect(remaining).toEqual([]);
  });

  it('rolls back the unlink and limit deletion when the archive write fails', async () => {
    const { spaceId, userId } = await createSpaceWithOwner();
    const categoryId = await createCategory(spaceId);
    const limit = await limitsService.create(userId, spaceId, { category_ids: [categoryId], amount: '100' });

    const failure = new Error('category write failed');
    const save = Repository.prototype.save;
    jest.spyOn(Repository.prototype, 'save').mockImplementation(function (this: Repository<object>, ...args) {
      if (this.metadata.target === Category) {
        return Promise.reject(failure);
      }
      return save.apply(this, args);
    });

    await expect(categoriesService.update(userId, spaceId, categoryId, { is_active: 0 })).rejects.toBe(failure);

    expect(await limitExists(limit.id)).toBe(true);
    expect(await linkedCategoryIds(limit.id)).toEqual([categoryId]);
    const [category] = await dataSource.query('SELECT is_active FROM categories WHERE id = ?', [categoryId]);
    expect(category.is_active).toBe(1);
  });

  it('archives both categories of a group at once and deletes the emptied limit', async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const { spaceId, userId } = await createSpaceWithOwner();
      const [first, second] = [await createCategory(spaceId), await createCategory(spaceId)];
      const limit = await limitsService.create(userId, spaceId, {
        category_ids: [first, second],
        name: 'Group',
        amount: '100',
      });

      const results = await Promise.allSettled([
        categoriesService.update(userId, spaceId, first, { is_active: 0 }),
        categoriesService.update(userId, spaceId, second, { is_active: 0 }),
      ]);

      expect(results.map((result) => result.status)).toEqual(['fulfilled', 'fulfilled']);
      expect(await limitExists(limit.id)).toBe(false);
      await expectConsistentLinks(spaceId);
    }
  });

  it('never links an archived category when archiving races a limit update', async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const { spaceId, userId } = await createSpaceWithOwner();
      const contested = await createCategory(spaceId);
      const limit = await limitsService.create(userId, spaceId, {
        category_ids: [await createCategory(spaceId)],
        amount: '100',
      });

      const results = await Promise.allSettled([
        categoriesService.update(userId, spaceId, contested, { is_active: 0 }),
        limitsService.update(userId, spaceId, limit.id, { category_ids: [contested] }),
      ]);

      expect(results[0].status).toBe('fulfilled');
      expectOnlyBusinessErrors(results);
      await expectConsistentLinks(spaceId);
    }
  });

  it('never leaves a dangling limit when deleting a category races a limit create', async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const { spaceId, userId } = await createSpaceWithOwner();
      const contested = await createCategory(spaceId);

      const results = await Promise.allSettled([
        categoriesService.deleteOrArchive(userId, spaceId, contested),
        limitsService.create(userId, spaceId, { category_ids: [contested], amount: '100' }),
      ]);

      expect(results[0].status).toBe('fulfilled');
      expectOnlyBusinessErrors(results);
      await expectConsistentLinks(spaceId);
    }
  });
});
