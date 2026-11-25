import request from 'supertest';

import { type Member, type TestApp, createTestApp, createVerifiedMember, deleteUsers, today } from './support/app';

// Request -> MySQL -> read back -> summaries, with exact money values
// (docs/type-contract.md, "Money").
describe('Money flow (e2e)', () => {
  let testApp: TestApp;
  let member: Member;
  const userIds: number[] = [];

  const now = () => today();
  const LONG_AGO = '2020-01-10';
  const ALL = { from_date: '2000-01-01', to_date: '2099-12-31' };

  beforeAll(async () => {
    testApp = await createTestApp();
    member = await createVerifiedMember(testApp, 'money');
    userIds.push(member.userId);
  });

  afterAll(async () => {
    try {
      await deleteUsers(testApp.dataSource, userIds);
    } finally {
      await testApp.app.close();
    }
  });

  function api() {
    const agent = request(testApp.app.getHttpServer());
    const withAuth =
      (method: 'get' | 'post') =>
      (url: string): request.Test =>
        agent[method](url).set('Authorization', `Bearer ${member.token}`);

    return { get: withAuth('get'), post: withAuth('post') };
  }

  async function setUpSpace(name: string) {
    const space = await api()
      .post('/api/v1/spaces')
      .send({ name, currency_id: testApp.currencyId, type: 'personal' })
      .expect(201);
    const id: number = space.body.id;
    const base = `/api/v1/spaces/${id}`;
    const transactions = `/api/v2/spaces/${id}/transactions`;
    const categories = await api().get(`${base}/categories`).expect(200);
    const [firstExpense, secondExpense] = categories.body.expenses.map((category: { id: number }) => category.id);

    const create = (transaction_type: 'income' | 'expense', amount: string, date = now(), category_id?: number) =>
      api()
        .post(transactions)
        .send({
          category_id: category_id ?? (transaction_type === 'income' ? categories.body.incomes[0].id : firstExpense),
          transaction_type,
          amount,
          date,
          time_zone: 'UTC',
          assignment: { kind: 'space' },
        })
        .expect(201);
    const feed = async (query: object = ALL) =>
      (
        await api()
          .get(`${transactions}/feed`)
          .query({ limit: 100, ...query })
          .expect(200)
      ).body;
    const month = async () =>
      (
        await api()
          .get(`/api/v2/spaces/${id}/statistics/summary`)
          .query({ period: 'month', time_zone: 'UTC' })
          .expect(200)
      ).body;
    const limits = async () => (await api().get(`${base}/limits`).expect(200)).body;
    const createLimit = (amount: string, category_ids?: number[]) =>
      api().post(`${base}/limits`).send({ amount, category_ids }).expect(201);
    const storedAmounts = async (): Promise<string[]> =>
      (
        await testApp.dataSource.query('SELECT amount FROM transactions WHERE space_id = ? ORDER BY date, order_key', [
          id,
        ])
      ).map((row: { amount: string }) => row.amount);
    const readAmounts = async (): Promise<string[]> =>
      (await feed()).items.map((transaction: { amount: string }) => transaction.amount).reverse();

    return { firstExpense, secondExpense, create, feed, month, limits, createLimit, storedAmounts, readAmounts };
  }

  it('keeps fractional amounts exact from the request to the stored row, the reads and the summaries', async () => {
    const space = await setUpSpace('Fractional');

    const steps: [string | null, 'income' | 'expense', string][] = [
      [LONG_AGO, 'income', '50.05'],
      [null, 'expense', '0.29'],
      [null, 'expense', '33.33'],
      [null, 'income', '0.01'],
    ];
    for (const [date, type, amount] of steps) {
      const created = await space.create(type, amount, date ?? now());

      expect(created.body.transaction.amount).toBe(amount);
    }

    expect(await space.storedAmounts()).toEqual(['50.05', '0.29', '33.33', '0.01']);
    expect(await space.readAmounts()).toEqual(['50.05', '0.29', '33.33', '0.01']);
    expect((await space.feed()).summary).toEqual({ count: 4, income: '50.06', expense: '33.62' });
    expect(await space.month()).toMatchObject({
      income: { amount: '0.01', count: 1 },
      expense: { amount: '33.62', count: 2 },
      net: '-33.61',
    });

    await space.createLimit('50.00');
    await space.createLimit('0.29', [space.firstExpense]);
    await space.create('expense', '0.01', now(), space.secondExpense);
    const summary = await space.limits();
    expect(summary.total).toMatchObject({ amount: '50.00', spent: 33.63, in_percent: 67 });
    expect(summary.categories).toEqual([expect.objectContaining({ amount: '0.29', spent: 33.62, in_percent: 11593 })]);
    expect(summary.over_allocation).toBeNull();
  });

  it('keeps the sign of a negative net in the day totals and the month', async () => {
    const space = await setUpSpace('Negative');

    await space.create('expense', '1.00', LONG_AGO);
    await space.create('income', '0.10');
    await space.create('expense', '0.30');

    expect(await space.storedAmounts()).toEqual(['1.00', '0.10', '0.30']);
    expect((await space.feed()).day_totals).toEqual([
      { date: expect.any(String), net: '-0.20' },
      { date: '2020-01-10', net: '-1.00' },
    ]);
    expect(await space.month()).toMatchObject({ net: '-0.20', transactions_count: 2 });
  });

  it('accepts the maximum amount on every field and sums past it without losing cents', async () => {
    const space = await setUpSpace('Maximum');

    await space.create('income', '99999999.99');
    await space.create('expense', '99999999.99');
    await space.create('expense', '99999999.99', now(), space.secondExpense);

    expect(await space.storedAmounts()).toEqual(['99999999.99', '99999999.99', '99999999.99']);
    expect((await space.feed()).summary).toEqual({ count: 3, income: '99999999.99', expense: '199999999.98' });
    expect(await space.month()).toMatchObject({ expense: { amount: '199999999.98' }, net: '-99999999.99' });

    await space.createLimit('0');
    const categoryLimit = await space.createLimit('99999999.99', [space.firstExpense]);
    expect(categoryLimit.body.amount).toBe('99999999.99');
    expect(await space.limits()).toMatchObject({
      total: { amount: '0.00', spent: 199999999.98, in_percent: 0 },
      categories: [{ amount: '99999999.99', spent: 99999999.99, in_percent: 100 }],
      over_allocation: { category_total: 99999999.99, difference: 99999999.99 },
    });
  });
});
