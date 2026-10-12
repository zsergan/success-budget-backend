import request from 'supertest';

import { CategoriesService } from '@modules/categories/categories.service';
import { LimitsService } from '@modules/limits/limits.service';
import { SpaceAccessService } from '@modules/space-access/space-access.service';
import { type Member, type TestApp, createTestApp, createVerifiedMember, deleteUsers } from './support/app';
import { overlap, pauseAfterFirstCall } from './support/concurrency';

describe('Category and limit write access (e2e)', () => {
  let testApp: TestApp;
  const userIds: number[] = [];

  beforeAll(async () => {
    testApp = await createTestApp();
  });

  afterEach(() => jest.restoreAllMocks());

  afterAll(async () => {
    try {
      await deleteUsers(testApp.dataSource, userIds);
    } finally {
      await testApp.app.close();
    }
  });

  function api(member: Member, spaceId = member.spaceId) {
    const server = testApp.app.getHttpServer();
    const base = `/api/v1/spaces/${spaceId}`;
    const auth = { Authorization: `Bearer ${member.token}` };
    return {
      get: (path: string) =>
        request(server)
          .get(base + path)
          .set(auth),
      post: (path: string) =>
        request(server)
          .post(base + path)
          .set(auth),
      put: (path: string) =>
        request(server)
          .put(base + path)
          .set(auth),
      delete: (path: string) =>
        request(server)
          .delete(base + path)
          .set(auth),
    };
  }

  async function setup() {
    const owner = await createVerifiedMember(testApp, 'category-limit-access');
    const guest = await createVerifiedMember(testApp, 'category-limit-guest');
    userIds.push(owner.userId, guest.userId);
    await testApp.dataSource.query("INSERT INTO space_members (space_id, user_id, role) VALUES (?, ?, 'member')", [
      owner.spaceId,
      guest.userId,
    ]);
    const categories = await api(owner).get('/categories').expect(200);
    const categoryId: number = categories.body.expenses[0].id;
    const limit = await api(owner)
      .post('/limits')
      .send({ category_ids: [categoryId], amount: '100' })
      .expect(201);
    return { owner, guest, categoryId, limitId: limit.body.id as number };
  }

  it.each(['category', 'limit'] as const)('%s update finishes before removing its author', async (kind) => {
    const s = await setup();
    const checkpoint =
      kind === 'category'
        ? pauseAfterFirstCall(testApp.app.get(CategoriesService), 'getOne')
        : pauseAfterFirstCall(testApp.app.get(LimitsService), 'getOne');

    const [updated, removed] = await overlap(
      testApp.dataSource,
      checkpoint,
      'DELETE FROM `space_members`%',
      () =>
        kind === 'category'
          ? api(s.guest, s.owner.spaceId).put(`/categories/${s.categoryId}`).send({ name: 'Renamed' })
          : api(s.guest, s.owner.spaceId).put(`/limits/${s.limitId}`).send({ amount: '200' }),
      () => api(s.owner).delete(`/members/${s.guest.userId}`),
    );

    expect(updated.status).toBe(200);
    expect(removed.status).toBe(200);
    const forbidden = await api(s.guest, s.owner.spaceId)
      .put(kind === 'category' ? `/categories/${s.categoryId}` : `/limits/${s.limitId}`)
      .send(kind === 'category' ? { name: 'Forbidden' } : { amount: '300' })
      .expect(403);
    expect(forbidden.body.code).toBe('FORBIDDEN_SPACE');
  });

  const otherWrites: Array<[string, (s: Awaited<ReturnType<typeof setup>>) => request.Test, number]> = [
    [
      'category create',
      (s) =>
        api(s.guest, s.owner.spaceId).post('/categories').send({
          name: 'New',
          transaction_type: 'expense',
          icon: 'Other',
          color: 'slate',
        }),
      201,
    ],
    [
      'category reorder',
      (s) =>
        api(s.guest, s.owner.spaceId)
          .put('/categories/reorder')
          .send({ category_ids: [s.categoryId] }),
      200,
    ],
    ['category delete', (s) => api(s.guest, s.owner.spaceId).delete(`/categories/${s.categoryId}`), 200],
    ['limit create', (s) => api(s.guest, s.owner.spaceId).post('/limits').send({ amount: '200' }), 201],
    ['limit delete', (s) => api(s.guest, s.owner.spaceId).delete(`/limits/${s.limitId}`), 200],
  ];

  it.each(otherWrites)('%s holds access until commit and refuses a removed member', async (_, write, status) => {
    const s = await setup();
    const checkpoint = pauseAfterFirstCall(testApp.app.get(SpaceAccessService), 'lockSpace');
    const [written, removed] = await overlap(
      testApp.dataSource,
      checkpoint,
      'DELETE FROM `space_members`%',
      () => write(s),
      () => api(s.owner).delete(`/members/${s.guest.userId}`),
    );
    expect(written.status).toBe(status);
    expect(removed.status).toBe(200);
    const forbidden = await write(s).expect(403);
    expect(forbidden.body.code).toBe('FORBIDDEN_SPACE');
  });
});
