import request from 'supertest';

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

  beforeAll(async () => {
    testApp = await createTestApp();
    owner = await createVerifiedMember(testApp, 'statistics-owner');
    outsider = await createVerifiedMember(testApp, 'statistics-outsider');

    const categories = await api(owner)
      .get(`${base(owner)}/categories`)
      .expect(200);
    const [salary] = categories.body.incomes;
    const [groceries, restaurants, gifts] = categories.body.expenses;

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
    await add(card, groceries.id, 'expense', '450.25', '2026-09-02T16:30:00.000Z');
    await add(cash, restaurants.id, 'expense', '120', '2026-09-05T10:00:00.000Z');
    await add(oldCard, gifts.id, 'expense', '80', '2026-09-12T17:00:00.000Z');
    await add(card, restaurants.id, 'expense', '0', '2026-09-21T06:00:00.000Z');
    // 00:30 on Sep 28 in Moscow, still Sep 27 in UTC
    await add(cash, groceries.id, 'expense', '10', '2026-09-27T21:30:00.000Z');
    // after as_of
    await add(card, groceries.id, 'expense', '500', '2026-09-29T07:00:00.000Z');
    // August, the month before
    await add(card, groceries.id, 'expense', '200', '2026-08-10T09:00:00.000Z');

    await api(owner)
      .delete(`${base(owner)}/categories/${gifts.id}`)
      .expect(200);
    await api(owner)
      .delete(`${base(owner)}/wallets/${oldCard}`)
      .expect(200);
  });

  afterAll(async () => {
    try {
      await deleteUsers(testApp.dataSource, [owner?.userId, outsider?.userId].filter(Boolean));
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

  it('trend and breakdown carry control sums equal to the summary', async () => {
    const [summary, trend, breakdown] = await Promise.all(BLOCKS.map((block) => getBlock(block, MONTH).expect(200)));

    expect(trend.body.period).toEqual(summary.body.period);
    expect(breakdown.body.period).toEqual(summary.body.period);
    expect(trend.body.totals).toEqual({ income: summary.body.income, expense: summary.body.expense });
    expect(breakdown.body.total).toEqual(summary.body.expense);
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

  it('rejects a repeated parameter', async () => {
    const res = await api(owner)
      .get(`${base(owner)}/statistics/summary?period=month&period=week&time_zone=UTC`)
      .expect(400);

    expect(res.body.message).toEqual([expect.objectContaining({ field: 'period' })]);
  });
});
