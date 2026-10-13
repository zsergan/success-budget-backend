import { DateTime } from 'luxon';
import request from 'supertest';
import { getRepositoryToken } from '@nestjs/typeorm';
import type { OpenAPIObject } from '@nestjs/swagger';
import type { Repository } from 'typeorm';

import { Category } from '@entities/category.entity';
import { Transaction } from '@entities/transaction.entity';
import { Wallet } from '@entities/wallet.entity';
import { AppColor, CategoryIcon, TransactionType } from '@shared/enums';
import { type Member, type TestApp, createTestApp, createVerifiedMember, deleteUsers } from './support/app';
import { createOpenApiDocument, okResponseSchema, schemaErrors } from './support/openapi';

interface FeedItem {
  id: string;
  kind: 'regular' | 'initial_balance';
  transaction_type: 'income' | 'expense';
  amount: string;
  timestamp: string;
  wallet: { id: number } | null;
}

interface FeedBody {
  items: FeedItem[];
  page_info: { next_cursor: string | null; previous_cursor: string | null };
  summary: { count: number; income: string; expense: string };
  day_totals: { date: string; net: string }[];
}

interface ControlRow {
  id: string;
  timestamp: Date;
  type: TransactionType;
  cents: bigint;
  system: boolean;
  categoryId: number;
  walletId: number;
  texts: (string | null)[];
}

interface FeedQuery {
  from: string;
  to: string;
  time_zone: string;
  q?: string;
  transaction_type?: TransactionType;
  kind?: 'regular' | 'initial_balance';
  category_id?: number;
  wallet_id?: number;
}

const fold = (text: string) => text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

const money = (cents: bigint) => {
  const sign = cents < 0n ? '-' : '';
  const digits = (cents < 0n ? -cents : cents).toString().padStart(3, '0');

  return `${sign}${digits.slice(0, -2)}.${digits.slice(-2)}`;
};

