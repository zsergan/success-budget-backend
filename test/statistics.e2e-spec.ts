import request from 'supertest';

import {
  type Member,
  type TestApp,
  createTestApp,
  createVerifiedMember,
  deleteUsers,
  insertLegacyTransaction,
} from './support/app';
import { createOpenApiDocument, okResponseSchema, schemaErrors } from './support/openapi';

// A fixed as_of in the past keeps these independent of the real clock:
// 15:00 on Monday 2026-09-28 in Moscow.
const AS_OF = '2026-09-28T12:00:00.000Z';
const MONTH = { period: 'month', time_zone: 'Europe/Moscow', as_of: AS_OF };
const BLOCKS = ['summary', 'trend', 'breakdown'] as const;

describe('Statistics blocks (e2e)', () => {
  let testApp: TestApp;
  let owner: Member;
  let outsider: Member;
  let neighbour: Member;

  beforeAll(async () => {
    testApp = await createTestApp();
    owner = await createVerifiedMember(testApp, 'statistics-owner');
    outsider = await createVerifiedMember(testApp, 'statistics-outsider');
    neighbour = await createVerifiedMember(testApp, 'statistics-neighbour');

    const categories = await api(owner)
      .get(`${base(owner)}/categories`)
      .expect(200);
    const [salary] = categories.body.incomes;
    const expense = (name: string) =>
      categories.body.expenses.find((category: { name: string }) => category.name === name);
    const [housing, transport, grocery] = ['Housing', 'Transport', 'Groceries'].map(expense);

    const card = { kind: 'member', user_id: owner.userId };
    const cash = { kind: 'space' };
    const oldCard = { kind: 'unassigned' };
    // a starting balance: income on the system category, never statistics
    await startingBalance(owner, '1000', new Date());

    const add = (assignment: object, categoryId: number, type: string, amount: string, timestamp: string) =>
      api(owner)
        .post(`${v2(owner)}/transactions`)
        .send({ assignment, category_id: categoryId, transaction_type: type, amount, timestamp })
        .expect(201);

    await add(card, salary.id, 'income', '3000', '2026-09-01T07:00:00.000Z');
    await add(card, housing.id, 'expense', '450.25', '2026-09-02T16:30:00.000Z');
    await add(cash, transport.id, 'expense', '120', '2026-09-05T10:00:00.000Z');
    await add(oldCard, grocery.id, 'expense', '80', '2026-09-12T17:00:00.000Z');
    // a legacy zero amount: refused by the API since the transactions contract
    await insertLegacyTransaction(testApp.dataSource, {
      spaceId: owner.spaceId,
      categoryId: transport.id,
      type: 'expense',
      amount: '0',
      timestamp: new Date('2026-09-21T06:00:00.000Z'),
    });
    // 00:30 on Sep 28 in Moscow, still Sep 27 in UTC
    await add(cash, housing.id, 'expense', '10', '2026-09-27T21:30:00.000Z');
    // after as_of
    await add(card, housing.id, 'expense', '500', '2026-09-29T07:00:00.000Z');
    // the very last millisecond of July in Moscow
    await add(card, transport.id, 'expense', '7.77', '2026-07-31T20:59:59.999Z');
    // August, the month before
    await add(card, housing.id, 'expense', '200', '2026-08-10T09:00:00.000Z');
    // June: sums a float would get wrong
    for (const amount of ['0.10', '0.20', '99999999.99', '99999999.99', '99999999.99']) {
      await add(cash, housing.id, 'expense', amount, '2026-06-15T09:00:00.000Z');
    }

    // another space with transactions in the same month must not leak in
    const neighbourCategories = await api(neighbour)
      .get(`${base(neighbour)}/categories`)
      .expect(200);
    await api(neighbour)
      .post(`${v2(neighbour)}/transactions`)
      .send({
        assignment: { kind: 'member', user_id: neighbour.userId },
        category_id: neighbourCategories.body.expenses[0].id,
        transaction_type: 'expense',
        amount: '999',
        timestamp: '2026-09-10T09:00:00.000Z',
      })
      .expect(201);

    await api(owner)
      .delete(`${base(owner)}/categories/${grocery.id}`)
      .expect(200);
  });

  afterAll(async () => {
    try {
      await deleteUsers(testApp.dataSource, [owner?.userId, outsider?.userId, neighbour?.userId].filter(Boolean));
    } finally {
      await testApp.app.close();
    }
  });

  function base(member: Member): string {
    return `/api/v1/spaces/${member.spaceId}`;
  }

  function v2(member: Member): string {
    return `/api/v2/spaces/${member.spaceId}`;
  }

  function api(member: Member) {
    const agent = request(testApp.app.getHttpServer());
    const withAuth =
      (method: 'get' | 'post' | 'delete') =>
      (url: string): request.Test =>
        agent[method](url).set('Authorization', `Bearer ${member.token}`);

    return { get: withAuth('get'), post: withAuth('post'), delete: withAuth('delete') };
  }

  // a starting balance a wallet left in the history of the space
  async function startingBalance(member: Member, amount: string, timestamp: Date): Promise<void> {
    const [system] = await testApp.dataSource.query('SELECT id FROM categories WHERE space_id = ? AND is_system = 1', [
      member.spaceId,
    ]);
    await insertLegacyTransaction(testApp.dataSource, {
      spaceId: member.spaceId,
      categoryId: system.id,
      type: 'income',
      amount,
      timestamp,
    });
  }

  function getBlock(block: (typeof BLOCKS)[number], query: Record<string, string>, member = owner) {
    return api(member)
      .get(`${v2(owner)}/statistics/${block}`)
      .query(query);
  }

  it('summary counts the space by the shared rules', async () => {
    const res = await getBlock('summary', MONTH).expect(200);

    expect(res.body).toEqual({
      period: {
        type: 'month',
        time_zone: 'Europe/Moscow',
        start_date: '2026-09-01',
        end_date: '2026-09-30',
        from: '2026-08-31T21:00:00.000Z',
        to: '2026-09-30T20:59:59.999Z',
        as_of: AS_OF,
        actual_to: AS_OF,
        state: 'current',
      },
      currency: expect.any(String),
      // no starting balance
      income: { amount: '3000.00', count: 1 },
      // unassigned, archived category and a zero amount included; after as_of excluded
      expense: { amount: '660.25', count: 5 },
      net: '2339.75',
      transactions_count: 6,
      // August 1 to 28, 15:00: the like-for-like part
      previous: {
        start_date: '2026-08-01',
        end_date: '2026-08-31',
        from: '2026-07-31T21:00:00.000Z',
        to: '2026-08-31T20:59:59.999Z',
        actual_to: '2026-08-28T12:00:00.000Z',
        income: { amount: '0.00', count: 0 },
        expense: { amount: '200.00', count: 1 },
        net: '-200.00',
        transactions_count: 1,
      },
      change: {
        income: { delta: '3000.00', percent: null },
        expense: { delta: '460.25', percent: 230.1 },
        net: { delta: '2539.75', percent: 1269.9 },
      },
      has_any_transactions: true,
      // 00:30 on Sep 28 in Moscow; the one after as_of does not count
      last_transaction_date: '2026-09-28',
    });
  });

  it('summary tells a space without transactions', async () => {
    const res = await api(outsider)
      .get(`${v2(outsider)}/statistics/summary`)
      .query(MONTH)
      .expect(200);

    expect(res.body).toMatchObject({ transactions_count: 0, has_any_transactions: false, last_transaction_date: null });
  });

  it('breakdown groups expenses by category and by assignment in SQL', async () => {
    const res = await getBlock('breakdown', MONTH).expect(200);
    const brief = (items: Record<string, unknown>[]) =>
      items.map(({ kind, name, amount, percent, is_archived, opens_history }) => ({
        kind,
        name,
        amount,
        percent,
        is_archived,
        opens_history,
      }));

    expect(res.body.total).toEqual({ amount: '660.25', count: 5 });
    expect(res.body.by_category).toMatchObject({ total_amount: '660.25', source_count: 3, other: null });
    expect(brief(res.body.by_category.primary_items)).toEqual([
      { kind: 'category', name: 'Housing', amount: '460.25', percent: 69.7, is_archived: false, opens_history: true },
      {
        kind: 'category',
        name: 'Transport',
        amount: '120.00',
        percent: 18.2,
        is_archived: false,
        opens_history: true,
      },
      { kind: 'category', name: 'Groceries', amount: '80.00', percent: 12.1, is_archived: true, opens_history: true },
    ]);
    expect(res.body.by_category.primary_items[0]).toMatchObject({
      key: `category:${res.body.by_category.primary_items[0].id}`,
      icon: expect.any(String),
      color: expect.any(String),
    });

    expect(res.body.by_assignment).toMatchObject({ total_amount: '660.25', source_count: 3, other: null });
    expect(
      res.body.by_assignment.primary_items.map(({ key, amount, percent }: Record<string, unknown>) => ({
        key,
        amount,
        percent,
      })),
    ).toEqual([
      { key: `member:${owner.userId}`, amount: '450.25', percent: 68.2 },
      { key: 'space', amount: '130.00', percent: 19.7 },
      { key: 'unassigned', amount: '80.00', percent: 12.1 },
    ]);
  });

  it('breakdown groups income by the same rules, without starting balances', async () => {
    const member = await createVerifiedMember(testApp, 'statistics-income');

    try {
      const url = base(member);
      const categories = await api(member).get(`${url}/categories`).expect(200);
      const [salary, freelance] = categories.body.incomes;
      const [groceries] = categories.body.expenses;
      const zeroCategory = await api(member)
        .post(`${url}/categories`)
        .send({ name: 'Zero income', transaction_type: 'income', icon: 'Other', color: 'slate' })
        .expect(201);
      const card = { kind: 'member', user_id: member.userId };
      const oldCard = { kind: 'unassigned' };
      const add = (assignment: object, categoryId: number, type: string, amount: string, timestamp: string) =>
        api(member)
          .post(`${v2(member)}/transactions`)
          .send({ assignment, category_id: categoryId, transaction_type: type, amount, timestamp })
          .expect(201);
      // assigned to the whole space
      const insert = (categoryId: number, amount: string, timestamp: string) =>
        insertLegacyTransaction(testApp.dataSource, {
          spaceId: member.spaceId,
          categoryId,
          type: 'income',
          amount,
          timestamp: new Date(timestamp),
        });

      await add(card, salary.id, 'income', '3000', '2026-09-01T07:00:00.000Z');
      await add(oldCard, freelance.id, 'income', '200', '2026-09-05T07:00:00.000Z');
      await add(card, groceries.id, 'expense', '50', '2026-09-06T07:00:00.000Z');
      // a refund: counted by its own type, on an expense category
      await insert(groceries.id, '20', '2026-09-07T07:00:00.000Z');
      // a legacy zero amount: counted, but no segment
      await insert(zeroCategory.body.id, '0', '2026-09-08T07:00:00.000Z');
      // a starting balance inside the period
      await startingBalance(member, '500', new Date('2026-09-02T07:00:00.000Z'));
      await api(member).delete(`${url}/categories/${freelance.id}`).expect(200);

      const get = (block: 'summary' | 'breakdown', query: Record<string, string>) =>
        api(member)
          .get(`${v2(member)}/statistics/${block}`)
          .query(query)
          .expect(200);
      const [summary, income, expense] = await Promise.all([
        get('summary', MONTH),
        get('breakdown', { ...MONTH, transaction_type: 'income' }),
        get('breakdown', MONTH),
      ]);
      const ids = (items: { id: number }[]) => items.map((item) => item.id);

      expect(income.body.transaction_type).toBe('income');
      expect(income.body.total).toEqual({ amount: '3220.00', count: 4 });
      expect(income.body.total).toEqual(summary.body.income);
      expect(expense.body.total).toEqual({ amount: '50.00', count: 1 });
      expect(expense.body.total).toEqual(summary.body.expense);

      expect(income.body.by_category).toMatchObject({ total_amount: '3220.00', source_count: 3 });
      expect(income.body.by_category.primary_items).toEqual([
        expect.objectContaining({ id: salary.id, amount: '3000.00', percent: 93.2, is_archived: false }),
        expect.objectContaining({ id: freelance.id, amount: '200.00', percent: 6.2, is_archived: true }),
      ]);
      expect(ids(income.body.by_category.other.children)).toEqual([groceries.id]);

      // the whole space and nobody are never folded, however small
      expect(income.body.by_assignment).toMatchObject({ total_amount: '3220.00', source_count: 3, other: null });
      expect(
        income.body.by_assignment.primary_items.map((item: { key: string; amount: string }) => [item.key, item.amount]),
      ).toEqual([
        [`member:${member.userId}`, '3000.00'],
        ['unassigned', '200.00'],
        ['space', '20.00'],
      ]);

      const document = createOpenApiDocument(testApp.app);
      expect(schemaErrors(document, okResponseSchema(document, '/statistics/breakdown'), income.body)).toEqual([]);
    } finally {
      await deleteUsers(testApp.dataSource, [member.userId]);
    }
  });

  it('folds income by the expense rules: six slots, 3% on cents', async () => {
    const member = await createVerifiedMember(testApp, 'statistics-income-other');

    try {
      const url = base(member);
      const categories = await api(member).get(`${url}/categories`).expect(200);
      const [salary, gifts] = categories.body.incomes;
      const category = (name: string) =>
        api(member)
          .post(`${url}/categories`)
          .send({ name, transaction_type: 'income', icon: 'Other', color: 'slate' })
          .expect(201)
          .then((res) => res.body.id as number);
      const realOther = await category('Other');
      const ids: number[] = [];
      for (const name of ['A', 'B', 'C', 'D', 'E', 'F']) {
        ids.push(await category(name));
      }
      const [catA, catB, catC, catD, catE, catF] = ids;
      const add = (categoryId: number, amount: string) =>
        api(member)
          .post(`${v2(member)}/transactions`)
          .send({
            assignment: { kind: 'space' },
            category_id: categoryId,
            transaction_type: 'income',
            amount,
            timestamp: '2026-09-10T09:00:00.000Z',
          })
          .expect(201);

      // of 10000.00: 40, 20, 15, 10, 4, 4, 4, 2.96 and 0.04%
      await add(salary.id, '4000');
      await add(gifts.id, '2000');
      await add(realOther, '1500');
      await add(catA, '1000');
      await add(catB, '400');
      await add(catC, '400');
      await add(catD, '400');
      await add(catE, '296');
      await add(catF, '4');
      await api(member).delete(`${url}/categories/${gifts.id}`).expect(200);

      const { body } = await api(member)
        .get(`${v2(member)}/statistics/breakdown`)
        .query({ ...MONTH, transaction_type: 'income' })
        .expect(200);
      const rows = (items: { id: number | null; amount: string; percent: number }[]) =>
        items.map(({ id, amount, percent }) => [id, amount, percent]);

      expect(body.total).toEqual({ amount: '10000.00', count: 9 });

      expect(body.by_category.source_count).toBe(9);
      expect(rows(body.by_category.primary_items)).toEqual([
        [salary.id, '4000.00', 40],
        [gifts.id, '2000.00', 20],
        [realOther, '1500.00', 15],
        [catA, '1000.00', 10],
        [catB, '400.00', 4],
        [catC, '400.00', 4],
      ]);
      expect(body.by_category.primary_items[1]).toMatchObject({ is_archived: true, opens_history: true });
      expect(body.by_category.primary_items[2]).toMatchObject({ kind: 'category', name: 'Other', opens_history: true });
      expect(body.by_category.other).toMatchObject({
        kind: 'other',
        id: null,
        amount: '700.00',
        percent: 7,
        opens_history: false,
      });
      // E is 2.96%: shown as 3.0, folded all the same
      expect(rows(body.by_category.other.children)).toEqual([
        [catD, '400.00', 4],
        [catE, '296.00', 3],
        [catF, '4.00', 0],
      ]);

      expect(body.by_assignment).toMatchObject({ source_count: 1, other: null });
      expect(body.by_assignment.primary_items).toEqual([
        expect.objectContaining({ key: 'space', amount: '10000.00', percent: 100 }),
      ]);

      for (const categoryId of [gifts.id, realOther]) {
        const history = await api(member)
          .get(`${v2(member)}/transactions/feed`)
          .query({
            from: body.period.from,
            to: body.period.actual_to,
            time_zone: 'UTC',
            transaction_type: 'income',
            category_id: categoryId,
          })
          .expect(200);
        const item = body.by_category.primary_items.find((row: { id: number }) => row.id === categoryId);

        expect(history.body.items.map((tx: { amount: string }) => tx.amount)).toEqual([item.amount]);
      }
    } finally {
      await deleteUsers(testApp.dataSource, [member.userId]);
    }
  });

  it('trend splits the month into calendar weeks up to as_of', async () => {
    const res = await getBlock('trend', MONTH).expect(200);

    expect(res.body.granularity).toBe('week');
    expect(
      res.body.buckets.map((bucket: Record<string, string>) => [
        bucket.key,
        bucket.start_date,
        bucket.end_date,
        bucket.state,
        bucket.income,
        bucket.expense,
      ]),
    ).toEqual([
      ['2026-W36', '2026-09-01', '2026-09-06', 'past', '3000.00', '570.25'],
      ['2026-W37', '2026-09-07', '2026-09-13', 'past', '0.00', '80.00'],
      ['2026-W38', '2026-09-14', '2026-09-20', 'past', '0.00', '0.00'],
      // the zero-amount transaction; the Sunday-night one belongs to the next week in Moscow
      ['2026-W39', '2026-09-21', '2026-09-27', 'past', '0.00', '0.00'],
      // the transaction after as_of is left out
      ['2026-W40', '2026-09-28', '2026-09-30', 'current', '0.00', '10.00'],
    ]);
    expect(res.body.buckets[0]).toMatchObject({ from: '2026-08-31T21:00:00.000Z', to: '2026-09-06T20:59:59.999Z' });
  });

  it('trend of a future period has only empty future buckets and no comparison anywhere', async () => {
    const future = { ...MONTH, anchor_date: '2026-10-01' };
    const [summary, trend] = await Promise.all([
      getBlock('summary', future).expect(200),
      getBlock('trend', future).expect(200),
    ]);

    expect(summary.body).toMatchObject({ period: { state: 'future' }, previous: null, change: null });
    expect(trend.body.buckets).toHaveLength(5);
    expect(trend.body.buckets).toEqual(
      Array(5).fill(expect.objectContaining({ state: 'future', income: null, expense: null })),
    );
  });

  it('does not compare a custom period', async () => {
    const res = await getBlock('summary', {
      period: 'custom',
      from_date: '2026-09-01',
      to_date: '2026-09-28',
      time_zone: 'Europe/Moscow',
      as_of: AS_OF,
    }).expect(200);

    expect(res.body).toMatchObject({ previous: null, change: null, expense: { amount: '660.25', count: 5 } });
  });

  it('keeps spaces apart', async () => {
    const [own, other] = await Promise.all([
      getBlock('breakdown', MONTH).expect(200),
      api(neighbour)
        .get(`${v2(neighbour)}/statistics/breakdown`)
        .query(MONTH)
        .expect(200),
    ]);

    expect(own.body.total).toEqual({ amount: '660.25', count: 5 });
    expect(other.body.total).toEqual({ amount: '999.00', count: 1 });
    expect(other.body.by_assignment.primary_items.map((item: { key: string }) => item.key)).toEqual([
      `member:${neighbour.userId}`,
    ]);

    // the neighbour has only expenses: the owner's income does not leak in
    const [ownIncome, otherIncome] = await Promise.all([
      getBlock('breakdown', { ...MONTH, transaction_type: 'income' }).expect(200),
      api(neighbour)
        .get(`${v2(neighbour)}/statistics/breakdown`)
        .query({ ...MONTH, transaction_type: 'income' })
        .expect(200),
    ]);

    expect(ownIncome.body.total).toEqual({ amount: '3000.00', count: 1 });
    expect(otherIncome.body.total).toEqual({ amount: '0.00', count: 0 });
    expect(otherIncome.body.by_category).toEqual({
      total_amount: '0.00',
      source_count: 0,
      primary_items: [],
      other: null,
    });
  });

  it('income breakdown: empty, one exact group, period bounds, zone, as_of and a future period', async () => {
    const member = await createVerifiedMember(testApp, 'statistics-income-only');

    try {
      const url = base(member);
      const get = (query: Record<string, string>) =>
        api(member)
          .get(`${v2(member)}/statistics/breakdown`)
          .query(query)
          .expect(200);
      const EMPTY_ASSIGNMENTS = { total_amount: '0.00', source_count: 0, primary_items: [], other: null };
      const expectEmpty = (body: Record<string, unknown>, type: string) =>
        expect(body).toMatchObject({
          transaction_type: type,
          total: { amount: '0.00', count: 0 },
          by_category: { total_amount: '0.00', source_count: 0, primary_items: [], other: null },
          by_assignment: EMPTY_ASSIGNMENTS,
        });

      for (const type of ['income', 'expense']) {
        expectEmpty((await get({ ...MONTH, transaction_type: type })).body, type);
      }

      const categories = await api(member).get(`${url}/categories`).expect(200);
      const [salary] = categories.body.incomes;
      const add = (amount: string, timestamp: string) =>
        api(member)
          .post(`${v2(member)}/transactions`)
          .send({
            assignment: { kind: 'unassigned' },
            category_id: salary.id,
            transaction_type: 'income',
            amount,
            timestamp,
          })
          .expect(201);

      // sums a float would get wrong
      for (const amount of ['0.10', '0.20', '99999999.99', '99999999.99', '99999999.99']) {
        await add(amount, '2026-09-10T09:00:00.000Z');
      }
      // after as_of, inside September
      await add('7', '2026-09-29T07:00:00.000Z');
      // 00:30 on October 1 in Moscow, still September 30 in UTC
      await add('5', '2026-09-30T21:30:00.000Z');

      const income = { ...MONTH, transaction_type: 'income' };
      const current = await get(income);
      const summary = await api(member)
        .get(`${v2(member)}/statistics/summary`)
        .query(MONTH)
        .expect(200);

      expect(current.body.total).toEqual({ amount: '300000000.27', count: 5 });
      expect(current.body.total).toEqual(summary.body.income);
      expect(current.body.by_category.primary_items).toEqual([
        expect.objectContaining({ id: salary.id, amount: '300000000.27', percent: 100 }),
      ]);
      expect(current.body.by_category.other).toBeNull();
      expect(current.body.by_assignment).toMatchObject({ source_count: 1, other: null });
      expectEmpty((await get(MONTH)).body, 'expense');

      const past = { ...income, anchor_date: '2026-09-15', as_of: '2026-10-05T00:00:00.000Z' };
      expect((await get(past)).body.total).toEqual({ amount: '300000007.27', count: 6 });
      expect((await get({ ...past, time_zone: 'UTC' })).body.total).toEqual({ amount: '300000012.27', count: 7 });

      const future = (await get({ ...income, anchor_date: '2026-12-15' })).body;
      expect(future.period.state).toBe('future');
      expectEmpty(future, 'income');
    } finally {
      await deleteUsers(testApp.dataSource, [member.userId]);
    }
  });

  it('adds money exactly, beyond the range of a single amount', async () => {
    const june = { ...MONTH, anchor_date: '2026-06-01' };
    const [summary, trend, breakdown] = await Promise.all(BLOCKS.map((block) => getBlock(block, june).expect(200)));

    expect(summary.body.expense).toEqual({ amount: '300000000.27', count: 5 });
    expect(trend.body.totals.expense).toEqual(summary.body.expense);
    expect(trend.body.buckets.find((bucket: { expense: string }) => bucket.expense !== '0.00').expense).toBe(
      '300000000.27',
    );
    expect(breakdown.body.by_category.primary_items).toEqual([
      expect.objectContaining({ name: 'Housing', amount: '300000000.27', percent: 100 }),
    ]);
  });

  it('trend and breakdown carry control sums equal to the summary', async () => {
    const [summary, trend, breakdown] = await Promise.all(BLOCKS.map((block) => getBlock(block, MONTH).expect(200)));

    expect(trend.body.period).toEqual(summary.body.period);
    expect(breakdown.body.period).toEqual(summary.body.period);
    expect(trend.body.totals).toEqual({ income: summary.body.income, expense: summary.body.expense });
    expect(breakdown.body.total).toEqual(summary.body.expense);

    const cents = (amount: string) => Math.round(Number(amount) * 100);
    const bucketSum = (field: 'income' | 'expense') =>
      trend.body.buckets.reduce((sum: number, bucket: Record<string, string>) => sum + cents(bucket[field]), 0);
    const groupSum = (items: { amount: string }[]) => items.reduce((sum, item) => sum + cents(item.amount), 0);
    const { by_category: byCategory, by_assignment: byAssignment } = breakdown.body;

    expect(bucketSum('income')).toBe(cents(summary.body.income.amount));
    expect(bucketSum('expense')).toBe(cents(summary.body.expense.amount));
    expect(groupSum([...byCategory.primary_items, ...(byCategory.other ? [byCategory.other] : [])])).toBe(
      cents(summary.body.expense.amount),
    );
    expect(groupSum([...byAssignment.primary_items, ...(byAssignment.other ? [byAssignment.other] : [])])).toBe(
      cents(summary.body.expense.amount),
    );
  });

  it('draws day boundaries in the requested zone', async () => {
    const week = { period: 'week', as_of: AS_OF };

    const moscow = await getBlock('summary', { ...week, time_zone: 'Europe/Moscow' }).expect(200);
    const utc = await getBlock('summary', { ...week, time_zone: 'UTC' }).expect(200);

    expect(moscow.body.expense).toEqual({ amount: '10.00', count: 1 });
    expect(utc.body.expense).toEqual({ amount: '0.00', count: 0 });
  });

  it('reports zero-amount transactions as present', async () => {
    const res = await getBlock('summary', {
      period: 'custom',
      from_date: '2026-09-21',
      to_date: '2026-09-21',
      time_zone: 'Europe/Moscow',
      as_of: AS_OF,
    }).expect(200);

    expect(res.body).toMatchObject({ expense: { amount: '0.00', count: 1 }, transactions_count: 1, net: '0.00' });
    expect(res.body.period.state).toBe('past');
  });

  it('returns an empty future period', async () => {
    const res = await getBlock('summary', { ...MONTH, anchor_date: '2026-10-01' }).expect(200);

    expect(res.body.period).toMatchObject({ state: 'future', actual_to: null });
    expect(res.body.transactions_count).toBe(0);
  });

  it('defaults as_of to the server time and reports it', async () => {
    const before = Date.now();
    const res = await getBlock('summary', { period: 'year', time_zone: 'UTC' }).expect(200);

    expect(new Date(res.body.period.as_of).getTime()).toBeGreaterThanOrEqual(before);
  });

  it.each(BLOCKS)('%s rejects a non-member with 403', async (block) => {
    await getBlock(block, MONTH, outsider).expect(403);
  });

  it('income breakdown rejects a non-member with 403', async () => {
    await getBlock('breakdown', { ...MONTH, transaction_type: 'income' }, outsider).expect(403);
  });

  it.each([
    [{ time_zone: 'UTC' }, 'period'],
    [{ period: 'quarter', time_zone: 'UTC' }, 'period'],
    [{ period: 'month' }, 'time_zone'],
    [{ period: 'month', time_zone: '+03:00' }, 'time_zone'],
    [{ period: 'month', time_zone: 'UTC', anchor_date: '2026-02-30' }, 'anchor_date'],
    [{ period: 'month', time_zone: 'UTC', as_of: '2026-09-28T12:00:00' }, 'as_of'],
    [{ period: 'month', time_zone: 'UTC', as_of: '2999-01-01T00:00:00.000Z' }, 'as_of'],
    [{ period: 'month', time_zone: 'UTC', from_date: '2026-09-01' }, 'from_date'],
    [{ period: 'custom', time_zone: 'UTC', from_date: '2026-09-01' }, 'to_date'],
    [{ period: 'month', time_zone: 'UTC', group_by: 'category' }, 'group_by'],
  ])('rejects %p on %s', async (query, field) => {
    const res = await getBlock('trend', query as Record<string, string>).expect(400);

    expect(res.body.message).toEqual(expect.arrayContaining([expect.objectContaining({ field })]));
  });

  describe('history drill-down', () => {
    const cents = (amount: string) => Math.round(Number(amount) * 100);
    const feed = (member: Member, query: Record<string, string | number>) =>
      api(member)
        .get(`${v2(member)}/transactions/feed`)
        .query({ time_zone: 'UTC', limit: 100, ...query })
        .expect(200);
    const history = async (query: Record<string, string | number>) => (await feed(owner, query)).body.items;

    interface OpenableItem {
      kind: string;
      key: string;
      id?: number;
      amount: string;
    }

    interface Breakdown {
      period: { from: string; actual_to: string };
      transaction_type: 'expense' | 'income';
      by_category: { primary_items: OpenableItem[]; other: { children: OpenableItem[] } | null };
      by_assignment: { primary_items: OpenableItem[]; other: { children: OpenableItem[] } | null };
    }

    // every item with opens_history: primary rows and the children of Other
    const openableItems = ({ by_category, by_assignment }: Breakdown): OpenableItem[] =>
      [by_category, by_assignment].flatMap((grouping) => [
        ...grouping.primary_items,
        ...(grouping.other?.children ?? []),
      ]);

    // the one template of docs/transactions-v2-contract.md#statistics-v2 for both groupings
    const drillDownQuery = ({ period, transaction_type }: Breakdown, item: OpenableItem) => ({
      from: period.from,
      to: period.actual_to,
      transaction_type,
      kind: 'regular',
      ...(item.kind === 'category' ? { category_id: item.id! } : { assignment: item.key }),
    });

    const expectHistoryToMatch = async (member: Member, breakdown: Breakdown, items: OpenableItem[]) => {
      for (const item of items) {
        const query = drillDownQuery(breakdown, item);
        const items = (await feed(member, query)).body.items;
        const count = await api(member)
          .get(`${v2(member)}/transactions/count`)
          .query(query)
          .expect(200);
        const types = [...new Set(items.map((tx: { transaction_type: string }) => tx.transaction_type))];
        const kinds = [...new Set(items.map((tx: { kind: string }) => tx.kind))];
        const sum = items.reduce((total: number, tx: { amount: string }) => total + cents(tx.amount), 0);

        expect({ query, types, kinds, sum, count: count.body.count }).toEqual({
          query,
          types: [breakdown.transaction_type],
          kinds: ['regular'],
          sum: cents(item.amount),
          count: items.length,
        });
      }
    };

    it('leaves a starting balance in the same period out of the income history of its assignment', async () => {
      const member = await createVerifiedMember(testApp, 'statistics-income-history');

      try {
        const url = base(member);
        const categories = await api(member).get(`${url}/categories`).expect(200);
        const [salary, gifts] = categories.body.incomes;
        const [housing] = categories.body.expenses;
        const card = { kind: 'space' };
        const cash = { kind: 'member', user_id: member.userId };
        const add = (assignment: object, categoryId: number, type: string, amount: string) =>
          api(member)
            .post(`${v2(member)}/transactions`)
            .send({
              assignment,
              category_id: categoryId,
              transaction_type: type,
              amount,
              timestamp: '2026-09-10T09:00:00.000Z',
            })
            .expect(201);

        await add(card, salary.id, 'income', '3000');
        await add(cash, gifts.id, 'income', '40');
        await add(card, housing.id, 'expense', '70');
        // assigned to the whole space, like Card
        await startingBalance(member, '500', new Date('2026-09-02T07:00:00.000Z'));

        for (const [transaction_type, rows] of [
          ['income', 4],
          ['expense', 2],
        ] as const) {
          const { body } = await api(member)
            .get(`${v2(member)}/statistics/breakdown`)
            .query({ ...MONTH, transaction_type })
            .expect(200);

          expect(openableItems(body)).toHaveLength(rows);
          await expectHistoryToMatch(member, body, openableItems(body));
        }

        const bounds = { from: '2026-08-31T21:00:00.000Z', to: AS_OF, transaction_type: 'income', assignment: 'space' };
        const amounts = async (query: Record<string, string | number>) => {
          const items = (await feed(member, query)).body.items;
          const count = await api(member)
            .get(`${v2(member)}/transactions/count`)
            .query(query)
            .expect(200);

          expect(count.body.count).toBe(items.length);
          return items.map((tx: { amount: string }) => tx.amount).sort();
        };

        // without kind the history keeps the starting balance
        expect(await amounts(bounds)).toEqual(['3000.00', '500.00']);
        expect(await amounts({ ...bounds, kind: 'regular' })).toEqual(['3000.00']);
        expect(await amounts({ ...bounds, kind: 'initial_balance' })).toEqual(['500.00']);
      } finally {
        await deleteUsers(testApp.dataSource, [member.userId]);
      }
    });

    it('opens every regular breakdown row with the statistics bounds and adds up to its amount', async () => {
      const { body } = await getBlock('breakdown', MONTH).expect(200);
      const items = openableItems(body);

      expect(items).toHaveLength(6);
      await expectHistoryToMatch(owner, body, items);
    });

    it('shows only the expenses of a category that also holds income, in main rows and in Other', async () => {
      const member = await createVerifiedMember(testApp, 'statistics-mixed');

      try {
        const categories = await api(member)
          .get(`${base(member)}/categories`)
          .expect(200);
        const [mixed, small] = categories.body.expenses;
        const card = { kind: 'space' };
        const cash = { kind: 'member', user_id: member.userId };
        const add = (assignment: object, categoryId: number, type: string, amount: string) =>
          api(member)
            .post(`${v2(member)}/transactions`)
            .send({
              assignment,
              category_id: categoryId,
              transaction_type: type,
              amount,
              timestamp: '2026-09-10T09:00:00.000Z',
            })
            .expect(201);

        await add(card, mixed.id, 'expense', '100');
        // a legacy income on an expense category, refused by the API since the transactions contract
        await insertLegacyTransaction(testApp.dataSource, {
          spaceId: member.spaceId,
          categoryId: mixed.id,
          type: 'income',
          amount: '20',
          timestamp: new Date('2026-09-10T09:00:00.000Z'),
        });
        // under 3%: a child of Other among the categories
        await add(cash, small.id, 'expense', '1');

        const { body } = await api(member)
          .get(`${v2(member)}/statistics/breakdown`)
          .query(MONTH)
          .expect(200);

        expect(body.by_category.primary_items).toEqual([expect.objectContaining({ id: mixed.id, amount: '100.00' })]);
        expect(body.by_category.other.children).toEqual([expect.objectContaining({ id: small.id, amount: '1.00' })]);
        // the only member group stays primary: no member reaches 3%
        expect(body.by_assignment.primary_items).toEqual([
          expect.objectContaining({ key: 'space', amount: '100.00' }),
          expect.objectContaining({ key: `member:${member.userId}`, amount: '1.00' }),
        ]);
        expect(body.by_assignment.other).toBeNull();

        const document = createOpenApiDocument(testApp.app);
        expect(schemaErrors(document, okResponseSchema(document, '/statistics/breakdown'), body)).toEqual([]);

        // without the type filter the category would also list the income
        const untyped = await feed(member, {
          from: body.period.from,
          to: body.period.actual_to,
          category_id: mixed.id,
        });
        expect(untyped.body.items).toHaveLength(2);

        await expectHistoryToMatch(member, body, openableItems(body));
      } finally {
        await deleteUsers(testApp.dataSource, [member.userId]);
      }
    });

    it('includes the last millisecond of a period on both sides', async () => {
      const july = { ...MONTH, anchor_date: '2026-07-15' };
      const summary = await getBlock('summary', july).expect(200);

      expect(summary.body.period.to).toBe('2026-07-31T20:59:59.999Z');
      expect(summary.body.expense).toEqual({ amount: '7.77', count: 1 });

      const inside = await history({ from: summary.body.period.from, to: summary.body.period.to });
      const before = await history({ from: summary.body.period.from, to: '2026-07-31T20:59:59.998Z' });

      expect(inside.map((tx: { amount: string }) => tx.amount)).toEqual(['7.77']);
      expect(before).toEqual([]);
    });

    it('filters by an archived category, only by type or by both', async () => {
      const bounds = { from: '2026-08-31T21:00:00.000Z', to: AS_OF };
      const { body } = await getBlock('breakdown', MONTH).expect(200);
      const archived = body.by_category.primary_items.find((item: { is_archived: boolean }) => item.is_archived);

      const byCategory = await history({ ...bounds, category_id: archived.id });
      // the starting balance is dated now
      const incomes = await history({ ...bounds, to: new Date().toISOString(), transaction_type: 'income' });

      expect(byCategory.map((tx: { amount: string }) => tx.amount)).toEqual(['80.00']);
      // unlike statistics, the history keeps the starting balance
      expect(incomes.map((tx: { amount: string }) => tx.amount).sort()).toEqual(['1000.00', '3000.00']);
      expect(await history({ ...bounds, category_id: archived.id, transaction_type: 'income' })).toEqual([]);
    });

    it('refuses a foreign or system category, an unknown person and a malformed filter', async () => {
      const outsiderCategories = await api(outsider)
        .get(`${base(outsider)}/categories`)
        .expect(200);
      const systemCategory = await testApp.dataSource.query(
        'SELECT id FROM categories WHERE space_id = ? AND is_system = 1',
        [owner.spaceId],
      );
      const bounds = { from: '2026-08-31T21:00:00.000Z', to: AS_OF };
      const count = (query: object) =>
        api(owner)
          .get(`${v2(owner)}/transactions/count`)
          .query({ ...bounds, ...query });

      await count({ category_id: systemCategory[0].id }).expect(403);
      await count({ category_id: outsiderCategories.body.expenses[0].id }).expect(403);
      expect((await count({ assignment: `member:${outsider.userId}` }).expect(403)).body.code).toBe('FORBIDDEN_MEMBER');

      for (const query of [
        { category_id: 'other' },
        { assignment: 'deleted_wallets' },
        { wallet_id: '7' },
        { transaction_type: 'transfer' },
        { kind: 'system' },
        { kind: '' },
      ]) {
        const res = await count(query).expect(400);

        expect(res.body.message).toEqual([expect.objectContaining({ field: Object.keys(query)[0] })]);
      }

      for (const path of [`transactions/feed?time_zone=UTC&`, 'transactions/count?']) {
        const res = await api(owner)
          .get(`${v2(owner)}/${path}from=${bounds.from}&to=${AS_OF}&kind=regular&kind=initial_balance`)
          .expect(400);

        // field is "kind" in the tsc build; under @swc/jest the enum becomes the
        // param metatype and the global ValidationPipe reports the array items
        expect(res.body.message).toEqual(
          expect.arrayContaining([expect.objectContaining({ field: expect.any(String) })]),
        );
      }
    });
  });

  it.each([
    ['a current month', MONTH],
    ['a past month', { ...MONTH, anchor_date: '2026-08-15' }],
    ['a future month', { ...MONTH, anchor_date: '2026-10-15' }],
    ['a custom range', { ...MONTH, period: 'custom', from_date: '2026-09-01', to_date: '2026-09-30' }],
    ['a year', { ...MONTH, period: 'year' }],
  ])('responds to %s exactly as the OpenAPI schemas describe', async (_, query) => {
    const document = createOpenApiDocument(testApp.app);

    for (const block of BLOCKS) {
      const res = await getBlock(block, query).expect(200);
      const errors = schemaErrors(document, okResponseSchema(document, `/statistics/${block}`), res.body);

      expect({ block, errors }).toEqual({ block, errors: [] });
    }

    const income = await getBlock('breakdown', { ...query, transaction_type: 'income' }).expect(200);
    expect(schemaErrors(document, okResponseSchema(document, '/statistics/breakdown'), income.body)).toEqual([]);
  });

  it('the contract check accepts an allowed null and rejects a wrong or incomplete one', async () => {
    const document = createOpenApiDocument(testApp.app);
    const summarySchema = okResponseSchema(document, '/statistics/summary');
    const breakdownSchema = okResponseSchema(document, '/statistics/breakdown');
    const summary = (await getBlock('summary', MONTH).expect(200)).body;
    const breakdown = (await getBlock('breakdown', MONTH).expect(200)).body;
    const check = (schema: typeof summarySchema, body: Record<string, unknown>) => schemaErrors(document, schema, body);

    expect(summary.previous).not.toBeNull();
    expect(breakdown.by_category.other).toBeNull();

    expect(check(summarySchema, { ...summary, previous: null, change: null })).toEqual([]);
    expect(
      check(breakdownSchema, {
        ...breakdown,
        by_assignment: {
          ...breakdown.by_assignment,
          other: { kind: 'other', key: 'other', amount: '0.00', percent: 0, opens_history: false, children: [] },
        },
      }),
    ).toEqual([]);

    expect(check(summarySchema, { ...summary, period: null })).toContain('$.period: null is not allowed');
    expect(check(summarySchema, { ...summary, income: null })).toContain('$.income: null is not allowed');

    expect(check(summarySchema, { ...summary, previous: {} })).toEqual(
      expect.arrayContaining(['$.previous: matches no anyOf branch', '$.previous.actual_to: missing']),
    );
    expect(
      check(breakdownSchema, {
        ...breakdown,
        by_assignment: { ...breakdown.by_assignment, other: { kind: 'other' } },
      }),
    ).toContain('$.by_assignment.other: matches no anyOf branch');
    expect(check(summarySchema, { ...summary, previous: { ...summary.previous, income: null } })).toContain(
      '$.previous: matches no anyOf branch',
    );
  });

  it('breakdown without transaction_type is the expense breakdown', async () => {
    const [byDefault, expense] = await Promise.all([
      getBlock('breakdown', MONTH).expect(200),
      getBlock('breakdown', { ...MONTH, transaction_type: 'expense' }).expect(200),
    ]);

    expect(byDefault.body.transaction_type).toBe('expense');
    expect(byDefault.body).toEqual(expense.body);
  });

  it.each([
    ['transaction_type=transfer', 'an unknown'],
    ['transaction_type=', 'an empty'],
    ['transaction_type=income&transaction_type=expense', 'a repeated'],
  ])('breakdown rejects %s (%s transaction_type)', async (param) => {
    const res = await api(owner)
      .get(`${v2(owner)}/statistics/breakdown?period=month&time_zone=UTC&${param}`)
      .expect(400);

    expect(res.body.message).toEqual([expect.objectContaining({ field: 'transaction_type' })]);
  });

  it.each(['summary', 'trend'] as const)('%s does not take transaction_type', async (block) => {
    const res = await getBlock(block, { ...MONTH, transaction_type: 'expense' }).expect(400);

    expect(res.body.message).toEqual([expect.objectContaining({ field: 'transaction_type' })]);
  });

  it('rejects a repeated parameter', async () => {
    const res = await api(owner)
      .get(`${v2(owner)}/statistics/summary?period=month&period=week&time_zone=UTC`)
      .expect(400);

    expect(res.body.message).toEqual([expect.objectContaining({ field: 'period' })]);
  });
});
