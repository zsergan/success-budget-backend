import request from 'supertest';
import { ObjectLiteral, Repository } from 'typeorm';

import { Category } from '@entities/category.entity';
import { SpaceAccessService } from '@modules/space-access/space-access.service';
import { AppColor, CategoryIcon, LimitType, TransactionType } from '@shared/enums';
import { ErrorMessages } from '@shared/error-messages';
import { createTestApp, createVerifiedMember, deleteUsers, Member, TestApp } from './support/app';
import { LOCK_SPACE, overlap, pauseAfterFirstCall } from './support/concurrency';

describe('Category changes and limit links (e2e)', () => {
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
    const created = await createVerifiedMember(testApp, 'category-links');
    userIds.push(created.userId);
    return created;
  }

  function api({ spaceId, token }: Member) {
    const server = testApp.app.getHttpServer();
    const base = `/api/v1/spaces/${spaceId}`;
    const auth = { Authorization: `Bearer ${token}` };
    return {
      createLimit: (body: object) => request(server).post(`${base}/limits`).set(auth).send(body),
      updateLimit: (limitId: number, body: object) =>
        request(server).put(`${base}/limits/${limitId}`).set(auth).send(body),
      archiveCategory: (categoryId: number) =>
        request(server).put(`${base}/categories/${categoryId}`).set(auth).send({ is_active: 0 }),
      deleteCategory: (categoryId: number) => request(server).delete(`${base}/categories/${categoryId}`).set(auth),
    };
  }

  async function createCategory(spaceId: number): Promise<number> {
    const category = await testApp.dataSource.getRepository(Category).save({
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
    const rows: { category_id: number }[] = await testApp.dataSource.query(
      'SELECT category_id FROM limit_categories WHERE limit_id = ? ORDER BY category_id',
      [limitId],
    );
    return rows.map((row) => row.category_id);
  }

  async function limitIds(spaceId: number): Promise<number[]> {
    const rows: { id: number }[] = await testApp.dataSource.query('SELECT id FROM limits WHERE space_id = ?', [
      spaceId,
    ]);
    return rows.map((row) => row.id);
  }

  async function categoryState(categoryId: number): Promise<{ is_active: number } | undefined> {
    const [row] = await testApp.dataSource.query('SELECT is_active FROM categories WHERE id = ?', [categoryId]);
    return row;
  }

  // no link to an archived or deleted category, and no category limit left without categories
  async function expectConsistentLinks(spaceId: number): Promise<void> {
    const badLinks = await testApp.dataSource.query(
      `SELECT lc.category_id FROM limit_categories lc
       INNER JOIN limits l ON l.id = lc.limit_id
       LEFT JOIN categories c ON c.id = lc.category_id
       WHERE l.space_id = ? AND (c.id IS NULL OR c.is_active = 0)`,
      [spaceId],
    );
    const emptyLimits = await testApp.dataSource.query(
      `SELECT l.id FROM limits l
       LEFT JOIN limit_categories lc ON lc.limit_id = l.id
       WHERE l.space_id = ? AND l.limit_type = ? AND lc.limit_id IS NULL`,
      [spaceId, LimitType.CATEGORY],
    );

    expect(badLinks).toEqual([]);
    expect(emptyLimits).toEqual([]);
  }

  function overlapOnSpaceLock<A, B>(first: () => PromiseLike<A>, second: () => PromiseLike<B>): Promise<[A, B]> {
    const checkpoint = pauseAfterFirstCall(testApp.app.get(SpaceAccessService), 'lockSpace');
    return overlap(testApp.dataSource, checkpoint, LOCK_SPACE, first, second);
  }

  describe('one request at a time', () => {
    it('keeps a group limit when one of its categories is archived, and deletes it with the last one', async () => {
      const owner = await member();
      const [first, second] = [await createCategory(owner.spaceId), await createCategory(owner.spaceId)];
      const limit = (await api(owner).createLimit({ category_ids: [first, second], name: 'Group', amount: '100' }))
        .body;

      expect((await api(owner).archiveCategory(first)).status).toBe(200);
      expect(await linkedCategoryIds(limit.id)).toEqual([second]);

      expect((await api(owner).archiveCategory(second)).status).toBe(200);
      expect(await limitIds(owner.spaceId)).toEqual([]);
    });

    it('deletes a category without history that is linked to a limit', async () => {
      const owner = await member();
      const [kept, deleted] = [await createCategory(owner.spaceId), await createCategory(owner.spaceId)];
      const group = (await api(owner).createLimit({ category_ids: [kept, deleted], name: 'Group', amount: '100' }))
        .body;
      const single = await createCategory(owner.spaceId);
      await api(owner).createLimit({ category_ids: [single], amount: '100' });

      const deletedFromGroup = await api(owner).deleteCategory(deleted);
      const deletedSingle = await api(owner).deleteCategory(single);

      expect([deletedFromGroup.status, deletedFromGroup.body]).toEqual([200, { archived: false }]);
      expect([deletedSingle.status, deletedSingle.body]).toEqual([200, { archived: false }]);
      expect(await linkedCategoryIds(group.id)).toEqual([kept]);
      expect(await limitIds(owner.spaceId)).toEqual([group.id]);
      expect(await categoryState(deleted)).toBeUndefined();
      expect(await categoryState(single)).toBeUndefined();
    });

    it('rolls back the unlink and the limit deletion when the archive write fails', async () => {
      const owner = await member();
      const categoryId = await createCategory(owner.spaceId);
      const limit = (await api(owner).createLimit({ category_ids: [categoryId], amount: '100' })).body;
      const originalSave = Repository.prototype.save;
      jest.spyOn(Repository.prototype, 'save').mockImplementation(function (
        this: Repository<ObjectLiteral>,
        ...args: Parameters<typeof originalSave>
      ) {
        if (this.target === Category) {
          return Promise.reject(new Error('injected category write failure'));
        }
        return Reflect.apply(originalSave, this, args);
      });

      const response = await api(owner).archiveCategory(categoryId);

      expect(response.status).toBe(500);
      expect(await limitIds(owner.spaceId)).toEqual([limit.id]);
      expect(await linkedCategoryIds(limit.id)).toEqual([categoryId]);
      expect(await categoryState(categoryId)).toEqual({ is_active: 1 });
    });
  });

  describe('overlapping requests', () => {
    it('archives both categories of a group and deletes the emptied limit', async () => {
      const owner = await member();
      const [first, second] = [await createCategory(owner.spaceId), await createCategory(owner.spaceId)];
      await api(owner).createLimit({ category_ids: [first, second], name: 'Group', amount: '100' });

      const [a, b] = await overlapOnSpaceLock(
        () => api(owner).archiveCategory(first),
        () => api(owner).archiveCategory(second),
      );

      expect([a.status, b.status]).toEqual([200, 200]);
      expect(await limitIds(owner.spaceId)).toEqual([]);
      await expectConsistentLinks(owner.spaceId);
    });

    it('rejects a limit update that picks a category archived just before it', async () => {
      const owner = await member();
      const contested = await createCategory(owner.spaceId);
      const other = await createCategory(owner.spaceId);
      const limit = (await api(owner).createLimit({ category_ids: [other], amount: '100' })).body;

      const [archive, update] = await overlapOnSpaceLock(
        () => api(owner).archiveCategory(contested),
        () => api(owner).updateLimit(limit.id, { category_ids: [contested] }),
      );

      expect(archive.status).toBe(200);
      expect(update.status).toBe(400);
      expect(update.body.message).toBe(ErrorMessages.CATEGORY_ARCHIVED);
      expect(await categoryState(contested)).toEqual({ is_active: 0 });
      expect(await linkedCategoryIds(limit.id)).toEqual([other]);
      await expectConsistentLinks(owner.spaceId);
    });

    it('unlinks a category archived right after a limit update picked it', async () => {
      const owner = await member();
      const contested = await createCategory(owner.spaceId);
      const limit = (
        await api(owner).createLimit({ category_ids: [await createCategory(owner.spaceId)], amount: '100' })
      ).body;

      const [update, archive] = await overlapOnSpaceLock(
        () => api(owner).updateLimit(limit.id, { category_ids: [contested] }),
        () => api(owner).archiveCategory(contested),
      );

      expect([update.status, archive.status]).toEqual([200, 200]);
      expect(await categoryState(contested)).toEqual({ is_active: 0 });
      expect(await limitIds(owner.spaceId)).toEqual([]);
      await expectConsistentLinks(owner.spaceId);
    });

    it('rejects a limit create for a category deleted just before it', async () => {
      const owner = await member();
      const contested = await createCategory(owner.spaceId);

      const [deletion, create] = await overlapOnSpaceLock(
        () => api(owner).deleteCategory(contested),
        () => api(owner).createLimit({ category_ids: [contested], amount: '100' }),
      );

      expect([deletion.status, deletion.body]).toEqual([200, { archived: false }]);
      expect(create.status).toBe(403);
      expect(create.body.message).toBe(ErrorMessages.FORBIDDEN_CATEGORY);
      expect(await limitIds(owner.spaceId)).toEqual([]);
      await expectConsistentLinks(owner.spaceId);
    });

    it('deletes a category and the limit created for it just before', async () => {
      const owner = await member();
      const contested = await createCategory(owner.spaceId);

      const [create, deletion] = await overlapOnSpaceLock(
        () => api(owner).createLimit({ category_ids: [contested], amount: '100' }),
        () => api(owner).deleteCategory(contested),
      );

      expect(create.status).toBe(201);
      expect([deletion.status, deletion.body]).toEqual([200, { archived: false }]);
      expect(await categoryState(contested)).toBeUndefined();
      expect(await limitIds(owner.spaceId)).toEqual([]);
      await expectConsistentLinks(owner.spaceId);
    });
  });
});