// The feed checked against a control selection built here, in plain code,
// from every row of the space: rows, order, totals and day totals.
describe('Transactions feed against a control selection (e2e)', () => {
  let testApp: TestApp;
  let owner: Member;
  let outsider: Member;
  let document: OpenAPIObject;
  let card: Wallet;
  let cash: Wallet;
  let coffee: Category;
  let salary: Category;
  let archived: Category;
  let foreignCategoryId: number;
  let control: ControlRow[];

  const query = (params: object) =>
    Object.entries(params)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => `${key}=${encodeURIComponent(String(value))}`)
      .join('&');

  const get = async (member: Member, path: string, params: object) => {
    testApp.resetThrottling();

    return request(testApp.app.getHttpServer())
      .get(`/api/v1/spaces/${owner.spaceId}/transactions${path}?${query(params)}`)
      .set('Authorization', `Bearer ${member.token}`);
  };

  const feed = async (params: object): Promise<FeedBody> => {
    const res = await get(owner, '/feed', params);

    expect(res.status).toBe(200);
    expect(schemaErrors(document, okResponseSchema(document, '/transactions/feed'), res.body)).toEqual([]);

    return res.body;
  };

  const expected = (q: FeedQuery) => {
    const from = new Date(q.from).getTime();
    const to = new Date(q.to).getTime();
    const search = q.q?.trim() ? fold(q.q.trim()) : undefined;

    return control
      .filter(
        (row) =>
          row.timestamp.getTime() >= from &&
          row.timestamp.getTime() <= to &&
          (!q.transaction_type || row.type === q.transaction_type) &&
          (!q.kind || row.system === (q.kind === 'initial_balance')) &&
          (!q.category_id || row.categoryId === q.category_id) &&
          (!q.wallet_id || row.walletId === q.wallet_id) &&
          (!search || row.texts.some((text) => text !== null && fold(text).includes(search))),
      )
      .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime() || (a.id < b.id ? 1 : -1));
  };

  const localDay = (timestamp: Date, zone: string) => DateTime.fromJSDate(timestamp, { zone }).toISODate()!;

  const expectedSummary = (rows: ControlRow[]) => ({
    count: rows.length,
    income: money(rows.filter((r) => !r.system && r.type === 'income').reduce((sum, r) => sum + r.cents, 0n)),
    expense: money(rows.filter((r) => !r.system && r.type === 'expense').reduce((sum, r) => sum + r.cents, 0n)),
  });

  const expectedNet = (rows: ControlRow[], date: string, zone: string) =>
    money(
      rows
        .filter((r) => !r.system && localDay(r.timestamp, zone) === date)
        .reduce((sum, r) => sum + (r.type === 'income' ? r.cents : -r.cents), 0n),
    );

  // Every page of the query, oldest-ward from the first one.
  const walkForward = async (q: FeedQuery, limit: number) => {
    const pages = [await feed({ ...q, limit })];

    while (pages[pages.length - 1].page_info.next_cursor) {
      pages.push(await feed({ ...q, limit, cursor: pages[pages.length - 1].page_info.next_cursor }));
    }

    return pages;
  };

  const checkAgainstControl = (q: FeedQuery, pages: FeedBody[]) => {
    const rows = expected(q);
    const ids = pages.flatMap((page) => page.items.map((item) => item.id));

    expect(ids).toEqual(rows.map((row) => row.id));
    expect(new Set(ids).size).toBe(ids.length);

    for (const page of pages) {
      expect(page.summary).toEqual(expectedSummary(rows));

      const pageDays = [...new Set(page.items.map((item) => localDay(new Date(item.timestamp), q.time_zone)))];
      expect(page.day_totals).toEqual(pageDays.map((date) => ({ date, net: expectedNet(rows, date, q.time_zone) })));
    }
  };

  beforeAll(async () => {
    testApp = await createTestApp();
    document = createOpenApiDocument(testApp.app);
    owner = await createVerifiedMember(testApp, 'feed-contract-owner');
    outsider = await createVerifiedMember(testApp, 'feed-contract-outsider');

    const wallets = testApp.app.get<Repository<Wallet>>(getRepositoryToken(Wallet));
    const categories = testApp.app.get<Repository<Category>>(getRepositoryToken(Category));
    const transactions = testApp.app.get<Repository<Transaction>>(getRepositoryToken(Transaction));

    const category = (spaceId: number, name: string, transaction_type: TransactionType) =>
      categories.save(
        categories.create({
          space_id: spaceId,
          name,
          transaction_type,
          icon: CategoryIcon.OTHER,
          color: AppColor.SLATE,
          is_active: 1,
          sort: 0,
        }),
      );

    card = await wallets.save(wallets.create({ space_id: owner.spaceId, wallet_name: 'Card', design: AppColor.SLATE }));
    cash = await wallets.save(
      wallets.create({ space_id: owner.spaceId, wallet_name: 'Наличные', design: AppColor.SLATE }),
    );
    coffee = await category(owner.spaceId, 'Кофе', TransactionType.EXPENSE);
    salary = await category(owner.spaceId, 'Salary', TransactionType.INCOME);
    archived = await category(owner.spaceId, 'Old 50%_off', TransactionType.EXPENSE);
    foreignCategoryId = (await category(outsider.spaceId, 'Foreign', TransactionType.EXPENSE)).id;
    const system = await categories.findOneByOrFail({ space_id: owner.spaceId, is_system: 1 });

    const descriptions = ['Кофе с собой', 'кофе', 'CAFÉ crème', '100% refund', 'a_b test', null, 'Lunch', 'ёлка'];
    const instants = ['2026-03-28T23:30:00.000Z', '2026-03-29T12:00:00.000Z', '2026-04-01T00:00:00.000Z'];
    let seed = 7;
    const random = () => {
      seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31;

      return seed / 2 ** 31;
    };

    const rows: Partial<Transaction>[] = [
      {
        wallet_id: card.id,
        category_id: system.id,
        transaction_type: TransactionType.INCOME,
        amount: '100.00',
        timestamp: new Date('2026-03-25T00:00:00.000Z'),
        description: null,
      },
    ];

    for (let i = 0; i < 240; i++) {
      const categoryOf = [coffee, coffee, salary, archived][Math.floor(random() * 4)];
      const timestamp =
        random() < 0.3
          ? new Date(instants[Math.floor(random() * instants.length)])
          : new Date(Date.UTC(2026, 2, 20) + Math.floor(random() * 17 * 86_400_000));

      rows.push({
        wallet_id: random() < 0.6 ? card.id : cash.id,
        category_id: categoryOf.id,
        transaction_type: categoryOf.transaction_type,
        amount: (1 + Math.floor(random() * 99_999) / 100).toFixed(2),
        timestamp,
        description: descriptions[Math.floor(random() * descriptions.length)],
      });
    }

    const saved = await transactions.save(rows.map((row) => transactions.create(row)));

    await wallets.update(cash.id, { is_deleted: 1, deleted_at: new Date() });
    await categories.update(archived.id, { is_active: 0, archived_at: new Date() });

    const names = new Map<number, string>([
      [card.id, card.wallet_name],
      [cash.id, cash.wallet_name],
    ]);
    const categoryNames = new Map<number, string>([
      [coffee.id, coffee.name],
      [salary.id, salary.name],
      [archived.id, archived.name],
      [system.id, system.name],
    ]);
    control = saved.map((row) => ({
      id: row.id,
      timestamp: row.timestamp,
      type: row.transaction_type,
      cents: BigInt(row.amount.replace('.', '')),
      system: row.category_id === system.id,
      categoryId: row.category_id,
      walletId: row.wallet_id,
      texts: [row.description, categoryNames.get(row.category_id)!, names.get(row.wallet_id)!],
    }));
  });

  afterAll(async () => {
    try {
      await deleteUsers(testApp.dataSource, [owner?.userId, outsider?.userId].filter(Boolean));
    } finally {
      await testApp.app.close();
    }
  });

  const period = { from: '2026-03-01T00:00:00.000Z', to: '2026-04-30T23:59:59.999Z' };

  describe('pages and totals match the control selection', () => {
    it.each<[string, Partial<FeedQuery>, number]>([
      ['the whole period in Berlin, across the DST change', { time_zone: 'Europe/Berlin' }, 7],
      ['the whole period in Tokyo, pages of 100', { time_zone: 'Asia/Tokyo' }, 100],
      ['New York, pages of 50', { time_zone: 'America/New_York' }, 50],
      ['description and category name at once, Cyrillic in any case', { time_zone: 'UTC', q: 'КОФЕ' }, 9],
      ['accents ignored', { time_zone: 'UTC', q: 'cafe creme' }, 5],
      ['ё and е alike', { time_zone: 'UTC', q: 'елка' }, 6],
      ['the name of a deleted wallet', { time_zone: 'UTC', q: 'наличн' }, 11],
      ['the name of an archived category', { time_zone: 'UTC', q: 'old 50' }, 13],
      ['the name of an active wallet', { time_zone: 'UTC', q: 'card' }, 17],
      ['% literally', { time_zone: 'UTC', q: '50%' }, 20],
      ['_ literally', { time_zone: 'UTC', q: 'a_b' }, 20],
      ['outer spaces trimmed, inner kept', { time_zone: 'UTC', q: '  с собой ' }, 20],
      ['the initial balance by its category name', { time_zone: 'UTC', q: 'initial' }, 5],
      ['regular records only', { time_zone: 'Europe/Berlin', kind: 'regular' }, 30],
      ['initial balances only', { time_zone: 'UTC', kind: 'initial_balance' }, 5],
      ['income only', { time_zone: 'UTC', transaction_type: TransactionType.INCOME }, 30],
      ['search with a type filter', { time_zone: 'UTC', q: 'кофе', transaction_type: TransactionType.EXPENSE }, 25],
    ])('%s', async (_, params, limit) => {
      const q = { ...period, ...params } as FeedQuery;
      const pages = await walkForward(q, limit);

      expect(expected(q).length).toBeGreaterThan(0);
      expect(pages.length).toBe(Math.max(1, Math.ceil(expected(q).length / limit)));
      checkAgainstControl(q, pages);
    });

    it('filters by an archived category and by an active wallet', async () => {
      for (const params of [{ category_id: archived.id }, { wallet_id: card.id }]) {
        const q = { ...period, time_zone: 'UTC', ...params } as FeedQuery;

        checkAgainstControl(q, await walkForward(q, 12));
      }
    });

    it('takes both bounds inclusively, to the millisecond', async () => {
      const bounds = { from: '2026-03-25T00:00:00.000Z', to: '2026-03-29T12:00:00.000Z', time_zone: 'UTC' };
      const pages = await walkForward(bounds, 15);
      const ids = pages.flatMap((page) => page.items.map((item) => item.id));

      checkAgainstControl(bounds, pages);
      expect(ids).toContain(control[0].id);
      expect(expected(bounds).some((row) => row.timestamp.toISOString() === bounds.to)).toBe(true);

      const narrower = { from: '2026-03-25T00:00:00.001Z', to: '2026-03-29T11:59:59.999Z', time_zone: 'UTC' };
      const inner = (await walkForward(narrower, 100)).flatMap((page) => page.items.map((item) => item.id));

      expect(inner).not.toContain(control[0].id);
      checkAgainstControl(narrower, await walkForward(narrower, 15));
    });

    it('returns an empty selection with zero totals', async () => {
      expect(await feed({ ...period, time_zone: 'UTC', q: 'nothing-like-this' })).toEqual({
        items: [],
        page_info: { next_cursor: null, previous_cursor: null },
        summary: { count: 0, income: '0.00', expense: '0.00' },
        day_totals: [],
      });
    });
  });

  describe('moving both ways', () => {
    it('walks back from the last page to the first through previous_cursor', async () => {
      const q = { ...period, time_zone: 'Europe/Berlin' };
      const forward = await walkForward(q, 9);
      const back = [forward[forward.length - 1]];

      while (back[back.length - 1].page_info.previous_cursor) {
        back.push(await feed({ ...q, limit: 9, cursor: back[back.length - 1].page_info.previous_cursor }));
      }

      const ids = back.reverse().flatMap((page) => page.items.map((item) => item.id));
      expect(ids).toEqual(expected(q).map((row) => row.id));
      expect(back[0].page_info.previous_cursor).toBeNull();
    });

    it('opens around every tenth record and reaches both ends without gaps', async () => {
      const q = { ...period, time_zone: 'UTC' };
      const all = expected(q).map((row) => row.id);

      for (let index = 0; index < all.length; index += 40) {
        const page = await feed({ ...q, limit: 9, around_id: all[index] });
        const ids = page.items.map((item) => item.id);
        const start = all.indexOf(ids[0]);

        expect(ids).toEqual(all.slice(start, start + ids.length));
        expect(ids).toContain(all[index]);

        let older = page;
        const seen = [...ids];
        while (older.page_info.next_cursor) {
          older = await feed({ ...q, limit: 50, cursor: older.page_info.next_cursor });
          seen.push(...older.items.map((item) => item.id));
        }

        let newer = page;
        while (newer.page_info.previous_cursor) {
          newer = await feed({ ...q, limit: 50, cursor: newer.page_info.previous_cursor });
          seen.unshift(...newer.items.map((item) => item.id));
        }

        expect(seen).toEqual(all);
      }
    });
  });

  describe('access and filters', () => {
    it('reads deleted wallets as null and archived categories as archived', async () => {
      const page = await feed({ ...period, time_zone: 'UTC', q: 'наличн', limit: 100 });

      expect(page.items.length).toBeGreaterThan(0);
      expect(page.items.every((item) => item.wallet === null)).toBe(true);

      const old = await feed({ ...period, time_zone: 'UTC', category_id: archived.id, limit: 1 });
      expect(old.items[0]).toMatchObject({ category: { id: archived.id, is_archived: true } });
    });

    it.each([
      ['a category of another space', () => ({ category_id: foreignCategoryId }), 'FORBIDDEN_CATEGORY'],
      ['a deleted wallet', () => ({ wallet_id: cash.id }), 'FORBIDDEN_WALLET'],
    ])('refuses %s as a filter, as the count does', async (_, params, code) => {
      const feedRes = await get(owner, '/feed', { ...period, time_zone: 'UTC', ...params() });
      const countRes = await get(owner, '/count', { ...period, ...params() });

      expect(feedRes.status).toBe(403);
      expect(feedRes.body.code).toBe(code);
      expect(countRes.body.code).toBe(code);
    });

    it('checks the request shape first, then refuses a member of another space', async () => {
      const res = await get(outsider, '/feed', { ...period, time_zone: 'UTC', cursor: 'bogus-but-well-formed' });

      expect(res.status).toBe(400);

      const forbidden = await get(outsider, '/feed', { ...period, time_zone: 'UTC' });
      expect(forbidden.status).toBe(403);
      expect(forbidden.body.code).toBe('FORBIDDEN_SPACE');
    });
  });

  describe('count, latest and OpenAPI', () => {
    // no test of this suite writes, so the selection is the same for both
    it('keeps /count and /latest, and /count agrees with the feed', async () => {
      for (const params of [
        {},
        { q: 'кофе' },
        { q: 'наличн' },
        { kind: 'regular' },
        { kind: 'initial_balance' },
        { transaction_type: TransactionType.INCOME },
        { category_id: archived.id },
        { wallet_id: card.id, q: 'кофе' },
        { from: '2026-03-29T12:00:00.000Z', to: '2026-03-29T12:00:00.000Z' },
      ]) {
        const q = { ...period, time_zone: 'UTC', ...params } as FeedQuery;
        const count = await get(owner, '/count', { ...period, ...params });
        const page = await feed({ ...q, limit: 1 });

        expect(expected(q).length).toBeGreaterThan(0);
        expect(count.body).toEqual({ count: page.summary.count });
        expect(page.summary.count).toBe(expected(q).length);
      }

      const latest = await get(owner, '/latest', {});
      const newest = expected({ from: '1970-01-01T00:00:01.000Z', to: '2038-01-19T03:14:07.000Z', time_zone: 'UTC' });
      expect(latest.body.id).toBe(newest[0].id);
    });

    it('documents every feed parameter, and q on the count', () => {
      const names = (path: string) =>
        (
          document.paths[Object.keys(document.paths).find((p) => p.endsWith(path))!].get!.parameters as {
            name: string;
            in: string;
          }[]
        )
          .filter((parameter) => parameter.in === 'query')
          .map((parameter) => parameter.name)
          .sort();

      expect(names('/transactions/feed')).toEqual(
        [
          'around_id',
          'category_id',
          'cursor',
          'from',
          'kind',
          'limit',
          'q',
          'time_zone',
          'to',
          'transaction_type',
          'wallet_id',
        ].sort(),
      );
      expect(names('/transactions/count')).toContain('q');
    });
  });
});
