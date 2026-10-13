import request from 'supertest';

import { type Member, type TestApp, createTestApp, createVerifiedMember, deleteUsers } from './support/app';

interface FeedBody {
  items: { id: string; description: string | null; timestamp: string }[];
  page_info: { next_cursor: string | null; previous_cursor: string | null };
}

describe('Transactions feed pages (e2e)', () => {
  let testApp: TestApp;
  let owner: Member;
  let outsider: Member;
  let walletId: number;
  let categoryId: number;
  let foreignId: string;
  // the records of the period, newest first, read from the table
  let history: string[];

  const period = 'from=2026-09-01T00:00:00.000Z&to=2026-09-30T23:59:59.999Z&time_zone=Europe/Moscow';
  const timestamps = [
    '2026-09-01T10:00:00.000Z',
    '2026-09-02T10:00:00.000Z',
    '2026-09-03T10:00:00.001Z',
    '2026-09-03T10:00:00.002Z',
    '2026-09-04T12:00:00.000Z',
    '2026-09-04T12:00:00.000Z',
    '2026-09-04T12:00:00.000Z',
    '2026-09-05T10:00:00.000Z',
    '2026-09-06T10:00:00.000Z',
    '2026-09-07T10:00:00.000Z',
    '2026-09-08T10:00:00.000Z',
    '2026-09-09T10:00:00.000Z',
  ];

  const base = (member: Member) => `/api/v1/spaces/${member.spaceId}/transactions`;
  const get = (member: Member, url: string) =>
    request(testApp.app.getHttpServer()).get(url).set('Authorization', `Bearer ${member.token}`);
  const feed = async (query: string, member = owner): Promise<FeedBody> =>
    (await get(member, `${base(member)}/feed?${period}&${query}`).expect(200)).body;
  const ids = (body: FeedBody) => body.items.map((item) => item.id);

  async function createTransaction(member: Member, wallet: number, category: number, timestamp: string, n: number) {
    const res = await request(testApp.app.getHttpServer())
      .post(base(member))
      .set('Authorization', `Bearer ${member.token}`)
      .send({
        wallet_id: wallet,
        category_id: category,
        transaction_type: 'expense',
        amount: '1.00',
        timestamp,
        description: `row ${n}`,
      })
      .expect(201);

    return res.body.transaction.id as string;
  }

  async function setUp(member: Member) {
    const server = testApp.app.getHttpServer();
    const wallet = await request(server)
      .post(`/api/v1/spaces/${member.spaceId}/wallets`)
      .set('Authorization', `Bearer ${member.token}`)
      .send({ wallet_name: 'Card', initial_balance: '0', design: 'slate' })
      .expect(201);
    const categories = await get(member, `/api/v1/spaces/${member.spaceId}/categories`).expect(200);

    return { wallet: wallet.body.wallet.id as number, category: categories.body.expenses[0].id as number };
  }

  async function stored(): Promise<string[]> {
    const rows: { id: string }[] = await testApp.dataSource.query(
      `SELECT id FROM transactions
         WHERE wallet_id = ? AND timestamp BETWEEN ? AND ?
         ORDER BY timestamp DESC, id DESC`,
      [walletId, new Date('2026-09-01T00:00:00.000Z'), new Date('2026-09-30T23:59:59.999Z')],
    );

    return rows.map((row) => row.id);
  }

  async function walk(query: string): Promise<string[]> {
    const seen: string[] = [];
    let page = await feed(query);
    seen.push(...ids(page));

    while (page.page_info.next_cursor) {
      page = await feed(`${query}&cursor=${page.page_info.next_cursor}`);
      seen.push(...ids(page));
    }

    return seen;
  }

  beforeAll(async () => {
    testApp = await createTestApp();
    owner = await createVerifiedMember(testApp, 'feed-owner');
    outsider = await createVerifiedMember(testApp, 'feed-outsider');

    ({ wallet: walletId, category: categoryId } = await setUp(owner));

    for (const [n, timestamp] of timestamps.entries()) {
      await createTransaction(owner, walletId, categoryId, timestamp, n);
    }

    const foreign = await setUp(outsider);
    foreignId = await createTransaction(outsider, foreign.wallet, foreign.category, timestamps[0], 0);

    history = await stored();
  });

  afterAll(async () => {
    try {
      await deleteUsers(testApp.dataSource, [owner?.userId, outsider?.userId].filter(Boolean));
    } finally {
      await testApp.app.close();
    }
  });

  describe('pages', () => {
    it('opens the newest page with only a cursor to older records', async () => {
      const page = await feed('limit=5');

      expect(ids(page)).toEqual(history.slice(0, 5));
      expect(page.page_info.previous_cursor).toBeNull();
      expect(page.page_info.next_cursor).toEqual(expect.any(String));
    });

    it('fits the history in one page of 50 by default', async () => {
      const page = await feed('');

      expect(ids(page)).toEqual(history);
      expect(page.page_info).toEqual({ next_cursor: null, previous_cursor: null });
    });

    it.each([1, 2, 5, 11, 12])('walks the history with pages of %p, ties and milliseconds included', async (limit) => {
      expect(await walk(`limit=${limit}`)).toEqual(history);
    });

    it('goes back to newer records with previous_cursor, newest first', async () => {
      const first = await feed('limit=4');
      const second = await feed(`limit=4&cursor=${first.page_info.next_cursor}`);

      expect(ids(second)).toEqual(history.slice(4, 8));
      expect(second.page_info.previous_cursor).toEqual(expect.any(String));

      const back = await feed(`limit=4&cursor=${second.page_info.previous_cursor}`);

      expect(ids(back)).toEqual(history.slice(0, 4));
      expect(back.page_info.previous_cursor).toBeNull();
      expect(back.page_info.next_cursor).toEqual(expect.any(String));
    });

    it('lets the page size change between pages', async () => {
      const first = await feed('limit=3');
      const second = await feed(`limit=7&cursor=${first.page_info.next_cursor}`);

      expect(ids(second)).toEqual(history.slice(3, 10));
    });

    it('returns an empty page with no cursors when there is nothing', async () => {
      const page = await feed('q=nothing-matches-this');

      expect(page).toMatchObject({ items: [], page_info: { next_cursor: null, previous_cursor: null } });
    });

    it('continues after the record its cursor was taken from was deleted', async () => {
      const first = await feed('limit=3');
      const boundary = await get(owner, `${base(owner)}/${history[2]}`).expect(200);

      await request(testApp.app.getHttpServer())
        .delete(`${base(owner)}/${history[2]}`)
        .set('Authorization', `Bearer ${owner.token}`)
        .set('If-Match', `"${boundary.body.version}"`)
        .expect(200);

      const second = await feed(`limit=3&cursor=${first.page_info.next_cursor}`);

      expect(ids(second)).toEqual(history.slice(3, 6));

      history.splice(2, 1);
      await createTransaction(owner, walletId, categoryId, boundary.body.timestamp, 99);
      history = await stored();
    });
  });

  describe('cursor errors', () => {
    let cursor: string;

    beforeAll(async () => {
      cursor = (await feed('limit=2')).page_info.next_cursor!;
    });

    const cursorError = async (query: string) => (await get(owner, `${base(owner)}/feed?${query}`).expect(400)).body;

    it.each([
      ['another search', `${period}&q=row`],
      ['another period', 'from=2026-09-01T00:00:00.000Z&to=2026-09-29T23:59:59.999Z&time_zone=Europe/Moscow'],
      ['another time zone', 'from=2026-09-01T00:00:00.000Z&to=2026-09-30T23:59:59.999Z&time_zone=Europe/Berlin'],
      ['another filter', `${period}&kind=regular`],
    ])('refuses a cursor sent with %s', async (_, query) => {
      expect(await cursorError(`${query}&cursor=${cursor}`)).toMatchObject({
        code: 'VALIDATION_FAILED',
        message: [{ field: 'cursor', error: 'cursor does not belong to this query' }],
      });
    });

    it('refuses a cursor of another space, even with the same query', async () => {
      const res = await get(outsider, `${base(outsider)}/feed?${period}&cursor=${cursor}`).expect(400);

      expect(res.body.message).toEqual([{ field: 'cursor', error: 'cursor does not belong to this query' }]);
    });

    it('accepts the same query with the search spelled with other outer spaces', async () => {
      const searched = await feed('q=row&limit=2');

      await feed(`q=%20%20row%20&limit=2&cursor=${searched.page_info.next_cursor}`);
    });

    it.each([
      ['tampered', () => `${cursor.slice(0, -2)}xx`],
      ['not a cursor', () => 'hello'],
      ['too long', () => 'A'.repeat(257)],
    ])('refuses a %s cursor', async (_, value) => {
      const body = await cursorError(`${period}&cursor=${value()}`);

      expect(body.code).toBe('VALIDATION_FAILED');
      expect(body.message.map((error: { field: string }) => error.field)).toEqual(['cursor']);
    });

    it('refuses a cursor together with around_id', async () => {
      expect(await cursorError(`${period}&cursor=${cursor}&around_id=${history[0]}`)).toMatchObject({
        message: [{ field: 'cursor', error: 'cursor and around_id cannot be used together' }],
      });
    });
  });

  describe('around_id', () => {
    it('opens a window with the record in it and cursors both ways', async () => {
      const page = await feed(`limit=5&around_id=${history[6]}`);

      expect(ids(page)).toEqual(history.slice(4, 9));

      const older = await feed(`limit=5&cursor=${page.page_info.next_cursor}`);
      const newer = await feed(`limit=5&cursor=${page.page_info.previous_cursor}`);

      expect(ids(older)).toEqual(history.slice(9));
      expect(older.page_info.next_cursor).toBeNull();
      expect(ids(newer)).toEqual(history.slice(0, 4));
      expect(newer.page_info.previous_cursor).toBeNull();
    });

    it('fills the window from the other side at either end', async () => {
      const top = await feed(`limit=5&around_id=${history[1]}`);
      const bottom = await feed(`limit=5&around_id=${history[history.length - 1]}`);

      expect(ids(top)).toEqual(history.slice(0, 5));
      expect(top.page_info.previous_cursor).toBeNull();
      expect(ids(bottom)).toEqual(history.slice(-5));
      expect(bottom.page_info.next_cursor).toBeNull();
    });

    it('returns only the record with a page of one', async () => {
      const page = await feed(`limit=1&around_id=${history[6]}`);

      expect(ids(page)).toEqual([history[6]]);
      expect(page.page_info.next_cursor).toEqual(expect.any(String));
      expect(page.page_info.previous_cursor).toEqual(expect.any(String));
    });

    it.each([
      ['outside the search', 'q=nothing-matches-this'],
      ['outside a filter', 'kind=initial_balance'],
    ])('is TRANSACTION_NOT_IN_FEED for a record %s', async (_, query) => {
      const res = await get(owner, `${base(owner)}/feed?${period}&${query}&around_id=${history[0]}`).expect(404);

      expect(res.body.code).toBe('TRANSACTION_NOT_IN_FEED');
    });

    it('is TRANSACTION_NOT_IN_FEED for a record outside the period', async () => {
      const res = await get(
        owner,
        `${base(owner)}/feed?from=2026-08-01T00:00:00.000Z&to=2026-08-31T23:59:59.999Z&time_zone=UTC&around_id=${history[0]}`,
      ).expect(404);

      expect(res.body.code).toBe('TRANSACTION_NOT_IN_FEED');
    });

    it.each([
      ['of another space', () => foreignId],
      ['unknown', () => '00000000-0000-4000-8000-000000000000'],
      ['malformed', () => 'not-an-id'],
    ])('is TRANSACTION_NOT_FOUND for a record %s', async (_, id) => {
      const res = await get(owner, `${base(owner)}/feed?${period}&around_id=${id()}`).expect(404);

      expect(res.body.code).toBe('TRANSACTION_NOT_FOUND');
    });
  });

  describe('request', () => {
    it('is routed as the feed, not as a transaction id', async () => {
      const res = await get(owner, `${base(owner)}/feed`).expect(400);

      expect(res.body.code).toBe('VALIDATION_FAILED');
      expect(res.body.message.map((error: { field: string }) => error.field).sort()).toEqual([
        'from',
        'time_zone',
        'to',
      ]);
    });

    it('refuses from after to', async () => {
      const res = await get(
        owner,
        `${base(owner)}/feed?from=2026-09-30T00:00:00.000Z&to=2026-09-01T00:00:00.000Z&time_zone=UTC`,
      ).expect(400);

      expect(res.body.message).toEqual([{ field: 'from', error: 'from must not be after to' }]);
    });

    it('is FORBIDDEN_SPACE for a non-member', async () => {
      const res = await get(outsider, `${base(owner)}/feed?${period}`).expect(403);

      expect(res.body.code).toBe('FORBIDDEN_SPACE');
    });
  });
});
