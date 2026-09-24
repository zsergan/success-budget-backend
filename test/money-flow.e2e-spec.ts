import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.config';
import { UsersService } from '@modules/users/users.service';

// Request -> MySQL -> read back -> summaries, with exact money values
// (docs/type-contract.md, "Money").
describe('Money flow (e2e)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let userId: number;
  let token: string;
  let currencyId: number;
  const spaceIds: number[] = [];

  const now = () => new Date().toISOString();
  const LONG_AGO = '2020-01-10T12:00:00.000Z';

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    configureApp(app);
    await app.init();

    dataSource = moduleFixture.get(DataSource);
    const usersService = moduleFixture.get(UsersService);

    const [currency] = await dataSource.query('SELECT id FROM currencies LIMIT 1');
    currencyId = currency.id;
    const email = `e2e-money-${Date.now()}@example.com`;
    const user = await usersService.register({
      name: 'Money',
      email,
      password: 'DevTest#2026',
      base_currency_id: currencyId,
    });
    userId = user.id;
    await usersService.completeEmailVerification(user.id);
    token = await usersService.login({ email, password: 'DevTest#2026' });

    const [membership] = await dataSource.query('SELECT space_id FROM space_members WHERE user_id = ?', [userId]);
    spaceIds.push(membership.space_id);
  });

  afterAll(async () => {
    try {
      for (const id of spaceIds) {
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

  function api() {
    const agent = request(app.getHttpServer());
    const withAuth =
      (method: 'get' | 'post' | 'put') =>
      (url: string): request.Test =>
        agent[method](url).set('Authorization', `Bearer ${token}`);

    return { get: withAuth('get'), post: withAuth('post'), put: withAuth('put') };
  }

  async function setUpSpace(name: string) {
    const space = await api()
      .post('/api/v1/spaces')
      .send({ name, currency_id: currencyId, type: 'personal' })
      .expect(201);
    spaceIds.push(space.body.id);
    const base = `/api/v1/spaces/${space.body.id}`;
    const categories = await api().get(`${base}/categories`).expect(200);
    const [firstExpense, secondExpense] = categories.body.expenses.map((category: { id: number }) => category.id);

    const createWallet = (initial_balance: string) =>
      api().post(`${base}/wallets`).send({ wallet_name: name, initial_balance, design: 'slate' }).expect(201);
    const createTransaction = (
      wallet_id: number,
      transaction_type: 'income' | 'expense',
      amount: string,
      timestamp = now(),
    ) =>
      api()
        .post(`${base}/transactions`)
        .send({
          wallet_id,
          category_id: transaction_type === 'income' ? categories.body.incomes[0].id : firstExpense,
          transaction_type,
          amount,
          timestamp,
        })
        .expect(201);
    const spend = (wallet_id: number, category_id: number, amount: string) =>
      api()
        .post(`${base}/transactions`)
        .send({ wallet_id, category_id, transaction_type: 'expense', amount, timestamp: now() })
        .expect(201);
    const overview = async () => (await api().get(`${base}/wallets`).expect(200)).body;
    const limits = async () => (await api().get(`${base}/limits`).expect(200)).body;
    const createLimit = (amount: string, category_ids?: number[]) =>
      api().post(`${base}/limits`).send({ amount, category_ids }).expect(201);
    const storedAmounts = async (walletId: number): Promise<string[]> =>
      (
        await dataSource.query('SELECT amount FROM transactions WHERE wallet_id = ? ORDER BY timestamp, id', [walletId])
      ).map((row: { amount: string }) => row.amount);
    const readAmounts = async (walletId: number): Promise<string[]> =>
      (await api().get(`${base}/transactions?from=2000-01-01&to=2037-12-31`).expect(200)).body
        .filter((transaction: { wallet: { id: number } | null }) => transaction.wallet?.id === walletId)
        .map((transaction: { amount: string }) => transaction.amount)
        .reverse();

    return {
      firstExpense,
      secondExpense,
      createWallet,
      createTransaction,
      spend,
      overview,
      limits,
      createLimit,
      storedAmounts,
      readAmounts,
    };
  }

  it('keeps fractional amounts exact from the request to the stored row, the reads and the summaries', async () => {
    const space = await setUpSpace('Fractional');

    const wallet = await space.createWallet('100.10');
    expect(wallet.body.wallet.balance).toBe(100.1);
    expect(wallet.body.transaction.amount).toBe(100.1);
    const walletId = wallet.body.wallet.id;

    const steps: [string, 'income' | 'expense', string, number, number][] = [
      ['past income', 'income', '50.05', 100.1, 150.15],
      ['expense', 'expense', '0.29', 150.15, 149.86],
      ['expense', 'expense', '33.33', 149.86, 116.53],
      ['income', 'income', '0.01', 116.53, 116.54],
    ];
    for (const [step, type, amount, previous, balance] of steps) {
      const created = await space.createTransaction(walletId, type, amount, step === 'past income' ? LONG_AGO : now());

      expect(created.body.transaction.amount).toBe(amount);
      expect(created.body.previous_balance).toBe(previous);
      expect(created.body.wallet.balance).toBe(balance);
    }

    expect(await space.storedAmounts(walletId)).toEqual(['50.05', '100.10', '0.29', '33.33', '0.01']);
    expect(await space.readAmounts(walletId)).toEqual(['50.05', '100.10', '0.29', '33.33', '0.01']);

    // current month: net 100.11 - 33.62 = 66.49, start 116.54 - 66.49 = 50.05
    expect(await space.overview()).toEqual({
      total_balance: 116.54,
      total_balance_currency: expect.any(String),
      delta_percent: 132.8,
      wallets: [
        {
          wallet: expect.objectContaining({ id: walletId, balance: 116.54 }),
          total_income: 100.11,
          total_spend: 33.62,
        },
      ],
    });

    await space.createLimit('50.00');
    await space.createLimit('0.29', [space.firstExpense]);
    await space.spend(walletId, space.secondExpense, '0.01');
    const summary = await space.limits();
    expect(summary.total).toMatchObject({ amount: '50.00', spent: 33.63, in_percent: 67 });
    expect(summary.categories).toEqual([expect.objectContaining({ amount: '0.29', spent: 33.62, in_percent: 11593 })]);
    expect(summary.over_allocation).toBeNull();
  });

  it('computes a negative balance and flips delta_percent for a negative start balance', async () => {
    const space = await setUpSpace('Negative');

    const wallet = await space.createWallet('0');
    expect(wallet.body).toMatchObject({ wallet: { balance: 0 }, transaction: null });
    const walletId = wallet.body.wallet.id;

    const past = await space.createTransaction(walletId, 'expense', '1.00', LONG_AGO);
    expect(past.body).toMatchObject({ previous_balance: 0, wallet: { balance: -1 } });
    await space.createTransaction(walletId, 'income', '0.10');
    const overdraft = await space.createTransaction(walletId, 'expense', '0.30');
    expect(overdraft.body).toMatchObject({ previous_balance: -0.9, wallet: { balance: -1.2 } });

    expect(await space.storedAmounts(walletId)).toEqual(['1.00', '0.10', '0.30']);

    // net -0.20 against a start balance of -1.00
    expect(await space.overview()).toMatchObject({
      total_balance: -1.2,
      delta_percent: 20,
      wallets: [{ wallet: expect.objectContaining({ balance: -1.2 }), total_income: 0.1, total_spend: 0.3 }],
    });
  });

  it('accepts the maximum amount on every field and sums past it without losing cents', async () => {
    const space = await setUpSpace('Maximum');

    const wallet = await space.createWallet('99999999.99');
    expect(wallet.body.wallet.balance).toBe(99999999.99);
    const walletId = wallet.body.wallet.id;

    const income = await space.createTransaction(walletId, 'income', '99999999.99');
    expect(income.body).toMatchObject({ previous_balance: 99999999.99, wallet: { balance: 199999999.98 } });
    const expense = await space.spend(walletId, space.firstExpense, '99999999.99');
    expect(expense.body).toMatchObject({ previous_balance: 199999999.98, wallet: { balance: 99999999.99 } });

    expect(await space.storedAmounts(walletId)).toEqual(['99999999.99', '99999999.99', '99999999.99']);

    expect(await space.overview()).toMatchObject({
      total_balance: 99999999.99,
      wallets: [{ total_income: 199999999.98, total_spend: 99999999.99 }],
    });

    await space.createLimit('0');
    const categoryLimit = await space.createLimit('99999999.99', [space.firstExpense]);
    expect(categoryLimit.body.amount).toBe('99999999.99');
    expect(await space.limits()).toMatchObject({
      total: { amount: '0.00', spent: 99999999.99, in_percent: 0 },
      categories: [{ amount: '99999999.99', spent: 99999999.99, in_percent: 100 }],
      over_allocation: { category_total: 99999999.99, difference: 99999999.99 },
    });
  });
});
