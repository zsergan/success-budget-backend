import request from 'supertest';

import { SpaceAccessService } from '@modules/space-access/space-access.service';
import { type Member, type TestApp, createTestApp, createVerifiedMember, deleteUsers } from './support/app';
import { LOCK_MEMBERS, overlap, pauseAfterFirstCall } from './support/concurrency';
import { createOpenApiDocument, okResponseSchema, schemaErrors } from './support/openapi';

const SHARE_MEMBERS = '%FROM `space_members` `row`%FOR SHARE%';

interface Space {
  id: number;
  owner: Member;
  lena: Member;
  mark: Member;
  categoryId: number;
  walletId: number;
}

// v1 and v2 clients against the same spaces (docs/transactions-v2-contract.md).
describe('Transactions v2 next to v1 (e2e)', () => {
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

  function api(member: Member) {
    const agent = request(testApp.app.getHttpServer());
    const withAuth =
      (method: 'get' | 'post' | 'put' | 'patch' | 'delete') =>
      (url: string): request.Test =>
        agent[method](url).set('Authorization', `Bearer ${member.token}`);

    return {
      get: withAuth('get'),
      post: withAuth('post'),
      put: withAuth('put'),
      patch: withAuth('patch'),
      delete: withAuth('delete'),
    };
  }

  const v1 = (spaceId: number) => `/api/v1/spaces/${spaceId}`;
  const v2 = (spaceId: number) => `/api/v2/spaces/${spaceId}/transactions`;

  // a group space of `owner`, joined by `lena` and `mark`, with one v1 wallet
  async function setup(): Promise<Space> {
    const owner = await createVerifiedMember(testApp, 'v2-owner');
    const lena = await createVerifiedMember(testApp, 'v2-lena');
    const mark = await createVerifiedMember(testApp, 'v2-mark');
    userIds.push(owner.userId, lena.userId, mark.userId);

    const space = await api(owner)
      .post('/api/v1/spaces')
      .send({ name: 'Family', type: 'group', currency_id: testApp.currencyId })
      .expect(201);
    const id: number = space.body.id;

    for (const member of [lena, mark]) {
      await testApp.dataSource.query("INSERT INTO space_members (space_id, user_id, role) VALUES (?, ?, 'member')", [
        id,
        member.userId,
      ]);
    }

    const categories = await api(owner)
      .get(`${v1(id)}/categories`)
      .expect(200);
    const wallet = await api(owner)
      .post(`${v1(id)}/wallets`)
      .send({ wallet_name: 'Card', initial_balance: '0', design: 'slate' })
      .expect(201);

    return { id, owner, lena, mark, categoryId: categories.body.expenses[0].id, walletId: wallet.body.wallet.id };
  }

  const expenseV2 = (s: Space, assignment: object, extra: object = {}) => ({
    category_id: s.categoryId,
    transaction_type: 'expense',
    amount: '12.3',
    timestamp: '2026-09-15T10:00:00.000Z',
    assignment,
    ...extra,
  });

  const expenseV1 = (s: Space, extra: object = {}) => ({
    wallet_id: s.walletId,
    category_id: s.categoryId,
    transaction_type: 'expense',
    amount: '7.00',
    timestamp: '2026-09-16T10:00:00.000Z',
    ...extra,
  });

  const forMember = (member: Member) => ({ kind: 'member', user_id: member.userId });

  async function compatibilityWallets(spaceId: number) {
    return testApp.dataSource.query<{ id: number; is_deleted: number; compat_space_id: number | null }[]>(
      "SELECT id, is_deleted, compat_space_id FROM wallets WHERE space_id = ? AND wallet_name = 'Shared transactions'",
      [spaceId],
    );
  }

  describe('reading both ways', () => {
    it('creates through v2, by the caller for a member, and reads it through v2 and v1', async () => {
      const s = await setup();

      const created = await api(s.owner)
        .post(v2(s.id))
        .send(expenseV2(s, forMember(s.lena)))
        .expect(201);

      expect(created.body.transaction).toEqual(
        expect.objectContaining({
          amount: '12.30',
          version: 1,
          author: { user_id: s.owner.userId, name: 'E2E', status: 'member', source: 'recorded' },
          assignment: { kind: 'member', user_id: s.lena.userId, name: 'E2E', status: 'member' },
        }),
      );
      expect(created.body.transaction).not.toHaveProperty('wallet');

      const id = created.body.transaction.id;
      const viaV2 = await api(s.mark)
        .get(`${v2(s.id)}/${id}`)
        .expect(200);
      expect(viaV2.body).toEqual(created.body.transaction);

      const viaV1 = await api(s.mark)
        .get(`${v1(s.id)}/transactions/${id}`)
        .expect(200);
      expect(viaV1.body).toEqual(
        expect.objectContaining({
          id,
          amount: '12.30',
          wallet: expect.objectContaining({ wallet_name: 'Shared transactions' }),
        }),
      );
      expect(viaV1.body).not.toHaveProperty('author');

      const wallets = await api(s.mark)
        .get(`${v1(s.id)}/wallets`)
        .expect(200);
      expect(
        wallets.body.wallets.map((summary: { wallet: { wallet_name: string } }) => summary.wallet.wallet_name),
      ).toContain('Shared transactions');
    });

    it('keeps v2 records in one compatibility wallet per space, also under concurrent creates', async () => {
      const s = await setup();

      await Promise.all(
        [s.owner, s.lena, s.mark].map((member) =>
          api(member)
            .post(v2(s.id))
            .send(expenseV2(s, { kind: 'space' }))
            .expect(201),
        ),
      );

      expect(await compatibilityWallets(s.id)).toEqual([
        expect.objectContaining({ is_deleted: 0, compat_space_id: s.id }),
      ]);
    });

    it('replaces a compatibility wallet a v1 client deleted on the next v2 create', async () => {
      const s = await setup();
      await api(s.owner)
        .post(v2(s.id))
        .send(expenseV2(s, { kind: 'space' }))
        .expect(201);
      const [first] = await compatibilityWallets(s.id);

      await api(s.owner)
        .delete(`${v1(s.id)}/wallets/${first.id}`)
        .expect(200);
      await api(s.owner)
        .post(v2(s.id))
        .send(expenseV2(s, { kind: 'unassigned' }))
        .expect(201);

      expect(await compatibilityWallets(s.id)).toEqual([
        expect.objectContaining({ id: first.id, is_deleted: 1, compat_space_id: null }),
        expect.objectContaining({ is_deleted: 0, compat_space_id: s.id }),
      ]);
    });

    it('reads a v1 create through v2 as recorded by its creator for the whole space', async () => {
      const s = await setup();

      const created = await api(s.lena)
        .post(`${v1(s.id)}/transactions`)
        .send(expenseV1(s))
        .expect(201);
      const read = await api(s.owner)
        .get(`${v2(s.id)}/${created.body.transaction.id}`)
        .expect(200);

      expect(read.body).toEqual(
        expect.objectContaining({
          author: { user_id: s.lena.userId, name: 'E2E', status: 'member', source: 'recorded' },
          assignment: { kind: 'space', user_id: null, name: null, status: null },
        }),
      );
    });

    it('matches the OpenAPI schemas', async () => {
      const s = await setup();
      const document = createOpenApiDocument(testApp.app);
      const created = await api(s.owner)
        .post(v2(s.id))
        .send(expenseV2(s, forMember(s.lena)))
        .expect(201);
      const read = await api(s.owner)
        .get(`${v2(s.id)}/${created.body.transaction.id}`)
        .expect(200);

      expect(
        schemaErrors(document, okResponseSchema(document, 'v2/spaces/{spaceId}/transactions', 'post'), created.body),
      ).toEqual([]);
      expect(
        schemaErrors(
          document,
          okResponseSchema(document, 'v2/spaces/{spaceId}/transactions/{transactionId}'),
          read.body,
        ),
      ).toEqual([]);
    });
  });

  describe('a new space', () => {
    it('takes v2 records right away, without any wallet to set up', async () => {
      const owner = await createVerifiedMember(testApp, 'v2-new-space');
      userIds.push(owner.userId);
      const space = await api(owner)
        .post('/api/v1/spaces')
        .send({ name: 'Trip', type: 'group', currency_id: testApp.currencyId })
        .expect(201);
      const categories = await api(owner)
        .get(`${v1(space.body.id)}/categories`)
        .expect(200);

      await api(owner)
        .post(v2(space.body.id))
        .send({
          category_id: categories.body.expenses[0].id,
          transaction_type: 'expense',
          amount: '5',
          timestamp: '2026-09-15T10:00:00.000Z',
          assignment: forMember(owner),
        })
        .expect(201);

      expect(await compatibilityWallets(space.body.id)).toHaveLength(1);
    });
  });

  describe('author and assignment on edit', () => {
    it('keeps them through a v1 edit of the amount, the date, the category and the wallet', async () => {
      const s = await setup();
      const created = await api(s.owner)
        .post(v2(s.id))
        .send(expenseV2(s, forMember(s.lena)))
        .expect(201);
      const { id } = created.body.transaction;
      const categories = await api(s.owner)
        .get(`${v1(s.id)}/categories`)
        .expect(200);

      await api(s.mark)
        .patch(`${v1(s.id)}/transactions/${id}`)
        .set('If-Match', '1')
        .send({
          amount: '20',
          timestamp: '2026-09-17T10:00:00.000Z',
          category_id: categories.body.expenses[1].id,
          wallet_id: s.walletId,
        })
        .expect(200);

      const read = await api(s.owner)
        .get(`${v2(s.id)}/${id}`)
        .expect(200);
      expect(read.body).toEqual(
        expect.objectContaining({
          amount: '20.00',
          version: 2,
          author: expect.objectContaining({ user_id: s.owner.userId, source: 'recorded' }),
          assignment: expect.objectContaining({ kind: 'member', user_id: s.lena.userId }),
        }),
      );
    });

    it('changes the assignment through v2, keeping the author, and bumps the version', async () => {
      const s = await setup();
      const created = await api(s.owner)
        .post(v2(s.id))
        .send(expenseV2(s, forMember(s.lena)))
        .expect(201);

      const updated = await api(s.mark)
        .patch(`${v2(s.id)}/${created.body.transaction.id}`)
        .set('If-Match', '1')
        .send({ assignment: { kind: 'space' } })
        .expect(200);

      expect(updated.body.transaction).toEqual(
        expect.objectContaining({
          version: 2,
          author: expect.objectContaining({ user_id: s.owner.userId }),
          assignment: { kind: 'space', user_id: null, name: null, status: null },
        }),
      );
    });

    it('writes nothing for an edit equal to the record, assignment included', async () => {
      const s = await setup();
      const created = await api(s.owner)
        .post(v2(s.id))
        .send(expenseV2(s, forMember(s.lena)))
        .expect(201);

      const same = await api(s.owner)
        .patch(`${v2(s.id)}/${created.body.transaction.id}`)
        .set('If-Match', '1')
        .send({ amount: '12.30', assignment: forMember(s.lena) })
        .expect(200);

      expect(same.body.transaction.version).toBe(1);
    });

    it('refuses a stale version', async () => {
      const s = await setup();
      const created = await api(s.owner)
        .post(v2(s.id))
        .send(expenseV2(s, { kind: 'space' }))
        .expect(201);
      const path = `${v2(s.id)}/${created.body.transaction.id}`;
      await api(s.owner).patch(path).set('If-Match', '1').send({ amount: '1' }).expect(200);

      const stale = await api(s.lena).patch(path).set('If-Match', '1').send({ amount: '2' }).expect(409);

      expect(stale.body.code).toBe('TRANSACTION_VERSION_CONFLICT');
      await api(s.lena).delete(path).set('If-Match', '1').expect(409);
    });

    it('keeps a former member assignment that an edit does not change, and refuses one it sets', async () => {
      const s = await setup();
      const created = await api(s.mark)
        .post(v2(s.id))
        .send(expenseV2(s, forMember(s.lena)))
        .expect(201);
      const path = `${v2(s.id)}/${created.body.transaction.id}`;
      await api(s.owner).delete(`/api/v1/spaces/${s.id}/members/${s.lena.userId}`).expect(200);

      const kept = await api(s.mark)
        .patch(path)
        .set('If-Match', '1')
        .send({ amount: '15', assignment: forMember(s.lena) })
        .expect(200);
      expect(kept.body.transaction.assignment).toEqual({
        kind: 'member',
        user_id: s.lena.userId,
        name: 'E2E',
        status: 'former_member',
      });

      await api(s.mark)
        .patch(path)
        .set('If-Match', '2')
        .send({ assignment: { kind: 'unassigned' } })
        .expect(200);
      const back = await api(s.mark)
        .patch(path)
        .set('If-Match', '3')
        .send({ assignment: forMember(s.lena) })
        .expect(400);
      expect(back.body.code).toBe('ASSIGNEE_NOT_MEMBER');
    });

    it('resolves a member who rejoined as a member again', async () => {
      const s = await setup();
      const created = await api(s.owner)
        .post(v2(s.id))
        .send(expenseV2(s, forMember(s.lena)))
        .expect(201);
      await api(s.owner).delete(`/api/v1/spaces/${s.id}/members/${s.lena.userId}`).expect(200);
      await testApp.dataSource.query("INSERT INTO space_members (space_id, user_id, role) VALUES (?, ?, 'member')", [
        s.id,
        s.lena.userId,
      ]);

      const read = await api(s.owner)
        .get(`${v2(s.id)}/${created.body.transaction.id}`)
        .expect(200);

      expect(read.body.assignment).toEqual(expect.objectContaining({ user_id: s.lena.userId, status: 'member' }));
    });
  });

  describe('assignees', () => {
    it('assigns to another member, the whole space or nobody, for expenses and income', async () => {
      const s = await setup();
      const categories = await api(s.owner)
        .get(`${v1(s.id)}/categories`)
        .expect(200);
      const income = { category_id: categories.body.incomes[0].id, transaction_type: 'income' };

      for (const assignment of [forMember(s.mark), { kind: 'space' }, { kind: 'unassigned' }]) {
        await api(s.lena).post(v2(s.id)).send(expenseV2(s, assignment)).expect(201);
        await api(s.lena)
          .post(v2(s.id))
          .send(expenseV2(s, assignment, income))
          .expect(201);
      }
    });

    it.each([
      ['a user of no space of theirs', 'outsider'],
      ['a member who was removed', 'removed'],
    ])('refuses %s', async (_label, who) => {
      const s = await setup();
      let userId = s.mark.userId;

      if (who === 'outsider') {
        const outsider = await createVerifiedMember(testApp, 'v2-outsider');
        userIds.push(outsider.userId);
        userId = outsider.userId;
      } else {
        await api(s.owner).delete(`/api/v1/spaces/${s.id}/members/${s.mark.userId}`).expect(200);
      }

      const refused = await api(s.owner)
        .post(v2(s.id))
        .send(expenseV2(s, { kind: 'member', user_id: userId }))
        .expect(400);

      expect(refused.body).toEqual(expect.objectContaining({ code: 'ASSIGNEE_NOT_MEMBER' }));
    });

    it.each([
      [{ kind: 'member' }, 'assignment.user_id'],
      [{ kind: 'space', user_id: 1 }, 'assignment.user_id'],
      [{ kind: 'everyone' }, 'assignment.kind'],
      ['space', 'assignment'],
    ])('refuses the assignment %p', async (assignment, field) => {
      const s = await setup();

      const refused = await api(s.owner)
        .post(v2(s.id))
        .send(expenseV2(s, {}, { assignment }))
        .expect(400);

      expect(refused.body.code).toBe('VALIDATION_FAILED');
      expect(refused.body.message.map((error: { field: string }) => error.field)).toContain(field);
    });

    it('refuses a create without an assignment, or with a wallet', async () => {
      const s = await setup();
      const missing = await api(s.owner)
        .post(v2(s.id))
        .send({ ...expenseV2(s, {}), assignment: undefined })
        .expect(400);
      const wallet = await api(s.owner)
        .post(v2(s.id))
        .send(expenseV2(s, { kind: 'space' }, { wallet_id: s.walletId }))
        .expect(400);

      expect(missing.body.message).toContainEqual(expect.objectContaining({ field: 'assignment' }));
      expect(wallet.body.message).toContainEqual(expect.objectContaining({ field: 'wallet_id' }));
    });
  });

  describe('assignment against member removal', () => {
    it('commits a create that holds the assignee first; the removal then waits and the record keeps them', async () => {
      const s = await setup();
      const checkpoint = pauseAfterFirstCall(testApp.app.get(SpaceAccessService), 'lockMemberships');

      const [created] = await overlap(
        testApp.dataSource,
        checkpoint,
        LOCK_MEMBERS,
        () =>
          api(s.owner)
            .post(v2(s.id))
            .send(expenseV2(s, forMember(s.lena))),
        () => api(s.owner).delete(`/api/v1/spaces/${s.id}/members/${s.lena.userId}`).expect(200),
      );

      expect(created.status).toBe(201);
      const read = await api(s.owner)
        .get(`${v2(s.id)}/${created.body.transaction.id}`)
        .expect(200);
      expect(read.body.assignment).toEqual(
        expect.objectContaining({ user_id: s.lena.userId, status: 'former_member' }),
      );
    });

    it('refuses a create whose assignee was removed first, while it waited', async () => {
      const s = await setup();
      const checkpoint = pauseAfterFirstCall(testApp.app.get(SpaceAccessService), 'lockMembers');

      const [, refused] = await overlap(
        testApp.dataSource,
        checkpoint,
        SHARE_MEMBERS,
        () => api(s.owner).delete(`/api/v1/spaces/${s.id}/members/${s.lena.userId}`).expect(200),
        () =>
          api(s.mark)
            .post(v2(s.id))
            .send(expenseV2(s, forMember(s.lena))),
      );

      expect(refused.status).toBe(400);
      expect(refused.body.code).toBe('ASSIGNEE_NOT_MEMBER');
    });
  });

  describe('retries', () => {
    it('answers repeated and concurrent creates with one key with the original result, creating one record', async () => {
      const s = await setup();
      const body = expenseV2(s, { kind: 'space' }, { client_operation_id: '1b4e28ba-2fa1-41d2-883f-0016d3cca427' });
      const send = () => api(s.owner).post(v2(s.id)).set('Idempotency-Key', 'v2-create').send(body);

      const [a, b] = await Promise.all([send(), send()]);
      const c = await send();

      expect([a.status, b.status, c.status]).toEqual([201, 201, 201]);
      expect(b.body).toEqual(a.body);
      expect(c.body).toEqual(a.body);
      const [{ count }] = await testApp.dataSource.query(
        'SELECT COUNT(*) AS count FROM transactions WHERE space_id = ?',
        [s.id],
      );
      expect(Number(count)).toBe(1);
    });

    it('creates once for one operation id sent concurrently with different keys', async () => {
      const s = await setup();
      const body = expenseV2(s, { kind: 'space' }, { client_operation_id: '6fa459ea-ee8a-4ca4-894e-db77e160355e' });

      const results = await Promise.all(
        ['k-1', 'k-2', 'k-3'].map((key) => api(s.owner).post(v2(s.id)).set('Idempotency-Key', key).send(body)),
      );

      expect(results.map((result) => result.status).sort()).toEqual([201, 409, 409]);
      expect(results.filter((result) => result.status === 409).map((result) => result.body.code)).toEqual([
        'TRANSACTION_OPERATION_EXISTS',
        'TRANSACTION_OPERATION_EXISTS',
      ]);
    });

    it('never answers a v2 create with a stored v1 result, and shares the operation id across versions', async () => {
      const s = await setup();
      const operationId = '0f8e3b1c-5d2a-4e8f-9a61-2c7d4b5e6f70';

      const legacy = await api(s.owner)
        .post(`${v1(s.id)}/transactions`)
        .set('Idempotency-Key', operationId)
        .send(expenseV1(s, { client_operation_id: operationId }))
        .expect(201);
      expect(legacy.body).toHaveProperty('wallet');

      const converted = await api(s.owner)
        .post(v2(s.id))
        .set('Idempotency-Key', operationId)
        .send(expenseV2(s, { kind: 'space' }, { client_operation_id: operationId }))
        .expect(409);
      expect(converted.body.code).toBe('TRANSACTION_OPERATION_EXISTS');

      const other = await api(s.owner)
        .post(v2(s.id))
        .set('Idempotency-Key', operationId)
        .send(expenseV2(s, { kind: 'space' }))
        .expect(201);
      expect(other.body).not.toHaveProperty('wallet');

      const lookup = await api(s.owner)
        .get(`${v2(s.id)}/operations/${operationId}`)
        .expect(200);
      expect(lookup.body).toEqual(
        expect.objectContaining({
          status: 'applied',
          transaction_id: legacy.body.transaction.id,
          transaction: expect.objectContaining({ author: expect.objectContaining({ user_id: s.owner.userId }) }),
        }),
      );
      expect(lookup.body.transaction).not.toHaveProperty('wallet');
    });

    it('reports a deleted create through the lookup, and answers a repeated delete with true', async () => {
      const s = await setup();
      const operationId = '9a1f4c2e-7b3d-4e6a-8c5f-1d2e3f4a5b6c';
      const created = await api(s.owner)
        .post(v2(s.id))
        .send(expenseV2(s, { kind: 'space' }, { client_operation_id: operationId }))
        .expect(201);
      const path = `${v2(s.id)}/${created.body.transaction.id}`;

      await api(s.lena).delete(path).set('If-Match', '1').set('Idempotency-Key', 'undo').expect(200);
      await api(s.lena).delete(path).set('If-Match', '1').set('Idempotency-Key', 'undo').expect(200);
      await api(s.lena).delete(path).set('If-Match', '1').expect(404);

      const lookup = await api(s.mark)
        .get(`${v2(s.id)}/operations/${operationId}`)
        .expect(200);
      expect(lookup.body).toEqual(expect.objectContaining({ status: 'deleted', transaction: null }));
    });
  });

  describe('other spaces', () => {
    it("refuses another space's category, member and records", async () => {
      const s = await setup();
      const other = await setup();
      const foreign = await api(other.owner)
        .post(v2(other.id))
        .send(expenseV2(other, { kind: 'space' }))
        .expect(201);
      const foreignPath = `${v2(s.id)}/${foreign.body.transaction.id}`;

      const category = await api(s.owner)
        .post(v2(s.id))
        .send(expenseV2(s, { kind: 'space' }, { category_id: other.categoryId }))
        .expect(403);
      const member = await api(s.owner)
        .post(v2(s.id))
        .send(expenseV2(s, forMember(other.lena)))
        .expect(400);

      expect(category.body.code).toBe('FORBIDDEN_CATEGORY');
      expect(member.body.code).toBe('ASSIGNEE_NOT_MEMBER');
      await api(s.owner).get(foreignPath).expect(404);
      await api(s.owner).patch(foreignPath).set('If-Match', '1').send({ amount: '1' }).expect(404);
      await api(s.owner).delete(foreignPath).set('If-Match', '1').expect(404);
      await api(s.owner)
        .get(`${v2(other.id)}/${foreign.body.transaction.id}`)
        .expect(403);
    });
  });
});
