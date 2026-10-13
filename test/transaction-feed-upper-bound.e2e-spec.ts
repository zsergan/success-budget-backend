import request from 'supertest';
import { getRepositoryToken } from '@nestjs/typeorm';
import type { Repository } from 'typeorm';

import { Transaction } from '@entities/transaction.entity';
import { TransactionType } from '@shared/enums';
import { type Member, type TestApp, createTestApp, createVerifiedMember, deleteUsers } from './support/app';

interface FeedBody {
  items: { id: string; timestamp: string }[];
  page_info: { next_cursor: string | null; previous_cursor: string | null };
  summary: { count: number; income: string; expense: string };
  day_totals: { date: string; net: string }[];
}

// TIMESTAMP(3) holds up to 2038-01-19T03:14:07.999Z, while a write stops at
// 03:14:07.000Z; records stored past it before that rule stay readable.
// They are inserted directly, as the API refuses them now.
describe('Transactions feed at the last stored second (e2e)', () => {
  let testApp: TestApp;
  let owner: Member;
  const ids: Record<string, string> = {};
  // newest first: timestamp, then id, descending
  let history: string[];

  const january = { from: '2038-01-01T00:00:00.000Z', to: '2038-01-31T23:59:59.999Z' };

  const get = (url: string) =>
    request(testApp.app.getHttpServer()).get(url).set('Authorization', `Bearer ${owner.token}`);
  const base = () => `/api/v1/spaces/${owner.spaceId}/transactions`;
  const query = (params: Record<string, string | number>) => new URLSearchParams(params as never).toString();
  const feed = async (params: Record<string, string | number>): Promise<FeedBody> =>
    (await get(`${base()}/feed?${query({ time_zone: 'UTC', ...params })}`).expect(200)).body;
  const count = async (params: Record<string, string | number>): Promise<number> =>
    (await get(`${base()}/count?${query(params)}`).expect(200)).body.count;
  const itemIds = (body: FeedBody) => body.items.map((item) => item.id);

  async function walk(params: Record<string, string | number>, limit: number): Promise<string[]> {
    const seen: string[] = [];
    let page = await feed({ ...params, limit });
    seen.push(...itemIds(page));

    while (page.page_info.next_cursor) {
      expect(page.summary.count).toBe(history.length);
      page = await feed({ ...params, limit, cursor: page.page_info.next_cursor });
      seen.push(...itemIds(page));
    }

    return seen;
  }

  beforeAll(async () => {
    testApp = await createTestApp();
    owner = await createVerifiedMember(testApp, 'feed-upper-bound');
    const wallet = await request(testApp.app.getHttpServer())
      .post(`/api/v1/spaces/${owner.spaceId}/wallets`)
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ wallet_name: 'Card', initial_balance: '0', design: 'slate' })
      .expect(201);
    const categories = await get(`/api/v1/spaces/${owner.spaceId}/categories`).expect(200);
    const transactions = testApp.app.get<Repository<Transaction>>(getRepositoryToken(Transaction));

    const add = async (key: string, timestamp: string, type: TransactionType, amount: string) => {
      const saved = await transactions.save(
        transactions.create({
          wallet_id: wallet.body.wallet.id,
          category_id: (type === TransactionType.INCOME ? categories.body.incomes : categories.body.expenses)[0].id,
          transaction_type: type,
          amount,
          timestamp: new Date(timestamp),
          description: `edge ${key}`,
        }),
      );
      ids[key] = saved.id;
    };

    await add('dayBefore', '2038-01-18T12:00:00.000Z', TransactionType.EXPENSE, '32.00');
    await add('before', '2038-01-19T03:14:06.500Z', TransactionType.EXPENSE, '1.00');
    await add('writeLimit', '2038-01-19T03:14:07.000Z', TransactionType.EXPENSE, '2.00');
    await add('legacy', '2038-01-19T03:14:07.001Z', TransactionType.EXPENSE, '4.00');
    await add('last', '2038-01-19T03:14:07.999Z', TransactionType.INCOME, '8.00');
    await add('lastTie', '2038-01-19T03:14:07.999Z', TransactionType.EXPENSE, '16.00');

    history = [...[ids.last, ids.lastTie].sort().reverse(), ids.legacy, ids.writeLimit, ids.before, ids.dayBefore];
  });

  afterAll(async () => {
    try {
      await deleteUsers(testApp.dataSource, [owner?.userId].filter(Boolean));
    } finally {
      await testApp.app.close();
    }
  });

  it('stores the records to the millisecond and shows them in the details', async () => {
    for (const [key, timestamp] of [
      ['legacy', '2038-01-19T03:14:07.001Z'],
      ['last', '2038-01-19T03:14:07.999Z'],
    ]) {
      const res = await get(`${base()}/${ids[key]}`).expect(200);

      expect(res.body.timestamp).toBe(timestamp);
    }
  });

  describe('list', () => {
    it('lists every record of the last stored second in the month', async () => {
      const page = await feed(january);

      expect(itemIds(page)).toEqual(history);
      expect(page.page_info).toEqual({ next_cursor: null, previous_cursor: null });
    });

    it('lists them on the home screen, which reads the whole stored range', async () => {
      const latest = await get(`${base()}/latest`).expect(200);
      const home = await feed({ from: '1970-01-01T00:00:01.000Z', to: '2038-01-19T03:14:07.999Z', limit: 5 });

      expect(itemIds(home)).toEqual(history.slice(0, 5));
      expect(home.items[0].id).toBe(latest.body.id);
    });

    it('keeps the bounds of a period to the millisecond', async () => {
      expect(itemIds(await feed({ from: january.from, to: '2038-01-19T03:14:07.000Z' }))).toEqual(history.slice(3));
      expect(itemIds(await feed({ from: '2038-01-19T03:14:07.001Z', to: january.to }))).toEqual(history.slice(0, 3));
      expect(itemIds(await feed({ from: '2038-01-19T03:14:07.999Z', to: '2038-01-19T03:14:07.999Z' }))).toEqual(
        history.slice(0, 2),
      );
      expect(itemIds(await feed({ from: '2038-01-19T03:14:08.000Z', to: '2100-01-01T00:00:00.000Z' }))).toEqual([]);
    });

    it('filters them by type', async () => {
      expect(itemIds(await feed({ ...january, transaction_type: 'income' }))).toEqual([ids.last]);
      expect(itemIds(await feed({ ...january, transaction_type: 'expense' }))).toEqual(
        history.filter((id) => id !== ids.last),
      );
    });
  });

  describe('search', () => {
    it.each([
      ['edge legacy', ['legacy']],
      ['edge last', ['last', 'lastTie']],
      ['edge', ['last', 'lastTie', 'legacy', 'writeLimit', 'before', 'dayBefore']],
    ])('finds %p', async (q, keys) => {
      const page = await feed({ ...january, q });
      const expected = history.filter((id) => keys.some((key) => ids[key] === id));

      expect(itemIds(page)).toEqual(expected);
      expect(page.summary.count).toBe(expected.length);
      expect(await count({ ...january, q })).toBe(expected.length);
    });
  });

  describe('count', () => {
    it.each([
      ['the month', january, 6],
      ['the whole stored range', { from: '1970-01-01T00:00:01.000Z', to: '2038-01-19T03:14:07.999Z' }, 6],
      ['beyond the stored range', { from: '1000-01-01T00:00:00.000Z', to: '9999-12-31T23:59:59.999Z' }, 6],
      ['up to the write limit', { from: january.from, to: '2038-01-19T03:14:07.000Z' }, 3],
      ['after the write limit', { from: '2038-01-19T03:14:07.001Z', to: '2100-01-01T00:00:00.000Z' }, 3],
      ['after the last stored millisecond', { from: '2038-01-19T03:14:08.000Z', to: '2100-01-01T00:00:00.000Z' }, 0],
    ])('counts %s like the feed', async (_, period, expected) => {
      expect(await count(period)).toBe(expected);
      expect((await feed(period)).summary.count).toBe(expected);
    });
  });

  describe('totals', () => {
    it('sums the whole month, the last stored second included', async () => {
      expect((await feed(january)).summary).toEqual({ count: 6, income: '8.00', expense: '55.00' });
    });

    it.each([
      [
        'UTC',
        [
          { date: '2038-01-19', net: '-15.00' },
          { date: '2038-01-18', net: '-32.00' },
        ],
      ],
      // the evening of January 18 in New York runs past the last stored millisecond
      ['America/New_York', [{ date: '2038-01-18', net: '-47.00' }]],
    ])('nets each day in %s, the last stored second included', async (timeZone, days) => {
      expect((await feed({ ...january, time_zone: timeZone })).day_totals).toEqual(days);
    });

    it('keeps the day total of a page whose day continues on the next page', async () => {
      const first = await feed({ ...january, limit: 2 });

      expect(first.day_totals).toEqual([{ date: '2038-01-19', net: '-15.00' }]);
    });
  });

  describe('pages', () => {
    it.each([1, 2, 3, 4, 6])('walks the month in pages of %p, each record once', async (limit) => {
      const seen = await walk(january, limit);

      expect(new Set(seen).size).toBe(seen.length);
      expect(seen).toEqual(history);
    });

    it('walks back from the oldest page with previous_cursor', async () => {
      let page = await feed({ ...january, limit: 1 });
      while (page.page_info.next_cursor) {
        page = await feed({ ...january, limit: 1, cursor: page.page_info.next_cursor });
      }

      const seen = [...itemIds(page)];
      while (page.page_info.previous_cursor) {
        page = await feed({ ...january, limit: 1, cursor: page.page_info.previous_cursor });
        seen.unshift(...itemIds(page));
      }

      expect(seen).toEqual(history);
    });

    it.each(['legacy', 'last', 'lastTie'])('opens the history around %s and pages on from it', async (key) => {
      const page = await feed({ ...january, limit: 3, around_id: ids[key] });

      expect(itemIds(page)).toContain(ids[key]);

      const newer = page.page_info.previous_cursor
        ? itemIds(await feed({ ...january, limit: 6, cursor: page.page_info.previous_cursor }))
        : [];
      const older = page.page_info.next_cursor
        ? itemIds(await feed({ ...january, limit: 6, cursor: page.page_info.next_cursor }))
        : [];

      expect([...newer, ...itemIds(page), ...older]).toEqual(history);
    });
  });
});
