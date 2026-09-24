import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.config';
import { UsersService } from '@modules/users/users.service';
import { TransactionQueriesService } from '@modules/transaction-queries/transaction-queries.service';

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
  let walletId: number;
  let currencyId: number;
  let email: string;
  const extraSpaceIds: number[] = [];

  const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    configureApp(app);
    await app.init();

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
    token = await usersService.completeEmailVerification(user);

    const [membership] = await dataSource.query('SELECT space_id FROM space_members WHERE user_id = ?', [userId]);
    spaceId = membership.space_id;

    const categories = await api().get(`${base()}/categories`).expect(200);
    expenseCategoryId = categories.body.expenses[0].id;

    const wallet = await api()
      .post(`${base()}/wallets`)
      .send({ wallet_name: 'Contract', initial_balance: '100.50', design: 'slate' })
      .expect(201);
    walletId = wallet.body.wallet.id;
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
        await dataSource.query(
          'DELETE t FROM transactions t INNER JOIN wallets w ON w.id = t.wallet_id WHERE w.space_id = ?',
          [id],
        );
        await dataSource.query('DELETE FROM space_members WHERE space_id = ?', [id]);
        await dataSource.query('DELETE FROM spaces WHERE id = ?', [id]);
      }

      if (userId) {
        await dataSource.query('DELETE FROM users WHERE id = ?', [userId]);
      }
    } finally {
      await app.close();
    }
  });

  function base(): string {
    return `/api/v1/spaces/${spaceId}`;
  }

  function api() {
    const agent = request(app.getHttpServer());
    const withAuth =
      (method: 'get' | 'post' | 'put' | 'delete') =>
      (url: string): request.Test =>
        agent[method](url).set('Authorization', `Bearer ${token}`);

    return { get: withAuth('get'), post: withAuth('post'), put: withAuth('put'), delete: withAuth('delete') };
  }

  function createTransaction(overrides: Record<string, unknown> = {}): request.Test {
    return api()
      .post(`${base()}/transactions`)
      .send({
        wallet_id: walletId,
        category_id: expenseCategoryId,
        transaction_type: 'expense',
        amount: '1',
        timestamp: new Date().toISOString(),
        ...overrides,
      });
  }

  async function readWallet(id: number) {
    const res = await api().get(`${base()}/wallets`).expect(200);

    return res.body.wallets.find((summary: { wallet: { id: number } }) => summary.wallet.id === id).wallet;
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

  async function readTransaction(id: string) {
    const res = await api().get(`${base()}/transactions?from=2000-01-01&to=2100-01-01`).expect(200);

    return res.body.find((transaction: { id: string }) => transaction.id === id);
  }

  describe('money', () => {
    it('accepts amounts only as decimal strings, not JSON numbers', async () => {
      const res = await createTransaction({ amount: 12.3 }).expect(400);
      expect(res.body.message).toEqual([{ field: 'amount', error: expect.any(String) }]);

      await api().post(`${base()}/limits`).send({ amount: 500 }).expect(400);
      await api().post(`${base()}/wallets`).send({ wallet_name: 'n', initial_balance: 1, design: 'slate' }).expect(400);
    });

    it.each(['-1', '-0.01', '+1', '1.234', '0.001', '1.230', '.5', '100000000', '100000000.00', '99999999.991'])(
      'rejects %p on every money field without writing anything',
      async (amount) => {
        const counts = () =>
          Promise.all([
            countRows(
              'SELECT COUNT(*) AS count FROM transactions t INNER JOIN wallets w ON w.id = t.wallet_id WHERE w.space_id = ?',
              [spaceId],
            ),
            countRows('SELECT COUNT(*) AS count FROM wallets WHERE space_id = ?', [spaceId]),
            countRows('SELECT COUNT(*) AS count FROM limits WHERE space_id = ?', [spaceId]),
          ]);
        const limit = await api().post(`${base()}/limits`).send({ amount: '10' }).expect(201);
        const before = await counts();

        expectFieldError(await createTransaction({ amount }).expect(400), 'amount');
        expectFieldError(await api().post(`${base()}/limits`).send({ amount }).expect(400), 'amount');
        expectFieldError(await api().put(`${base()}/limits/${limit.body.id}`).send({ amount }).expect(400), 'amount');
        expectFieldError(
          await api()
            .post(`${base()}/wallets`)
            .send({ wallet_name: 'Rejected', initial_balance: amount, design: 'slate' })
            .expect(400),
          'initial_balance',
        );

        expect(await counts()).toEqual(before);
        expect(await readLimit(limit.body.id)).toMatchObject({ amount: '10.00' });

        await api().delete(`${base()}/limits/${limit.body.id}`).expect(200);
      },
    );

    it('accepts zero and the upper bound on every money field', async () => {
      for (const [amount, stored] of [
        ['0', '0.00'],
        ['99999999.99', '99999999.99'],
      ]) {
        const transaction = await createTransaction({ amount }).expect(201);
        expect((await readTransaction(transaction.body.transaction.id)).amount).toBe(stored);
        await api().delete(`${base()}/transactions/${transaction.body.transaction.id}`).expect(200);
      }

      const limit = await api().post(`${base()}/limits`).send({ amount: '0' }).expect(201);
      expect(limit.body.amount).toBe('0.00');
      await api().put(`${base()}/limits/${limit.body.id}`).send({ amount: '99999999.99' }).expect(200);
      expect(await readLimit(limit.body.id)).toMatchObject({ amount: '99999999.99' });
      await api().delete(`${base()}/limits/${limit.body.id}`).expect(200);

      const wallet = await api()
        .post(`${base()}/wallets`)
        .send({ wallet_name: 'Max', initial_balance: '99999999.99', design: 'slate' })
        .expect(201);
      expect(wallet.body.wallet.balance).toBe(99999999.99);
      expect((await readTransaction(wallet.body.transaction.id)).amount).toBe('99999999.99');
      await api().delete(`${base()}/wallets/${wallet.body.wallet.id}`).expect(200);
    });

    it('computes balances, totals and delta_percent in exact cents', async () => {
      const space = await api()
        .post('/api/v1/spaces')
        .send({ name: 'Exact', currency_id: currencyId, type: 'personal' })
        .expect(201);
      extraSpaceIds.push(space.body.id);
      const spaceBase = `/api/v1/spaces/${space.body.id}`;
      const categories = await api().get(`${spaceBase}/categories`).expect(200);
      const incomeCategoryId = categories.body.incomes[0].id;
      const createWallet = (initial_balance: string) =>
        api().post(`${spaceBase}/wallets`).send({ wallet_name: 'Exact', initial_balance, design: 'slate' }).expect(201);

      const first = await createWallet('0.10');
      const second = await createWallet('0.20');
      expect(first.body).toMatchObject({ wallet: { balance: 0.1 }, transaction: { amount: 0.1 } });

      const overview = await api().get(`${spaceBase}/wallets`).expect(200);
      expect(overview.body.total_balance).toBe(0.3);

      const income = await api()
        .post(`${spaceBase}/transactions`)
        .send({
          wallet_id: first.body.wallet.id,
          category_id: incomeCategoryId,
          transaction_type: 'income',
          amount: '0.2',
          timestamp: '2030-01-15T12:00:00.000Z',
        })
        .expect(201);
      expect(income.body.previous_balance).toBe(0.1);
      expect(income.body.wallet.balance).toBe(0.3);

      const period = await api().get(`${spaceBase}/wallets?from=2030-01-01&to=2030-01-31`).expect(200);
      expect(period.body).toMatchObject({ total_balance: 0.5, delta_percent: 66.7 });
      expect(period.body.wallets).toEqual([
        expect.objectContaining({
          wallet: expect.objectContaining({ id: first.body.wallet.id, balance: 0.3 }),
          total_income: 0.2,
          total_spend: 0,
        }),
        expect.objectContaining({
          wallet: expect.objectContaining({ id: second.body.wallet.id, balance: 0.2 }),
          total_income: 0,
          total_spend: 0,
        }),
      ]);
    });

    it('returns the initial wallet transaction amount as a number, but reads it back as a DECIMAL string', async () => {
      const created = await api()
        .post(`${base()}/wallets`)
        .send({ wallet_name: 'Initial', initial_balance: '100.50', design: 'slate' })
        .expect(201);

      expect(created.body.wallet.balance).toBe(100.5);
      expect(created.body.transaction.amount).toBe(100.5);

      const read = await readTransaction(created.body.transaction.id);
      expect(read.amount).toBe('100.50');
    });

    it('echoes the request amount string on create, reads it back normalized to 2 decimals, and derives balances as numbers', async () => {
      const created = await createTransaction({ amount: '12.3' }).expect(201);

      expect(created.body.transaction.amount).toBe('12.3');
      expect(typeof created.body.previous_balance).toBe('number');
      expect(created.body.wallet.balance).toBeCloseTo(created.body.previous_balance - 12.3, 2);

      const read = await readTransaction(created.body.transaction.id);
      expect(read.amount).toBe('12.30');

      const overview = await api().get(`${base()}/wallets`).expect(200);
      expect(typeof overview.body.total_balance).toBe('number');
      expect(typeof overview.body.wallets[0].wallet.balance).toBe('number');
      expect(typeof overview.body.wallets[0].total_spend).toBe('number');
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
    it('serializes timestamps as ISO-8601 UTC strings', async () => {
      const created = await createTransaction().expect(201);
      const read = await readTransaction(created.body.transaction.id);

      expect(read.timestamp).toMatch(ISO_DATE);
      expect(read.wallet.created_at).toMatch(ISO_DATE);
    });

    it('converts query from/to to Date, and defaults absent ones to the current month', async () => {
      const spy = jest.spyOn(transactionQueriesService, 'getForAllWallets');

      await api().get(`${base()}/transactions?from=2026-01-01&to=2026-01-31T23:59:59.999`).expect(200);
      expect(spy).toHaveBeenLastCalledWith(spaceId, new Date(2026, 0, 1), new Date(2026, 0, 31, 23, 59, 59, 999));

      await api().get(`${base()}/transactions`).expect(200);
      const now = new Date();
      expect(spy.mock.lastCall).toEqual([
        spaceId,
        new Date(now.getFullYear(), now.getMonth(), 1),
        new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999),
      ]);
    });

    it('keeps inclusive period boundaries for date-only, offset and millisecond values', async () => {
      const wallet = await api()
        .post(`${base()}/wallets`)
        .send({ wallet_name: 'Period', initial_balance: '0', design: 'slate' })
        .expect(201);
      const periodWalletId = wallet.body.wallet.id;
      const noonLocal = await createTransaction({ wallet_id: periodWalletId, timestamp: '2026-03-10T12:00:00' });
      const exactUtc = await createTransaction({ wallet_id: periodWalletId, timestamp: '2026-03-12T08:00:00.250Z' });
      expect(noonLocal.status).toBe(201);
      expect(exactUtc.status).toBe(201);

      const select = async (query: string): Promise<string[]> => {
        const res = await api().get(`${base()}/transactions?${query}`).expect(200);

        return res.body
          .filter((transaction: { wallet: { id: number } }) => transaction.wallet.id === periodWalletId)
          .map((transaction: { id: string }) => transaction.id)
          .sort();
      };
      const noon = noonLocal.body.transaction.id;
      const exact = exactUtc.body.transaction.id;

      expect(await select('from=2026-03-10&to=2026-03-10')).toEqual([]);
      expect(await select('from=2026-03-10&to=2026-03-11')).toEqual([noon]);
      expect(await select('from=2026-03-10T12:00:00&to=2026-03-10T12:00:00')).toEqual([noon]);
      expect(await select('from=2026-03-12T08:00:00.250Z&to=2026-03-12T08:00:00.250Z')).toEqual([exact]);
      expect(await select('from=2026-03-12T08:00:00.251Z&to=2026-03-13')).toEqual([]);
      expect(
        await select(
          `from=${encodeURIComponent('2026-03-12T11:00:00.250+03:00')}&to=${encodeURIComponent('2026-03-12T11:00:00.250+03:00')}`,
        ),
      ).toEqual([exact]);
      expect(await select('from=2026-03-01&to=2026-03-31T23:59:59.999')).toEqual([noon, exact].sort());
    });

    it('normalizes a created transaction timestamp to ISO-8601 UTC, whatever offset it was sent with', async () => {
      const created = await createTransaction({ timestamp: '2026-03-12T11:00:00.250+03:00' }).expect(201);

      expect(created.body.transaction.timestamp).toBe('2026-03-12T08:00:00.250Z');
      expect((await readTransaction(created.body.transaction.id)).timestamp).toBe('2026-03-12T08:00:00.250Z');
    });

    it.each(['garbage', '', '2026-02-30', '2026-01', '1700000000000', 'from=2026-01-01&from=2026-01-02'])(
      'rejects query from=%p on both period endpoints with a 400',
      async (value) => {
        const query = value.includes('=') ? value : `from=${value}`;

        for (const path of ['transactions', 'wallets']) {
          const res = await api().get(`${base()}/${path}?${query}`).expect(400);
          expect(res.body.message).toEqual([{ field: 'from', error: 'from must be a valid ISO 8601 date' }]);
        }
      },
    );

    it('rejects a malformed to with a 400', async () => {
      const res = await api().get(`${base()}/transactions?to=2026-01-01T25:00:00`).expect(400);
      expect(res.body.message).toEqual([{ field: 'to', error: 'to must be a valid ISO 8601 date' }]);
    });

    it.each([null, 1700000000000, 'garbage', '2026-02-30', '2026-W03', '2099-01-01T00:00:00Z', '1969-12-31'])(
      'rejects a transaction timestamp of %p without creating it',
      async (timestamp) => {
        const countTransactions = () =>
          countRows(
            'SELECT COUNT(*) AS count FROM transactions t INNER JOIN wallets w ON w.id = t.wallet_id WHERE w.space_id = ?',
            [spaceId],
          );
        const before = await countTransactions();

        const res = await createTransaction({ timestamp }).expect(400);
        expectFieldError(res, 'timestamp');
        expect(await countTransactions()).toBe(before);
      },
    );
  });

  describe('missing values', () => {
    it('stores description as given: absent and null become null, empty string stays empty', async () => {
      const absent = await createTransaction().expect(201);
      const explicitNull = await createTransaction({ description: null }).expect(201);
      const empty = await createTransaction({ description: '' }).expect(201);

      expect((await readTransaction(absent.body.transaction.id)).description).toBeNull();
      expect((await readTransaction(explicitNull.body.transaction.id)).description).toBeNull();
      expect((await readTransaction(empty.body.transaction.id)).description).toBe('');
    });

    it('treats an absent update field as "leave unchanged"', async () => {
      await api().put(`${base()}/wallets/${walletId}`).send({}).expect(200);

      const overview = await api().get(`${base()}/wallets`).expect(200);
      const wallet = overview.body.wallets.find(
        (summary: { wallet: { id: number } }) => summary.wallet.id === walletId,
      );
      expect(wallet.wallet.wallet_name).toBe('Contract');
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
      const walletBefore = await readWallet(walletId);
      const walletRes = await api().put(`${base()}/wallets/${walletId}`).send({ wallet_name: '' }).expect(400);
      expectFieldError(walletRes, 'wallet_name');
      expect(await readWallet(walletId)).toMatchObject({ wallet_name: walletBefore.wallet_name });

      const categoryBefore = await readCategory(expenseCategoryId);
      const categoryRes = await api().put(`${base()}/categories/${expenseCategoryId}`).send({ name: '' }).expect(400);
      expectFieldError(categoryRes, 'name');
      expect(await readCategory(expenseCategoryId)).toMatchObject({ name: categoryBefore.name });
    });
  });

  describe('null in input DTOs', () => {
    it('rejects null and wrong types in a wallet update without changing it, and applies a valid one', async () => {
      const created = await api()
        .post(`${base()}/wallets`)
        .send({ wallet_name: 'Before', initial_balance: '0', design: 'slate' })
        .expect(201);
      const id = created.body.wallet.id;

      for (const body of [{ wallet_name: null }, { design: null }, { wallet_name: 5 }, { design: 'plaid' }]) {
        const res = await api().put(`${base()}/wallets/${id}`).send(body).expect(400);
        expectFieldError(res, Object.keys(body)[0]);
      }

      const nullRes = await api().put(`${base()}/wallets/${id}`).send({ wallet_name: null }).expect(400);
      expect(nullRes.body.message[0].error).toContain('wallet_name must not be null');
      expect(await readWallet(id)).toMatchObject({ wallet_name: 'Before', design: 'slate' });

      await api().put(`${base()}/wallets/${id}`).send({}).expect(200);
      await api().put(`${base()}/wallets/${id}`).send({ wallet_name: 'After', design: 'amber' }).expect(200);
      expect(await readWallet(id)).toMatchObject({ wallet_name: 'After', design: 'amber' });
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

    it('reports a missing wallet, category, limit or transaction as the same 403 as a foreign one', async () => {
      const wallet = 'Wallet does not exist or you do not have access to this wallet';
      const category = 'Category does not exist or you do not have access to this category';
      const limit = 'Limit does not exist or you do not have access to this limit';

      expectError(await api().put(`${base()}/wallets/${MISSING_ID}`).send({ wallet_name: 'x' }), 403, wallet);
      expectError(await api().delete(`${base()}/wallets/${MISSING_ID}`), 403, wallet);
      expectError(await createTransaction({ wallet_id: MISSING_ID }), 403, wallet);
      expectError(await createTransaction({ category_id: MISSING_ID }), 403, category);
      expectError(await api().delete(`${base()}/transactions/${MISSING_ID}`), 403, wallet);
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

    it('reports a missing space as 403 and a missing invite, member or code as 404', async () => {
      const space = 'Space does not exist or you do not have access to this space';

      expectError(await api().get(`/api/v1/spaces/${MISSING_ID}`), 403, space);
      expectError(await api().get(`/api/v1/spaces/${MISSING_ID}/wallets`), 403, space);
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
      expectError(await verify({ email, code: '000000' }), 404, 'Not found');
    });
  });

  describe('response shapes', () => {
    const keys = (value: object): string[] => Object.keys(value).sort();
    const WALLET = ['created_at', 'design', 'id', 'updated_at', 'wallet_name'];
    const WALLET_WITH_BALANCE = [...WALLET, 'balance'].sort();
    const TRANSACTION = ['amount', 'description', 'id', 'timestamp', 'transaction_type'];
    const CATEGORY = ['color', 'created_at', 'icon', 'id', 'is_active', 'name', 'transaction_type', 'updated_at'];

    it('wallet creation and overview', async () => {
      const funded = await api()
        .post(`${base()}/wallets`)
        .send({ wallet_name: 'Shape', initial_balance: '5', design: 'slate' })
        .expect(201);
      expect(keys(funded.body)).toEqual(['transaction', 'wallet']);
      expect(keys(funded.body.wallet)).toEqual(WALLET_WITH_BALANCE);
      expect(keys(funded.body.transaction)).toEqual(TRANSACTION);
      expect(funded.body.transaction.description).toBeNull();

      const empty = await api()
        .post(`${base()}/wallets`)
        .send({ wallet_name: 'Shape0', initial_balance: '0', design: 'slate' })
        .expect(201);
      expect(empty.body.transaction).toBeNull();
      expect(keys(empty.body.wallet)).toEqual(WALLET_WITH_BALANCE);

      const overview = await api().get(`${base()}/wallets`).expect(200);
      expect(keys(overview.body)).toEqual(['delta_percent', 'total_balance', 'total_balance_currency', 'wallets']);
      expect(keys(overview.body.wallets[0])).toEqual(['total_income', 'total_spend', 'wallet']);
      expect(keys(overview.body.wallets[0].wallet)).toEqual(WALLET_WITH_BALANCE);
    });

    it('transaction creation and reads', async () => {
      const created = await createTransaction({ description: 'Lunch' }).expect(201);
      expect(keys(created.body)).toEqual(['previous_balance', 'transaction', 'wallet']);
      expect(keys(created.body.transaction)).toEqual(TRANSACTION);
      expect(keys(created.body.wallet)).toEqual(WALLET_WITH_BALANCE);

      const read = await readTransaction(created.body.transaction.id);
      expect(keys(read)).toEqual([...TRANSACTION, 'category', 'wallet'].sort());
      expect(keys(read.wallet)).toEqual(WALLET);
      expect(keys(read.category)).toEqual(CATEGORY);
    });

    it('nulls the wallet of a soft-deleted wallet in transaction reads, keeping the key', async () => {
      const wallet = await api()
        .post(`${base()}/wallets`)
        .send({ wallet_name: 'Doomed', initial_balance: '0', design: 'slate' })
        .expect(201);
      const doomedId = wallet.body.wallet.id;
      const created = await createTransaction({ wallet_id: doomedId, timestamp: '2037-12-31T00:00:00.000Z' }).expect(
        201,
      );
      await api().delete(`${base()}/wallets/${doomedId}`).expect(200);

      const res = await api().get(`${base()}/transactions?from=2037-12-30&to=2038-01-01`).expect(200);
      expect(res.body).toHaveLength(1);
      expect(keys(res.body[0])).toEqual([...TRANSACTION, 'category', 'wallet'].sort());
      expect(res.body[0].wallet).toBeNull();

      const latest = await api().get(`${base()}/transactions/latest`).expect(200);
      expect(latest.body.id).toBe(created.body.transaction.id);
      expect(latest.body.wallet).toBeNull();
      expect(keys(latest.body.category)).toEqual(CATEGORY);

      const overview = await api().get(`${base()}/wallets`).expect(200);
      expect(overview.body.wallets.map((summary: { wallet: { id: number } }) => summary.wallet.id)).not.toContain(
        doomedId,
      );

      await createTransaction({ wallet_id: doomedId }).expect(403);
      await api().delete(`${base()}/transactions/${created.body.transaction.id}`).expect(200);
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
      expect(keys(summary.body)).toEqual(['categories', 'over_allocation', 'total']);
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
      expect(keys(members.body[0])).toEqual(['can_remove', 'email', 'id', 'name', 'role', 'type', 'user_id']);

      const profile = await api().get('/api/v1/users/profile').expect(200);
      expect(keys(profile.body)).toEqual(['created_at', 'email', 'id', 'name', 'updated_at']);
    });
  });
});
