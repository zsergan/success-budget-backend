import request from 'supertest';

import { TransactionQueriesService } from '@modules/transaction-queries/transaction-queries.service';

import { type Member, type TestApp, createTestApp, createVerifiedMember, deleteUsers } from './support/app';

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
    const [housing, transport, grocery] = categories.body.expenses;

    const card = await createWallet('Card', '0');
    const cash = await createWallet('Cash', '0');
    const oldCard = await createWallet('Old card', '0');
    // its starting balance is income on the system category, never statistics
    await createWallet('Savings', '1000');

    const add = (walletId: number, categoryId: number, type: string, amount: string, timestamp: string) =>
      api(owner)
        .post(`${base(owner)}/transactions`)
        .send({ wallet_id: walletId, category_id: categoryId, transaction_type: type, amount, timestamp })
        .expect(201);

    await add(card, salary.id, 'income', '3000', '2026-09-01T07:00:00.000Z');
    await add(card, housing.id, 'expense', '450.25', '2026-09-02T16:30:00.000Z');
    await add(cash, transport.id, 'expense', '120', '2026-09-05T10:00:00.000Z');
    await add(oldCard, grocery.id, 'expense', '80', '2026-09-12T17:00:00.000Z');
    await add(card, transport.id, 'expense', '0', '2026-09-21T06:00:00.000Z');
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
    const neighbourWallet = await api(neighbour)
      .post(`${base(neighbour)}/wallets`)
      .send({ wallet_name: 'Neighbour card', initial_balance: '0', design: 'slate' })
      .expect(201);
    await api(neighbour)
      .post(`${base(neighbour)}/transactions`)
      .send({
        wallet_id: neighbourWallet.body.wallet.id,
        category_id: neighbourCategories.body.expenses[0].id,
        transaction_type: 'expense',
        amount: '999',
        timestamp: '2026-09-10T09:00:00.000Z',
      })
      .expect(201);

    await api(owner)
      .delete(`${base(owner)}/categories/${grocery.id}`)
      .expect(200);
    await api(owner)
      .delete(`${base(owner)}/wallets/${oldCard}`)
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

  function api(member: Member) {
    const agent = request(testApp.app.getHttpServer());
    const withAuth =
      (method: 'get' | 'post' | 'delete') =>
      (url: string): request.Test =>
        agent[method](url).set('Authorization', `Bearer ${member.token}`);

    return { get: withAuth('get'), post: withAuth('post'), delete: withAuth('delete') };
  }

  async function createWallet(name: string, initialBalance: string): Promise<number> {
    const res = await api(owner)
      .post(`${base(owner)}/wallets`)
      .send({ wallet_name: name, initial_balance: initialBalance, design: 'slate' })
      .expect(201);

    return res.body.wallet.id;
  }

  function getBlock(block: (typeof BLOCKS)[number], query: Record<string, string>, member = owner) {
    return api(member)
      .get(`${base(owner)}/statistics/${block}`)
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
      // deleted wallet, archived category and a zero amount included; after as_of excluded
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
      .get(`${base(outsider)}/statistics/summary`)
      .query(MONTH)
      .expect(200);

    expect(res.body).toMatchObject({ transactions_count: 0, has_any_transactions: false, last_transaction_date: null });
  });

  it('breakdown groups expenses by category and by wallet in SQL', async () => {
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
      { kind: 'category', name: 'Grocery', amount: '80.00', percent: 12.1, is_archived: true, opens_history: true },
    ]);
    expect(res.body.by_category.primary_items[0]).toMatchObject({
      key: `category:${res.body.by_category.primary_items[0].id}`,
      icon: expect.any(String),
      color: expect.any(String),
    });

    expect(res.body.by_wallet).toMatchObject({ total_amount: '660.25', source_count: 3, other: null });
    expect(brief(res.body.by_wallet.primary_items)).toEqual([
      { kind: 'wallet', name: 'Card', amount: '450.25', percent: 68.2, is_archived: false, opens_history: true },
      { kind: 'wallet', name: 'Cash', amount: '130.00', percent: 19.7, is_archived: false, opens_history: true },
    ]);
    expect(res.body.by_wallet.deleted_wallets).toMatchObject({
      kind: 'deleted_wallets',
      key: 'deleted_wallets',
      id: null,
      amount: '80.00',
      percent: 12.1,
      opens_history: false,
      wallets_count: 1,
    });
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
        .get(`${base(neighbour)}/statistics/breakdown`)
        .query(MONTH)
        .expect(200),
    ]);

    expect(own.body.total).toEqual({ amount: '660.25', count: 5 });
    expect(other.body.total).toEqual({ amount: '999.00', count: 1 });
    expect(other.body.by_wallet.primary_items.map((item: { name: string }) => item.name)).toEqual(['Neighbour card']);
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
    const { by_category: byCategory, by_wallet: byWallet } = breakdown.body;

    expect(bucketSum('income')).toBe(cents(summary.body.income.amount));
    expect(bucketSum('expense')).toBe(cents(summary.body.expense.amount));
    expect(groupSum([...byCategory.primary_items, ...(byCategory.other ? [byCategory.other] : [])])).toBe(
      cents(summary.body.expense.amount),
    );
    expect(
      groupSum([
        ...byWallet.primary_items,
        ...(byWallet.deleted_wallets ? [byWallet.deleted_wallets] : []),
        ...(byWallet.other ? [byWallet.other] : []),
      ]),
    ).toBe(cents(summary.body.expense.amount));
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
    const history = (query: Record<string, string | number>) =>
      api(owner)
        .get(`${base(owner)}/transactions`)
        .query(query)
        .expect(200);

    it('opens every regular breakdown row with the statistics bounds and adds up to its amount', async () => {
      const { body } = await getBlock('breakdown', MONTH).expect(200);
      const bounds = { from: body.period.from, to: body.period.actual_to };
      const rows = [
        ...body.by_category.primary_items.map((item: { id: number; amount: string }) => ({
          item,
          query: { ...bounds, category_id: item.id },
        })),
        ...body.by_wallet.primary_items.map((item: { id: number; amount: string }) => ({
          item,
          query: { ...bounds, wallet_id: item.id, transaction_type: 'expense' },
        })),
      ];

      expect(rows).toHaveLength(5);

      for (const { item, query } of rows) {
        const res = await history(query);
        const sum = res.body.reduce((total: number, tx: { amount: string }) => total + cents(tx.amount), 0);

        expect({ query, sum }).toEqual({ query, sum: cents(item.amount) });
      }
    });

    it('includes the last millisecond of a period on both sides', async () => {
      const july = { ...MONTH, anchor_date: '2026-07-15' };
      const summary = await getBlock('summary', july).expect(200);

      expect(summary.body.period.to).toBe('2026-07-31T20:59:59.999Z');
      expect(summary.body.expense).toEqual({ amount: '7.77', count: 1 });

      const inside = await history({ from: summary.body.period.from, to: summary.body.period.to });
      const before = await history({ from: summary.body.period.from, to: '2026-07-31T20:59:59.998Z' });

      expect(inside.body.map((tx: { amount: string }) => tx.amount)).toEqual(['7.77']);
      expect(before.body).toEqual([]);
    });

    it('filters by an archived category, only by type or by both', async () => {
      const bounds = { from: '2026-08-31T21:00:00.000Z', to: AS_OF };
      const { body } = await getBlock('breakdown', MONTH).expect(200);
      const archived = body.by_category.primary_items.find((item: { is_archived: boolean }) => item.is_archived);

      const byCategory = await history({ ...bounds, category_id: archived.id });
      // the starting balance is dated when the wallet was created, i.e. now
      const incomes = await history({ ...bounds, to: new Date().toISOString(), transaction_type: 'income' });

      expect(byCategory.body.map((tx: { amount: string }) => tx.amount)).toEqual(['80.00']);
      // unlike statistics, the history keeps the starting balance
      expect(incomes.body.map((tx: { amount: string }) => tx.amount).sort()).toEqual(['1000.00', '3000.00']);
      await history({ ...bounds, category_id: archived.id, transaction_type: 'income' }).then((res) =>
        expect(res.body).toEqual([]),
      );
    });

    it('refuses a deleted, foreign or system resource and a malformed filter', async () => {
      const outsiderCategories = await api(outsider)
        .get(`${base(outsider)}/categories`)
        .expect(200);
      const { body } = await getBlock('breakdown', MONTH).expect(200);
      const deletedWallet = await testApp.dataSource.query(
        'SELECT id FROM wallets WHERE space_id = ? AND is_deleted = 1',
        [owner.spaceId],
      );
      const systemCategory = await testApp.dataSource.query(
        'SELECT id FROM categories WHERE space_id = ? AND is_system = 1',
        [owner.spaceId],
      );

      expect(body.by_wallet.deleted_wallets.opens_history).toBe(false);
      await api(owner)
        .get(`${base(owner)}/transactions`)
        .query({ wallet_id: deletedWallet[0].id })
        .expect(403);
      await api(owner)
        .get(`${base(owner)}/transactions`)
        .query({ category_id: systemCategory[0].id })
        .expect(403);
      await api(owner)
        .get(`${base(owner)}/transactions`)
        .query({ category_id: outsiderCategories.body.expenses[0].id })
        .expect(403);

      for (const query of [{ category_id: 'other' }, { wallet_id: '0' }, { transaction_type: 'transfer' }]) {
        const res = await api(owner)
          .get(`${base(owner)}/transactions`)
          .query(query)
          .expect(400);

        expect(res.body.message).toEqual([expect.objectContaining({ field: Object.keys(query)[0] })]);
      }
    });
  });

  describe('a write between the reads of one block', () => {
    let writer: Member;
    let walletId: number;
    let categoryId: number;
    let queries: TransactionQueriesService;

    const addExpense = async (amount: string): Promise<string> => {
      const res = await api(writer)
        .post(`${base(writer)}/transactions`)
        .send({
          wallet_id: walletId,
          category_id: categoryId,
          transaction_type: 'expense',
          amount,
          timestamp: '2026-09-20T10:00:00.000Z',
        })
        .expect(201);

      return res.body.transaction.id;
    };

    const getOwnBlock = (block: 'summary' | 'breakdown') =>
      api(writer)
        .get(`${base(writer)}/statistics/${block}`)
        .query(MONTH)
        .expect(200);

    // runs `write` right after the first call of the read, as a concurrent client would
    const writeAfter = <K extends keyof TransactionQueriesService>(method: K, write: () => Promise<unknown>) => {
      const original = (queries[method] as (...args: unknown[]) => Promise<unknown>).bind(queries);

      return jest.spyOn(queries, method).mockImplementationOnce((async (...args: unknown[]) => {
        const result = await original(...args);
        await write();

        return result;
      }) as never);
    };

    beforeAll(async () => {
      writer = await createVerifiedMember(testApp, 'statistics-writer');
      queries = testApp.app.get(TransactionQueriesService);

      const categories = await api(writer)
        .get(`${base(writer)}/categories`)
        .expect(200);
      categoryId = categories.body.expenses[0].id;

      const wallet = await api(writer)
        .post(`${base(writer)}/wallets`)
        .send({ wallet_name: 'Card', initial_balance: '0', design: 'slate' })
        .expect(201);
      walletId = wallet.body.wallet.id;
    });

    afterEach(() => {
      jest.restoreAllMocks();
    });

    afterAll(async () => {
      await deleteUsers(testApp.dataSource, [writer?.userId].filter(Boolean));
    });

    it('breakdown: categories, wallets and total come from one snapshot', async () => {
      await addExpense('100');
      const spy = writeAfter('getStatisticsExpenseByCategory', () => addExpense('50'));

      const res = await getOwnBlock('breakdown');

      expect(spy).toHaveBeenCalled();
      expect(res.body.total.amount).toBe('100.00');
      expect(res.body.by_category.total_amount).toBe('100.00');
      expect(res.body.by_wallet.total_amount).toBe('100.00');

      const next = await getOwnBlock('breakdown');
      expect(next.body.by_wallet.total_amount).toBe('150.00');
    });

    it('summary: totals and the presence of transactions come from one snapshot', async () => {
      const transactions = await api(writer)
        .get(`${base(writer)}/transactions`)
        .query({ from: '2026-09-01T00:00:00.000Z', to: AS_OF })
        .expect(200);
      const removeAll = () =>
        Promise.all(
          transactions.body.map((transaction: { id: string }) =>
            api(writer)
              .delete(`${base(writer)}/transactions/${transaction.id}`)
              .expect(200),
          ),
        );
      const spy = writeAfter('getStatisticsTotals', removeAll);

      const res = await getOwnBlock('summary');

      expect(spy).toHaveBeenCalled();
      expect(res.body).toMatchObject({
        expense: { amount: '150.00', count: 2 },
        has_any_transactions: true,
        last_transaction_date: '2026-09-20',
      });

      const next = await getOwnBlock('summary');
      expect(next.body).toMatchObject({ expense: { amount: '0.00', count: 0 }, has_any_transactions: false });
    });
  });

  it('rejects a repeated parameter', async () => {
    const res = await api(owner)
      .get(`${base(owner)}/statistics/summary?period=month&period=week&time_zone=UTC`)
      .expect(400);

    expect(res.body.message).toEqual([expect.objectContaining({ field: 'period' })]);
  });
});
