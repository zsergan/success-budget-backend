import request from 'supertest';
import type { OpenAPIObject } from '@nestjs/swagger';

import { type Member, type TestApp, createTestApp, createVerifiedMember, deleteUsers } from './support/app';
import { createOpenApiDocument } from './support/openapi';

// The rules of docs/transactions-contract.md a client relies on, pinned in
// one place: editing is PATCH, writes to an existing record need its version,
// every request amount stops at 99999999.99, and the monthly total limit
// counts every expense of the month.
describe('API contract (e2e)', () => {
  let testApp: TestApp;
  let document: OpenAPIObject;
  const userIds: number[] = [];

  beforeAll(async () => {
    testApp = await createTestApp();
    document = createOpenApiDocument(testApp.app);
  });

  afterAll(async () => {
    try {
      await deleteUsers(testApp.dataSource, userIds);
    } finally {
      await testApp.app.close();
    }
  });

  interface Space {
    member: Member;
    walletId: number;
    expenses: number[];
    incomeId: number;
  }

  async function space(): Promise<Space> {
    const member = await createVerifiedMember(testApp, 'api-contract');
    userIds.push(member.userId);
    const wallet = await api(member)
      .post('/wallets')
      .send({ wallet_name: 'Card', initial_balance: '0', design: 'slate' })
      .expect(201);
    const categories = await api(member).get('/categories').expect(200);

    return {
      member,
      walletId: wallet.body.wallet.id,
      expenses: categories.body.expenses.map((category: { id: number }) => category.id),
      incomeId: categories.body.incomes[0].id,
    };
  }

  function api(member: Member) {
    const agent = request(testApp.app.getHttpServer());
    const withAuth =
      (method: 'get' | 'post' | 'put' | 'patch' | 'delete') =>
      (path: string): request.Test =>
        agent[method](`/api/v1/spaces/${member.spaceId}${path}`).set('Authorization', `Bearer ${member.token}`);

    return {
      get: withAuth('get'),
      post: withAuth('post'),
      put: withAuth('put'),
      patch: withAuth('patch'),
      delete: withAuth('delete'),
    };
  }

  function createTransaction(s: Space, categoryId: number, amount: string, type = 'expense'): request.Test {
    return api(s.member)
      .post('/transactions')
      .send({
        wallet_id: s.walletId,
        category_id: categoryId,
        transaction_type: type,
        amount,
        timestamp: new Date(Date.now() - 1000).toISOString(),
      });
  }

  function operation(pathSuffix: string, method: string): { parameters?: { name: string; required?: boolean }[] } {
    const path = Object.keys(document.paths).find((candidate) => candidate.endsWith(pathSuffix))!;

    return (document.paths[path] as Record<string, never>)[method];
  }

  describe('identifier validation', () => {
    it.each(['post', 'put'] as const)(
      '%s rejects duplicate limit categories without changing the limit',
      async (method) => {
        const s = await space();
        const original = await api(s.member)
          .post('/limits')
          .send({ amount: '100', category_ids: [s.expenses[0]] })
          .expect(201);
        const path = method === 'post' ? '/limits' : `/limits/${original.body.id}`;
        const response = await api(s.member)
          [method](path)
          .send({ amount: '200', name: 'Group', category_ids: [s.expenses[1], s.expenses[1]] })
          .expect(400);
        expect(response.body.code).toBe('VALIDATION_FAILED');
        const limits = await api(s.member).get('/limits').expect(200);
        expect(limits.body.categories).toHaveLength(1);
        expect(limits.body.categories[0]).toMatchObject({
          id: original.body.id,
          amount: '100.00',
          categories: [{ id: s.expenses[0] }],
        });
      },
    );

    it.each([0, -1, 1.5, 2147483648])(
      'rejects invalid transaction ids %s before looking up a wallet or category',
      async (id) => {
        const s = await space();
        const created = await createTransaction(s, s.expenses[0], '10').expect(201);
        for (const field of ['wallet_id', 'category_id']) {
          const create = await api(s.member)
            .post('/transactions')
            .send({
              wallet_id: s.walletId,
              category_id: s.expenses[0],
              transaction_type: 'expense',
              amount: '10',
              timestamp: '2026-09-15T10:00:00.000Z',
              [field]: id,
            })
            .expect(400);
          const update = await api(s.member)
            .patch(`/transactions/${created.body.transaction.id}`)
            .set('If-Match', '1')
            .send({ [field]: id })
            .expect(400);
          expect(create.body.code).toBe('VALIDATION_FAILED');
          expect(update.body.code).toBe('VALIDATION_FAILED');
        }
      },
    );
  });

  describe('editing is PATCH', () => {
    it('updates with PATCH and has no PUT on a transaction', async () => {
      const s = await space();
      const created = await createTransaction(s, s.expenses[0], '10').expect(201);
      const url = `/transactions/${created.body.transaction.id}`;

      await api(s.member).patch(url).set('If-Match', '"1"').send({ amount: '11' }).expect(200);
      const put = await api(s.member).put(url).set('If-Match', '"2"').send({ amount: '12' }).expect(404);

      expect(put.body.code).toBe('NOT_FOUND');
      expect(operation('/transactions/{transactionId}', 'patch')).toBeDefined();
      expect(operation('/transactions/{transactionId}', 'put')).toBeUndefined();
    });
  });

  describe('version check', () => {
    it('requires If-Match on PATCH and DELETE and refuses a stale version', async () => {
      const s = await space();
      const created = await createTransaction(s, s.expenses[0], '10').expect(201);
      const url = `/transactions/${created.body.transaction.id}`;

      const noVersionEdit = await api(s.member).patch(url).send({ amount: '11' }).expect(428);
      const noVersionDelete = await api(s.member).delete(url).expect(428);
      await api(s.member).patch(url).set('If-Match', '"1"').send({ amount: '11' }).expect(200);
      const stale = await api(s.member).delete(url).set('If-Match', '"1"').expect(409);

      expect([noVersionEdit.body.code, noVersionDelete.body.code]).toEqual([
        'TRANSACTION_VERSION_REQUIRED',
        'TRANSACTION_VERSION_REQUIRED',
      ]);
      expect(stale.body.code).toBe('TRANSACTION_VERSION_CONFLICT');
      for (const method of ['patch', 'delete']) {
        expect(operation('/transactions/{transactionId}', method).parameters).toContainEqual(
          expect.objectContaining({ name: 'If-Match', required: true }),
        );
      }
    });
  });

  describe('maximum amount', () => {
    const MAX = '99999999.99';
    const ABOVE = '100000000';

    type Write = (s: Space, amount: string) => Promise<request.Response>;

    const writes: Array<[string, string, Write]> = [
      ['POST /transactions', 'amount', (s, amount) => createTransaction(s, s.expenses[0], amount).then((r) => r)],
      [
        'PATCH /transactions/:id',
        'amount',
        async (s, amount) => {
          const created = await createTransaction(s, s.expenses[0], '1').expect(201);
          return api(s.member)
            .patch(`/transactions/${created.body.transaction.id}`)
            .set('If-Match', '"1"')
            .send({ amount });
        },
      ],
      [
        'POST /limits',
        'amount',
        (s, amount) =>
          api(s.member)
            .post('/limits')
            .send({ amount })
            .then((r) => r),
      ],
      [
        'PUT /limits/:id',
        'amount',
        async (s, amount) => {
          const limit = await api(s.member).post('/limits').send({ amount: '1' }).expect(201);
          return api(s.member).put(`/limits/${limit.body.id}`).send({ amount });
        },
      ],
      [
        'POST /wallets',
        'initial_balance',
        (s, amount) =>
          api(s.member)
            .post('/wallets')
            .send({ wallet_name: 'Max', initial_balance: amount, design: 'slate' })
            .then((r) => r),
      ],
    ];

    it.each(writes)(`%s accepts ${MAX} and refuses ${ABOVE}`, async (_, field, write) => {
      const accepted = await write(await space(), MAX);
      const refused = await write(await space(), ABOVE);

      expect([200, 201]).toContain(accepted.status);
      expect(refused.status).toBe(400);
      expect(refused.body).toMatchObject({
        code: 'VALIDATION_FAILED',
        message: [{ field, error: `${field} must not be greater than ${MAX}` }],
      });
    });
  });

  describe('monthly total limit', () => {
    it('counts every expense of the month, also of categories with their own limit, and no income', async () => {
      const s = await space();
      const [limited, other] = s.expenses;
      const total = await api(s.member).post('/limits').send({ amount: '100' }).expect(201);
      await api(s.member)
        .post('/limits')
        .send({ category_ids: [limited], amount: '150' })
        .expect(201);
      await createTransaction(s, limited, '30').expect(201);
      await createTransaction(s, other, '19.99').expect(201);
      await createTransaction(s, s.incomeId, '500', 'income').expect(201);

      const res = await api(s.member).get('/limits').query({ time_zone: 'UTC' }).expect(200);

      expect(res.body.total).toMatchObject({ id: total.body.id, amount: '100.00', spent: 49.99, in_percent: 49 });
      expect(res.body.categories).toEqual([expect.objectContaining({ amount: '150.00', spent: 30, in_percent: 20 })]);
      expect(res.body.over_allocation).toEqual({ category_total: 150, difference: 50 });
    });

    it('allows one per space', async () => {
      const s = await space();
      await api(s.member).post('/limits').send({ amount: '100' }).expect(201);

      const second = await api(s.member).post('/limits').send({ category_ids: [], amount: '200' }).expect(400);

      expect(second.body.code).toBe('LIMIT_EXISTS');
    });
  });
});
