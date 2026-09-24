import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.config';
import { UsersService } from '@modules/users/users.service';
import { TransactionQueriesService } from '@modules/transaction-queries/transaction-queries.service';

// Pins the runtime types at the HTTP/DB boundary described in
// docs/type-contract.md. `it.failing` marks a documented gap (currently a
// 500 or an accepted value) whose target is a 400 validation error - once
// fixed, the test starts failing and must be switched to a plain `it`.
describe('Boundary type contract (e2e)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let transactionQueriesService: TransactionQueriesService;
  let userId: number;
  let token: string;
  let spaceId: number;
  let expenseCategoryId: number;
  let walletId: number;

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
    const user = await usersService.register({
      name: 'Contract',
      email: `e2e-contract-${Date.now()}@example.com`,
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
      if (spaceId) {
        await dataSource.query(
          'DELETE lc FROM limit_categories lc INNER JOIN limits l ON l.id = lc.limit_id WHERE l.space_id = ?',
          [spaceId],
        );
        await dataSource.query('DELETE FROM limits WHERE space_id = ?', [spaceId]);
        await dataSource.query(
          'DELETE t FROM transactions t INNER JOIN wallets w ON w.id = t.wallet_id WHERE w.space_id = ?',
          [spaceId],
        );
        await dataSource.query('DELETE FROM space_members WHERE space_id = ?', [spaceId]);
        await dataSource.query('DELETE FROM spaces WHERE id = ?', [spaceId]);
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
    });
  });

  describe('dates', () => {
    it('serializes timestamps as ISO-8601 UTC strings', async () => {
      const created = await createTransaction().expect(201);
      const read = await readTransaction(created.body.transaction.id);

      expect(read.timestamp).toMatch(ISO_DATE);
      expect(read.wallet.created_at).toMatch(ISO_DATE);
    });

    it('passes query from/to through as raw strings, and defaults absent ones to Date', async () => {
      const spy = jest.spyOn(transactionQueriesService, 'getForAllWallets');

      await api().get(`${base()}/transactions?from=2026-01-01&to=2026-01-31`).expect(200);
      expect(spy).toHaveBeenLastCalledWith(spaceId, '2026-01-01', '2026-01-31');

      await api().get(`${base()}/transactions`).expect(200);
      const [, from, to] = spy.mock.lastCall!;
      expect(from).toBeInstanceOf(Date);
      expect(to).toBeInstanceOf(Date);
    });

    it.failing('rejects a malformed from with a 400', async () => {
      await api().get(`${base()}/transactions?from=garbage`).expect(400);
    });

    it.failing('rejects an empty from with a 400', async () => {
      await api().get(`${base()}/wallets?from=`).expect(400);
    });
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

    it.failing('rejects null for a non-nullable update field with a 400', async () => {
      await api().put(`${base()}/wallets/${walletId}`).send({ wallet_name: null }).expect(400);
    });

    it.failing('rejects an empty string for a field that is required on create with a 400', async () => {
      await api().put(`${base()}/wallets/${walletId}`).send({ wallet_name: '' }).expect(400);
    });
  });
});
