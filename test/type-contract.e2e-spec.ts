import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.config';
import { UsersService } from '@modules/users/users.service';
import { TransactionQueriesService } from '@modules/transaction-queries/transaction-queries.service';
import { createOpenApiDocument, okResponseSchema, schemaErrors } from './support/openapi';

// Pins the runtime types at the HTTP/DB boundary described in
// docs/type-contract.md.
describe('Boundary type contract (e2e)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let transactionQueriesService: TransactionQueriesService;
  let userId: number;
  let token: string;
  let spaceId: number;
  let expenseCategoryId: number;
  let currencyId: number;
  let email: string;
  const extraSpaceIds: number[] = [];
  const extraUserIds: number[] = [];

  const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    configureApp(app);
    await app.listen(0, '127.0.0.1');

    dataSource = moduleFixture.get(DataSource);
    transactionQueriesService = moduleFixture.get(TransactionQueriesService);
    const usersService = moduleFixture.get(UsersService);

    const [currency] = await dataSource.query('SELECT id FROM currencies LIMIT 1');
    currencyId = currency.id;
    email = `e2e-contract-${Date.now()}@example.com`;
    const user = await usersService.register({
      name: 'Contract',
      email,
      password: 'DevTest#2026',
      base_currency_id: currency.id,
    });
    userId = user.id;
    await usersService.completeEmailVerification(user.id);
    token = await usersService.login({ email, password: 'DevTest#2026' });

    const [membership] = await dataSource.query('SELECT space_id FROM space_members WHERE user_id = ?', [userId]);
    spaceId = membership.space_id;

    const categories = await api().get(`${base()}/categories`).expect(200);
    expenseCategoryId = categories.body.expenses[0].id;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  afterAll(async () => {
    try {
      for (const id of [spaceId, ...extraSpaceIds].filter(Boolean)) {
        await dataSource.query(
          'DELETE lc FROM limit_categories lc INNER JOIN limits l ON l.id = lc.limit_id WHERE l.space_id = ?',
          [id],
        );
        await dataSource.query('DELETE FROM limits WHERE space_id = ?', [id]);
        await dataSource.query('DELETE FROM transactions WHERE space_id = ?', [id]);
        await dataSource.query('DELETE FROM space_members WHERE space_id = ?', [id]);
        await dataSource.query('DELETE FROM spaces WHERE id = ?', [id]);
      }

      for (const id of [userId, ...extraUserIds].filter(Boolean)) {
        await dataSource.query('DELETE FROM space_invite_emails WHERE sender_user_id = ?', [id]);
        await dataSource.query('DELETE FROM users WHERE id = ?', [id]);
      }
    } finally {
      await app.close();
    }
  });

  function base(): string {
    return `/api/v1/spaces/${spaceId}`;
  }

  function transactions(id = spaceId): string {
    return `/api/v2/spaces/${id}/transactions`;
  }

  function api() {
    const agent = request(app.getHttpServer());
    const withAuth =
      (method: 'get' | 'post' | 'put' | 'patch' | 'delete') =>
      (url: string): request.Test =>
        agent[method](url).set('Authorization', `Bearer ${token}`);

    return {
      get: withAuth('get'),
      post: withAuth('post'),
      put: withAuth('put'),
      patch: withAuth('patch'),
      delete: withAuth('delete'),
    };
  }

  function createTransaction(overrides: Record<string, unknown> = {}, space = spaceId): request.Test {
    return api()
      .post(transactions(space))
      .send({
        category_id: expenseCategoryId,
        transaction_type: 'expense',
        amount: '1',
        date: new Date().toISOString().slice(0, 10),
        time_zone: 'UTC',
        assignment: { kind: 'space' },
        ...overrides,
      });
  }

  async function readCategory(id: number) {
    const res = await api().get(`${base()}/categories`).expect(200);
    const { incomes, expenses, archived } = res.body;

    return [...incomes, ...expenses, ...archived].find((category: { id: number }) => category.id === id);
  }

  async function readLimit(id: number) {
    const res = await api().get(`${base()}/limits`).expect(200);

    return [res.body.total, ...res.body.categories].find((limit: { id: number } | null) => limit?.id === id);
  }

  async function countRows(sql: string, params: unknown[]): Promise<number> {
    const [row] = await dataSource.query(sql, params);

    return Number(row.count);
  }

  function expectFieldError(res: request.Response, field: string): void {
    expect(res.body.message).toEqual(expect.arrayContaining([{ field, error: expect.any(String) }]));
  }

  async function createExtraSpace(name: string): Promise<number> {
    const space = await api()
      .post('/api/v1/spaces')
      .send({ name, currency_id: currencyId, type: 'personal' })
      .expect(201);
    extraSpaceIds.push(space.body.id);

    return space.body.id;
  }

  async function readTransaction(id: string) {
    const res = await api().get(`${transactions()}/${id}`).expect(200);

    return res.body;
  }

  const countTransactions = () => countRows('SELECT COUNT(*) AS count FROM transactions WHERE space_id = ?', [spaceId]);

  describe('money', () => {
    it('accepts amounts only as decimal strings, not JSON numbers', async () => {
      const res = await createTransaction({ amount: 12.3 }).expect(400);
      expect(res.body.message).toEqual([{ field: 'amount', error: expect.any(String) }]);

      await api().post(`${base()}/limits`).send({ amount: 500 }).expect(400);
    });

    it.each(['-1', '-0.01', '+1', '1.234', '0.001', '1.230', '.5', '100000000', '100000000.00', '99999999.991'])(
      'rejects %p on every money field without writing anything',
      async (amount) => {
        const counts = () =>
          Promise.all([
            countTransactions(),
            countRows('SELECT COUNT(*) AS count FROM limits WHERE space_id = ?', [spaceId]),
          ]);
        const limit = await api().post(`${base()}/limits`).send({ amount: '10' }).expect(201);
        const created = await createTransaction({ amount: '5' }).expect(201);
        const before = await counts();

        expectFieldError(await createTransaction({ amount }).expect(400), 'amount');
        expectFieldError(
          await api()
            .patch(`${transactions()}/${created.body.transaction.id}`)
            .set('If-Match', '"1"')
            .send({ amount })
            .expect(400),
          'amount',
        );
        expectFieldError(await api().post(`${base()}/limits`).send({ amount }).expect(400), 'amount');
        expectFieldError(await api().put(`${base()}/limits/${limit.body.id}`).send({ amount }).expect(400), 'amount');

        expect(await counts()).toEqual(before);
        expect(await readLimit(limit.body.id)).toMatchObject({ amount: '10.00' });
        expect(await readTransaction(created.body.transaction.id)).toMatchObject({ amount: '5.00', version: 1 });

        await api().delete(`${base()}/limits/${limit.body.id}`).expect(200);
      },
    );

    it('accepts the upper bound on every money field, and zero everywhere but on a transaction', async () => {
      const transaction = await createTransaction({ amount: '99999999.99' }).expect(201);
      expect((await readTransaction(transaction.body.transaction.id)).amount).toBe('99999999.99');
      await api().delete(`${transactions()}/${transaction.body.transaction.id}`).set('If-Match', '"1"').expect(200);

      for (const amount of ['0', '0.00']) {
        const zero = await createTransaction({ amount }).expect(400);
        expect(zero.body.message).toEqual([{ field: 'amount', error: 'amount must be greater than 0' }]);
      }

      const limit = await api().post(`${base()}/limits`).send({ amount: '0' }).expect(201);
      expect(limit.body.amount).toBe('0.00');
      await api().put(`${base()}/limits/${limit.body.id}`).send({ amount: '99999999.99' }).expect(200);
      expect(await readLimit(limit.body.id)).toMatchObject({ amount: '99999999.99' });
      await api().delete(`${base()}/limits/${limit.body.id}`).expect(200);
    });

    it('computes history and statistics totals in exact cents', async () => {
      const space = await createExtraSpace('Exact');
      const categories = await api().get(`/api/v1/spaces/${space}/categories`).expect(200);
      const income = (amount: string) =>
        createTransaction(
          {
            category_id: categories.body.incomes[0].id,
            transaction_type: 'income',
            amount,
            date: '2026-01-15',
          },
          space,
        ).expect(201);

      for (const amount of ['0.1', '0.2', '0.01']) {
        await income(amount);
      }

      const feed = await api()
        .get(`${transactions(space)}/feed?from_date=2026-01-01&to_date=2026-01-31`)
        .expect(200);
      const summary = await api()
        .get(`/api/v2/spaces/${space}/statistics/summary?period=month&anchor_date=2026-01-15&time_zone=UTC`)
        .expect(200);

      expect(feed.body.summary).toEqual({ count: 3, income: '0.31', expense: '0.00' });
      expect(feed.body.day_totals).toEqual([{ date: '2026-01-15', net: '0.31' }]);
      expect(summary.body).toMatchObject({ income: { amount: '0.31', count: 3 }, net: '0.31' });
    });

    it('returns the created amount normalized to 2 decimals, as reads do', async () => {
      const created = await createTransaction({ amount: '12.3' }).expect(201);

      expect(created.body.transaction.amount).toBe('12.30');

      const read = await readTransaction(created.body.transaction.id);
      expect(read.amount).toBe('12.30');
    });

    it('computes limit spending, percentages and over_allocation in exact cents', async () => {
      const space = await createExtraSpace('Exact limits');
      const spaceBase = `/api/v1/spaces/${space}`;
      const categories = await api().get(`${spaceBase}/categories`).expect(200);
      const [first, second, unlimited] = categories.body.expenses.map((category: { id: number }) => category.id);
      const spend = (category_id: number, amount: string) =>
        createTransaction({ category_id, amount }, space).expect(201);
      const summary = async () => (await api().get(`${spaceBase}/limits`).expect(200)).body;

      const total = await api().post(`${spaceBase}/limits`).send({ amount: '0.30' }).expect(201);
      await api()
        .post(`${spaceBase}/limits`)
        .send({ amount: '0.10', category_ids: [first] })
        .expect(201);
      const zero = await api()
        .post(`${spaceBase}/limits`)
        .send({ amount: '0.20', category_ids: [second] })
        .expect(201);
      expect((await summary()).over_allocation).toBeNull();

      await spend(unlimited, '0.29');
      await api().put(`${spaceBase}/limits/${total.body.id}`).send({ amount: '1.00' }).expect(200);
      expect((await summary()).total).toMatchObject({ amount: '1.00', spent: 0.29, in_percent: 29 });

      await spend(first, '0.29');
      await spend(second, '0.05');
      await api().put(`${spaceBase}/limits/${zero.body.id}`).send({ amount: '0' }).expect(200);
      const result = await summary();
      expect(result.total).toMatchObject({ spent: 0.63, in_percent: 63 });
      expect(result.categories).toEqual([
        expect.objectContaining({ amount: '0.10', spent: 0.29, in_percent: 290 }),
        expect.objectContaining({ amount: '0.00', spent: 0.05, in_percent: 0 }),
      ]);
      expect(result.over_allocation).toBeNull();
    });

    it('returns limit amounts as DECIMAL strings and spent/percent as numbers', async () => {
      const created = await api().post(`${base()}/limits`).send({ amount: '300.5' }).expect(201);
      expect(created.body.amount).toBe('300.50');

      const summary = await api().get(`${base()}/limits`).expect(200);
      expect(summary.body.total).toMatchObject({ amount: '300.50', spent: expect.any(Number) });
      expect(typeof summary.body.total.in_percent).toBe('number');

      await api().delete(`${base()}/limits/${created.body.id}`).expect(200);
    });
  });

  describe('dates', () => {
    const DATE_ERROR = 'must be a calendar date as YYYY-MM-DD from 1000-01-01 to 9999-12-31';

    it('serializes a transaction date as YYYY-MM-DD and technical timestamps as ISO-8601 UTC strings', async () => {
      const created = await createTransaction({ date: '2026-01-15' }).expect(201);
      const read = await readTransaction(created.body.transaction.id);

      expect(read.date).toBe('2026-01-15');
      expect(read).not.toHaveProperty('timestamp');
      expect(read.category.created_at).toMatch(ISO_DATE);
    });

    it('passes query dates to the selection as they were sent', async () => {
      const spy = jest.spyOn(transactionQueriesService, 'countSelection');

      await api().get(`${transactions()}/count`).query({ from_date: '2026-01-01', to_date: '2026-01-31' }).expect(200);
      expect(spy).toHaveBeenLastCalledWith(
        expect.objectContaining({ spaceId, fromDate: '2026-01-01', toDate: '2026-01-31' }),
      );
    });

    it('keeps both dates of a period inclusive, whole days', async () => {
      const space = await createExtraSpace('Period');
      const categories = await api().get(`/api/v1/spaces/${space}/categories`).expect(200);
      const category_id = categories.body.expenses[0].id;
      await createTransaction({ category_id, date: '2026-03-10' }, space).expect(201);
      await createTransaction({ category_id, date: '2026-03-12', time_zone: 'Pacific/Kiritimati' }, space).expect(201);

      const select = async (from_date: string, to_date: string): Promise<number> => {
        const res = await api()
          .get(`${transactions(space)}/count`)
          .query({ from_date, to_date })
          .expect(200);

        return res.body.count;
      };

      expect(await select('2026-03-11', '2026-03-11')).toBe(0);
      expect(await select('2026-03-10', '2026-03-10')).toBe(1);
      expect(await select('2026-03-12', '2026-03-12')).toBe(1);
      expect(await select('2026-03-01', '2026-03-31')).toBe(2);
    });

    it('stores the date as sent, whatever the zone of the writer', async () => {
      for (const time_zone of ['UTC', 'Asia/Tokyo', 'America/Los_Angeles', 'Pacific/Kiritimati']) {
        const created = await createTransaction({ date: '2026-03-12', time_zone }).expect(201);

        expect(created.body.transaction.date).toBe('2026-03-12');
        expect((await readTransaction(created.body.transaction.id)).date).toBe('2026-03-12');
      }
    });

    it.each(['garbage', '', '2026-02-30', '2026-01-01T00:00:00Z', '2026-01-01T10:00:00', '2026-1-1', '1700000000000'])(
      'rejects query from_date=%p on the feed and the count with a 400',
      async (from_date) => {
        for (const path of ['feed', 'count']) {
          const res = await api()
            .get(`${transactions()}/${path}`)
            .query({ from_date, to_date: '2026-12-31' })
            .expect(400);
          expect(res.body.message).toEqual([{ field: 'from_date', error: `from_date ${DATE_ERROR}` }]);
        }
      },
    );

    it('rejects a malformed or missing to_date with a 400', async () => {
      for (const query of [{ from_date: '2026-01-01', to_date: '2026-01-32' }, { from_date: '2026-01-01' }]) {
        const res = await api().get(`${transactions()}/count`).query(query).expect(400);
        expect(res.body.message).toEqual([{ field: 'to_date', error: `to_date ${DATE_ERROR}` }]);
      }
    });

    it.each([
      null,
      1700000000000,
      'garbage',
      '2026-02-30',
      '2026-W03',
      '2099-01-01',
      '2026-01-15T00:00:00Z',
      '2026-01-15T10:00:00',
      '2026-01-15+03:00',
    ])('rejects a transaction date of %p without creating it', async (date) => {
      const before = await countTransactions();

      const res = await createTransaction({ date }).expect(400);
      expectFieldError(res, 'date');
      expect(await countTransactions()).toBe(before);
    });

    it('rejects a transaction timestamp, the field of earlier releases, without creating it', async () => {
      const before = await countTransactions();

      const res = await createTransaction({ timestamp: '2026-01-15T10:00:00.000Z' }).expect(400);
      expectFieldError(res, 'timestamp');
      expect(await countTransactions()).toBe(before);
    });
  });

  describe('missing values', () => {
    it('reads a missing description as null: absent, null and an empty string', async () => {
      const absent = await createTransaction().expect(201);
      const explicitNull = await createTransaction({ description: null }).expect(201);
      const empty = await createTransaction({ description: '' }).expect(201);

      expect((await readTransaction(absent.body.transaction.id)).description).toBeNull();
      expect((await readTransaction(explicitNull.body.transaction.id)).description).toBeNull();
      expect((await readTransaction(empty.body.transaction.id)).description).toBeNull();
    });

    it('treats an absent update field as "leave unchanged"', async () => {
      const created = await createTransaction({ description: 'Kept' }).expect(201);

      const updated = await api()
        .patch(`${transactions()}/${created.body.transaction.id}`)
        .set('If-Match', '"1"')
        .send({})
        .expect(200);

      expect(updated.body.transaction).toEqual(created.body.transaction);
    });

    it('lets null clear a nullable field (limit name)', async () => {
      const created = await api()
        .post(`${base()}/limits`)
        .send({ amount: '50', category_ids: [expenseCategoryId] })
        .expect(201);

      const updated = await api().put(`${base()}/limits/${created.body.id}`).send({ name: null }).expect(200);
      expect(updated.body.name).toBeNull();

      await api().delete(`${base()}/limits/${created.body.id}`).expect(200);
    });

    it('rejects an empty name on update, as on create, without changing the row', async () => {
      const categoryBefore = await readCategory(expenseCategoryId);
      const categoryRes = await api().put(`${base()}/categories/${expenseCategoryId}`).send({ name: '' }).expect(400);
      expectFieldError(categoryRes, 'name');
      expect(await readCategory(expenseCategoryId)).toMatchObject({ name: categoryBefore.name });
    });
  });

  describe('null in input DTOs', () => {
    it('rejects null and wrong types in a transaction edit without changing it, and applies a valid one', async () => {
      const created = await createTransaction({ amount: '3', description: 'Before' }).expect(201);
      const url = `${transactions()}/${created.body.transaction.id}`;

      for (const [body, field] of [
        [{ category_id: null }, 'category_id'],
        [{ transaction_type: null }, 'transaction_type'],
        [{ amount: null }, 'amount'],
        [{ date: null, time_zone: 'UTC' }, 'date'],
        [{ date: '2026-01-15' }, 'time_zone'],
        [{ assignment: null }, 'assignment'],
        [{ amount: 5 }, 'amount'],
        [{ assignment: { kind: 'space', user_id: 1 } }, 'assignment.user_id'],
      ] as const) {
        const res = await api().patch(url).set('If-Match', '"1"').send(body).expect(400);
        expectFieldError(res, field);
      }

      const nullRes = await api().patch(url).set('If-Match', '"1"').send({ amount: null }).expect(400);
      expect(nullRes.body.message[0].error).toContain('amount must not be null');
      expect(await readTransaction(created.body.transaction.id)).toMatchObject({ amount: '3.00', version: 1 });

      const updated = await api()
        .patch(url)
        .set('If-Match', '"1"')
        .send({ amount: '4', description: null })
        .expect(200);
      expect(updated.body.transaction).toMatchObject({ amount: '4.00', description: null, version: 2 });
    });

    it('rejects null and wrong types in a category update without changing it, and applies a valid one', async () => {
      const created = await api()
        .post(`${base()}/categories`)
        .send({ name: 'Before', transaction_type: 'expense', icon: 'Other', color: 'slate' })
        .expect(201);
      const id = created.body.id;

      for (const body of [
        { name: null },
        { icon: null },
        { color: null },
        { is_active: null },
        { name: 5 },
        { is_active: '0' },
      ]) {
        const res = await api().put(`${base()}/categories/${id}`).send(body).expect(400);
        expectFieldError(res, Object.keys(body)[0]);
      }

      expect(await readCategory(id)).toMatchObject({ name: 'Before', icon: 'Other', color: 'slate', is_active: 1 });

      const updated = await api().put(`${base()}/categories/${id}`).send({ name: 'After' }).expect(200);
      expect(updated.body).toMatchObject({ name: 'After', icon: 'Other', is_active: 1 });
    });

    it('keeps limit categories when category_ids is absent, rejects null, and makes [] the total limit', async () => {
      const category = await api()
        .post(`${base()}/categories`)
        .send({ name: 'Limited', transaction_type: 'expense', icon: 'Other', color: 'slate' })
        .expect(201);
      const created = await api()
        .post(`${base()}/limits`)
        .send({ amount: '50', category_ids: [category.body.id] })
        .expect(201);
      const id = created.body.id;
      const unchanged = { amount: '50.00', categories: [expect.objectContaining({ id: category.body.id })] };

      await api().put(`${base()}/limits/${id}`).send({}).expect(200);
      expect(await readLimit(id)).toMatchObject(unchanged);

      for (const body of [
        { category_ids: null },
        { category_ids: 'x' },
        { category_ids: ['x'] },
        { amount: null },
        { amount: 75 },
        { amount: '75', category_ids: null },
      ]) {
        const res = await api().put(`${base()}/limits/${id}`).send(body).expect(400);
        expectFieldError(res, body.amount === '75' ? 'category_ids' : Object.keys(body)[0]);
      }

      expect(await readLimit(id)).toMatchObject(unchanged);

      await api().put(`${base()}/limits/${id}`).send({ amount: '75' }).expect(200);
      expect(await readLimit(id)).toMatchObject({ ...unchanged, amount: '75.00' });

      const total = await api().put(`${base()}/limits/${id}`).send({ category_ids: [] }).expect(200);
      expect(total.body).toMatchObject({ limit_type: 'others', categories: [] });

      await api().delete(`${base()}/limits/${id}`).expect(200);
    });

    it('rejects null category_ids on limit creation without creating a limit, and makes [] the total limit', async () => {
      const countLimits = () => countRows('SELECT COUNT(*) AS count FROM limits WHERE space_id = ?', [spaceId]);
      const before = await countLimits();

      const res = await api().post(`${base()}/limits`).send({ amount: '10', category_ids: null }).expect(400);
      expectFieldError(res, 'category_ids');
      expect(await countLimits()).toBe(before);

      const total = await api().post(`${base()}/limits`).send({ amount: '10', category_ids: [] }).expect(201);
      expect(total.body).toMatchObject({ limit_type: 'others', categories: [] });

      await api().delete(`${base()}/limits/${total.body.id}`).expect(200);
    });

    it('rejects null or a non-array invites list without creating a space, and accepts an empty one', async () => {
      const countSpaces = () => countRows('SELECT COUNT(*) AS count FROM space_members WHERE user_id = ?', [userId]);
      const before = await countSpaces();
      const space = { name: 'Group', currency_id: currencyId, type: 'group' };

      for (const invites of [null, 'a@example.com']) {
        const res = await api()
          .post('/api/v1/spaces')
          .send({ ...space, invites })
          .expect(400);
        expectFieldError(res, 'invites');
      }

      expect(await countSpaces()).toBe(before);

      const created = await api()
        .post('/api/v1/spaces')
        .send({ ...space, invites: [] })
        .expect(201);
      await api().delete(`/api/v1/spaces/${created.body.id}`).expect(200);
    });

    it('rejects a non-string description but keeps null as "no description"', async () => {
      const res = await createTransaction({ description: 5 }).expect(400);
      expectFieldError(res, 'description');

      const created = await createTransaction({ description: null }).expect(201);
      expect(created.body.transaction.description).toBeNull();
    });
  });

  // Exact key sets: a changed, leaked (@Exclude) or dropped field fails here.
  describe('missing entities', () => {
    const MISSING_ID = 2_000_000_000;

    function expectError(res: request.Response, status: number, message: string): void {
      expect(res.status).toBe(status);
      expect(res.body.message).toBe(message);
    }

    it('reports a missing category or limit as the same 403 as a foreign one', async () => {
      const category = 'Category does not exist or you do not have access to this category';
      const limit = 'Limit does not exist or you do not have access to this limit';

      expectError(await createTransaction({ category_id: MISSING_ID }), 403, category);
      expectError(await api().put(`${base()}/categories/${MISSING_ID}`).send({ name: 'x' }), 403, category);
      expectError(await api().delete(`${base()}/categories/${MISSING_ID}`), 403, category);
      expectError(
        await api()
          .put(`${base()}/categories/reorder`)
          .send({ category_ids: [MISSING_ID] }),
        403,
        category,
      );
      expectError(await api().put(`${base()}/limits/${MISSING_ID}`).send({ amount: '1' }), 403, limit);
      expectError(await api().delete(`${base()}/limits/${MISSING_ID}`), 403, limit);
      expectError(
        await api()
          .post(`${base()}/limits`)
          .send({ amount: '1', category_ids: [MISSING_ID] }),
        403,
        category,
      );
    });

    it('reports a missing transaction as 404, like a foreign one', async () => {
      expectError(
        await api().delete(`${transactions()}/${MISSING_ID}`).set('If-Match', '"1"'),
        404,
        'Transaction not found',
      );
    });

    it('reports a missing space as 403 and a missing invite, member or code as 404', async () => {
      const space = 'Space does not exist or you do not have access to this space';

      expectError(await api().get(`/api/v1/spaces/${MISSING_ID}`), 403, space);
      expectError(await api().get(`${transactions(MISSING_ID)}/latest`), 403, space);
      expectError(
        await api().post(`/api/v1/spaces/${MISSING_ID}/invites`).send({ email: 'x@example.com' }),
        403,
        space,
      );
      expectError(await api().delete(`${base()}/invites/${MISSING_ID}`), 404, 'Not found');
      expectError(await api().delete(`${base()}/members/${MISSING_ID}`), 404, 'Not found');
      expectError(await api().post('/api/v1/spaces/invites/accept').send({ code: '000000' }), 404, 'Not found');

      const verify = (body: object) => request(app.getHttpServer()).post('/api/v1/users/verify-email').send(body);
      expectError(await verify({ email: `missing-${Date.now()}@example.com`, code: '000000' }), 404, 'Not found');
      expectError(await verify({ email, code: '000000' }), 409, 'Email is already verified');

      const unverifiedEmail = `e2e-contract-unverified-${Date.now()}@example.com`;
      const unverified = await app.get(UsersService).register({
        name: 'Unverified',
        email: unverifiedEmail,
        password: 'DevTest#2026',
        base_currency_id: currencyId,
      });
      extraUserIds.push(unverified.id);
      const [membership] = await dataSource.query('SELECT space_id FROM space_members WHERE user_id = ?', [
        unverified.id,
      ]);
      extraSpaceIds.push(membership.space_id);
      expectError(await verify({ email: unverifiedEmail, code: '000000' }), 404, 'Not found');
    });
  });

  describe('response shapes', () => {
    const keys = (value: object): string[] => Object.keys(value).sort();
    const TRANSACTION = ['amount', 'date', 'description', 'id', 'transaction_type', 'version'];
    const CATEGORY = ['color', 'created_at', 'icon', 'id', 'is_active', 'name', 'transaction_type', 'updated_at'];
    const TRANSACTION_VIEW = [...TRANSACTION, 'assignment', 'author', 'category', 'kind'].sort();
    const TRANSACTION_CATEGORY = [...CATEGORY, 'is_archived'].sort();

    it('transaction creation and reads', async () => {
      const created = await createTransaction({ description: 'Lunch' }).expect(201);
      expect(keys(created.body)).toEqual(['transaction']);
      expect(keys(created.body.transaction)).toEqual(TRANSACTION_VIEW);

      const read = await readTransaction(created.body.transaction.id);
      expect(keys(read)).toEqual(TRANSACTION_VIEW);
      expect(keys(read.category)).toEqual(TRANSACTION_CATEGORY);
      expect(keys(read.author)).toEqual(['name', 'source', 'status', 'user_id']);
      expect(keys(read.assignment)).toEqual(['kind', 'name', 'status', 'user_id']);
      expect(read).toEqual(expect.objectContaining({ kind: 'regular', version: 1 }));
      expect(read.category.is_archived).toBe(false);

      const document = createOpenApiDocument(app);
      const feed = await api().get(`${transactions()}/feed?from_date=2000-01-01&to_date=2099-12-31`).expect(200);
      expect(feed.body.items.length).toBeGreaterThan(0);
      expect(schemaErrors(document, okResponseSchema(document, '/transactions/feed'), feed.body)).toEqual([]);
      const latest = await api().get(`${transactions()}/latest`).expect(200);
      expect(schemaErrors(document, okResponseSchema(document, '/transactions/latest'), latest.body)).toEqual([]);
    });

    it('marks a starting balance by kind, not by the category name', async () => {
      const [system] = await dataSource.query('SELECT id FROM categories WHERE space_id = ? AND is_system = 1', [
        spaceId,
      ]);
      const [{ id }] = await dataSource.query('SELECT UUID() AS id');
      await dataSource.query(
        `INSERT INTO transactions (id, space_id, category_id, transaction_type, amount, date, version,
           author_user_id, author_source, assignment_kind)
         VALUES (?, ?, ?, 'income', '5.00', ?, 1, ?, 'imported', 'space')`,
        [id, spaceId, system.id, new Date().toISOString().slice(0, 10), userId],
      );
      await dataSource.query('UPDATE categories SET name = ? WHERE space_id = ? AND is_system = 1', [
        'Renamed',
        spaceId,
      ]);

      try {
        const read = await readTransaction(id);

        expect(read.kind).toBe('initial_balance');
        expect(read.category.name).toBe('Renamed');
        expect(keys(read.category)).toEqual(TRANSACTION_CATEGORY);
      } finally {
        await dataSource.query('UPDATE categories SET name = ? WHERE space_id = ? AND is_system = 1', [
          'Initial balance',
          spaceId,
        ]);
      }
    });

    it('limits and categories', async () => {
      const category = await api()
        .post(`${base()}/categories`)
        .send({ name: 'Shape', transaction_type: 'expense', icon: 'Other', color: 'slate' })
        .expect(201);
      // is_active comes from the column default and is not re-read after insert
      expect(keys(category.body)).toEqual(CATEGORY.filter((key) => key !== 'is_active'));

      const limit = await api()
        .post(`${base()}/limits`)
        .send({ amount: '20', category_ids: [category.body.id] })
        .expect(201);
      expect(keys(limit.body)).toEqual([
        'amount',
        'categories',
        'created_at',
        'id',
        'limit_type',
        'name',
        'updated_at',
      ]);
      expect(limit.body.name).toBeNull();
      expect(keys(limit.body.categories[0])).toEqual(CATEGORY);

      const summary = await api().get(`${base()}/limits`).expect(200);
      expect(keys(summary.body)).toEqual(['categories', 'over_allocation', 'period', 'total']);
      expect(keys(summary.body.period)).toEqual(['end_date', 'start_date', 'time_zone']);
      const view = summary.body.categories.find((item: { id: number }) => item.id === limit.body.id);
      expect(keys(view)).toEqual(['amount', 'categories', 'id', 'in_percent', 'name', 'spent']);
      expect(keys(view.categories[0])).toEqual(['color', 'icon', 'id', 'name']);

      const views = await api().get(`${base()}/categories`).expect(200);
      expect(keys(views.body)).toEqual(['archived', 'expenses', 'incomes']);
      const categoryView = views.body.expenses.find((item: { id: number }) => item.id === category.body.id);
      expect(keys(categoryView)).toEqual([
        'archived_at',
        'color',
        'icon',
        'id',
        'is_active',
        'limit',
        'name',
        'transaction_count',
        'transaction_type',
      ]);
      expect(categoryView.archived_at).toBeNull();
      expect(categoryView.limit).toEqual({ id: limit.body.id, name: null });

      await api().delete(`${base()}/limits/${limit.body.id}`).expect(200);
    });

    it('space and profile', async () => {
      const space = await api().get(base()).expect(200);
      expect(keys(space.body)).toEqual(['created_at', 'currency', 'id', 'name', 'type', 'updated_at']);
      expect(keys(space.body.currency)).toEqual(['code', 'id', 'name']);

      const list = await api().get('/api/v1/spaces').expect(200);
      expect(keys(list.body[0])).toEqual(['created_at', 'currency', 'id', 'member_count', 'name', 'role', 'type']);

      const members = await api().get(`${base()}/members`).expect(200);
      expect(keys(members.body[0])).toEqual([
        'can_remove',
        'can_resend',
        'email',
        'email_status',
        'id',
        'name',
        'resend_after_seconds',
        'role',
        'type',
        'user_id',
      ]);

      const profile = await api().get('/api/v1/users/profile').expect(200);
      expect(keys(profile.body)).toEqual(['created_at', 'email', 'id', 'name', 'updated_at']);
    });

    it('invitation create, roster and resend', async () => {
      const document = createOpenApiDocument(app);
      const group = await api()
        .post('/api/v1/spaces')
        .send({ name: 'Contract group', currency_id: currencyId, type: 'group' })
        .expect(201);
      extraSpaceIds.push(group.body.id);
      const invites = `/api/v1/spaces/${group.body.id}/invites`;

      const created = await api()
        .post(invites)
        .send({ email: `e2e-contract-${process.pid}-${Date.now()}@example.com` })
        .expect(201);
      expect(keys(created.body)).toEqual(['code', 'email', 'email_status', 'expires_at', 'id', 'resend_after_seconds']);
      expect(schemaErrors(document, okResponseSchema(document, '/spaces/{id}/invites', 'post'), created.body)).toEqual(
        [],
      );

      const roster = await api().get(`/api/v1/spaces/${group.body.id}/members`).expect(200);
      expect(roster.body.map((row: { type: string }) => row.type)).toEqual(['member', 'invite']);
      expect(schemaErrors(document, okResponseSchema(document, '/spaces/{id}/members'), roster.body)).toEqual([]);

      await dataSource.query(
        'UPDATE space_invite_emails SET scheduled_at = scheduled_at - INTERVAL 2 MINUTE WHERE invite_id = ?',
        [created.body.id],
      );
      const resent = await api().post(`${invites}/${created.body.id}/resend`).expect(202);
      expect(keys(resent.body)).toEqual(['email', 'email_status', 'expires_at', 'id', 'resend_after_seconds']);
      expect(
        schemaErrors(document, okResponseSchema(document, '/invites/{inviteId}/resend', 'post'), resent.body),
      ).toEqual([]);
    });
  });
});
