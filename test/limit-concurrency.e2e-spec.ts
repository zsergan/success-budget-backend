import request from 'supertest';
import { RelationQueryBuilder } from 'typeorm';

import { Category } from '@entities/category.entity';
import { SpaceAccessService } from '@modules/space-access/space-access.service';
import { AppColor, CategoryIcon, LimitType, TransactionType } from '@shared/enums';
import { ErrorMessages } from '@shared/error-messages';
import { createTestApp, createVerifiedMember, deleteUsers, Member, TestApp } from './support/app';
import { LOCK_SPACE, overlap, pauseAfterFirstCall } from './support/concurrency';

describe('Limit writes (e2e)', () => {
  let testApp: TestApp;
  const userIds: number[] = [];

  beforeAll(async () => {
    testApp = await createTestApp();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  afterAll(async () => {
    try {
      await deleteUsers(testApp.dataSource, userIds);
    } finally {
      await testApp.app.close();
    }
  });

  async function member(): Promise<Member> {
    const created = await createVerifiedMember(testApp, 'limits');
    userIds.push(created.userId);
    return created;
  }

  function api(token: string) {
    const server = testApp.app.getHttpServer();
    return {
      post: (path: string, body: object) =>
        request(server).post(path).set('Authorization', `Bearer ${token}`).send(body),
      put: (path: string, body: object) => request(server).put(path).set('Authorization', `Bearer ${token}`).send(body),
    };
  }

  async function createCategory(spaceId: number): Promise<number> {
    const category = await testApp.dataSource.getRepository(Category).save({
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

  async function limitRows(spaceId: number): Promise<{ id: number; limit_type: string; amount: string }[]> {
    return testApp.dataSource.query('SELECT id, limit_type, amount FROM limits WHERE space_id = ? ORDER BY id', [
      spaceId,
    ]);
  }

  async function linkedLimitIds(categoryId: number): Promise<number[]> {
    const rows: { limit_id: number }[] = await testApp.dataSource.query(
      'SELECT limit_id FROM limit_categories WHERE category_id = ?',
      [categoryId],
    );
    return rows.map((row) => row.limit_id);
  }

  async function linkedCategoryIds(limitId: number): Promise<number[]> {
    const rows: { category_id: number }[] = await testApp.dataSource.query(
      'SELECT category_id FROM limit_categories WHERE limit_id = ? ORDER BY category_id',
      [limitId],
    );
    return rows.map((row) => row.category_id);
  }

  function overlapOnSpaceLock<A, B>(first: () => PromiseLike<A>, second: () => PromiseLike<B>): Promise<[A, B]> {
    const checkpoint = pauseAfterFirstCall(testApp.app.get(SpaceAccessService), 'lockSpace');
    return overlap(testApp.dataSource, checkpoint, LOCK_SPACE, first, second);
  }

  describe('concurrent creates', () => {
    it('creates only one monthly total limit', async () => {
      const { spaceId, token } = await member();
      const path = `/api/v1/spaces/${spaceId}/limits`;

      const [first, second] = await overlapOnSpaceLock(
        () => api(token).post(path, { amount: '100' }),
        () => api(token).post(path, { amount: '200' }),
      );

      expect(first.status).toBe(201);
      expect(second.status).toBe(400);
      expect(second.body.message).toBe(ErrorMessages.LIMIT_EXISTS);
      expect(await limitRows(spaceId)).toEqual([{ id: first.body.id, limit_type: LimitType.OTHERS, amount: '100.00' }]);
    });

    it('assigns a category to only one new limit', async () => {
      const { spaceId, token } = await member();
      const categoryId = await createCategory(spaceId);
      const path = `/api/v1/spaces/${spaceId}/limits`;

      const [first, second] = await overlapOnSpaceLock(
        () => api(token).post(path, { category_ids: [categoryId], amount: '100' }),
        () => api(token).post(path, { category_ids: [categoryId], amount: '200' }),
      );

      expect(first.status).toBe(201);
      expect(second.status).toBe(400);
      expect(second.body.message).toBe(ErrorMessages.LIMIT_EXISTS);
      expect(await limitRows(spaceId)).toEqual([
        { id: first.body.id, limit_type: LimitType.CATEGORY, amount: '100.00' },
      ]);
      expect(await linkedLimitIds(categoryId)).toEqual([first.body.id]);
    });
  });

  describe('concurrent updates', () => {
    it('moves a category to only one of two limits and leaves the other unchanged', async () => {
      const { spaceId, token } = await member();
      const [first, second, contested] = [
        await createCategory(spaceId),
        await createCategory(spaceId),
        await createCategory(spaceId),
      ];
      const base = `/api/v1/spaces/${spaceId}/limits`;
      const firstLimit = (await api(token).post(base, { category_ids: [first], amount: '100' })).body;
      const secondLimit = (await api(token).post(base, { category_ids: [second], amount: '100' })).body;

      const [winner, loser] = await overlapOnSpaceLock(
        () => api(token).put(`${base}/${firstLimit.id}`, { category_ids: [contested], amount: '300' }),
        () => api(token).put(`${base}/${secondLimit.id}`, { category_ids: [contested], amount: '300' }),
      );

      expect(winner.status).toBe(200);
      expect(loser.status).toBe(400);
      expect(loser.body.message).toBe(ErrorMessages.LIMIT_EXISTS);
      expect(await linkedLimitIds(contested)).toEqual([firstLimit.id]);
      expect(await linkedCategoryIds(secondLimit.id)).toEqual([second]);
      const rows = await limitRows(spaceId);
      expect(rows.find((row) => row.id === secondLimit.id)?.amount).toBe('100.00');
    });

    it('turns only one of two category limits into the monthly total', async () => {
      const { spaceId, token } = await member();
      const base = `/api/v1/spaces/${spaceId}/limits`;
      const firstLimit = (await api(token).post(base, { category_ids: [await createCategory(spaceId)], amount: '100' }))
        .body;
      const secondCategory = await createCategory(spaceId);
      const secondLimit = (await api(token).post(base, { category_ids: [secondCategory], amount: '100' })).body;

      const [winner, loser] = await overlapOnSpaceLock(
        () => api(token).put(`${base}/${firstLimit.id}`, { category_ids: [] }),
        () => api(token).put(`${base}/${secondLimit.id}`, { category_ids: [] }),
      );

      expect(winner.status).toBe(200);
      expect(loser.status).toBe(400);
      expect(loser.body.message).toBe(ErrorMessages.LIMIT_EXISTS);
      const totals = (await limitRows(spaceId)).filter((row) => row.limit_type === LimitType.OTHERS);
      expect(totals.map((row) => row.id)).toEqual([firstLimit.id]);
      expect(await linkedCategoryIds(secondLimit.id)).toEqual([secondCategory]);
    });
  });

  describe('a failure between the field write and the category links', () => {
    function failCategoryLinks(): void {
      jest.spyOn(RelationQueryBuilder.prototype, 'add').mockRejectedValue(new Error('injected link failure'));
    }

    it('leaves no limit behind when creating', async () => {
      const { spaceId, token } = await member();
      const categoryId = await createCategory(spaceId);
      failCategoryLinks();

      const response = await api(token).post(`/api/v1/spaces/${spaceId}/limits`, {
        category_ids: [categoryId],
        amount: '100',
      });

      expect(response.status).toBe(500);
      expect(await limitRows(spaceId)).toEqual([]);
      expect(await linkedLimitIds(categoryId)).toEqual([]);
    });

    it('rolls back the new amount and the removed link when updating', async () => {
      const { spaceId, token } = await member();
      const [kept, added] = [await createCategory(spaceId), await createCategory(spaceId)];
      const base = `/api/v1/spaces/${spaceId}/limits`;
      const limit = (await api(token).post(base, { category_ids: [kept], amount: '100' })).body;
      failCategoryLinks();

      const response = await api(token).put(`${base}/${limit.id}`, { category_ids: [added], amount: '999' });

      expect(response.status).toBe(500);
      expect(await limitRows(spaceId)).toEqual([{ id: limit.id, limit_type: LimitType.CATEGORY, amount: '100.00' }]);
      expect(await linkedCategoryIds(limit.id)).toEqual([kept]);
    });
  });
});
