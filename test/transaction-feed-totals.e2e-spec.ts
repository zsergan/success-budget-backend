import request from 'supertest';

import { type Member, type TestApp, createTestApp, createVerifiedMember, deleteUsers } from './support/app';
import { createOpenApiDocument, okResponseSchema, schemaErrors } from './support/openapi';

interface FeedBody {
  items: { id: string; kind: string }[];
  page_info: { next_cursor: string | null; previous_cursor: string | null };
  summary: { count: number; income: string; expense: string };
  day_totals: { date: string; net: string }[];
}

// Each scenario has its own period, so the records of one never reach another.
describe('Transactions feed totals (e2e)', () => {
  let testApp: TestApp;
  let owner: Member;
  let walletId: number;
  let expenseCategoryId: number;
  let incomeCategoryId: number;

  const feed = async (query: string): Promise<FeedBody> =>
    (
      await request(testApp.app.getHttpServer())
        .get(`/api/v1/spaces/${owner.spaceId}/transactions/feed?${query}`)
        .set('Authorization', `Bearer ${owner.token}`)
        .expect(200)
    ).body;

  async function add(type: 'income' | 'expense', amount: string, timestamp: string) {
    await request(testApp.app.getHttpServer())
      .post(`/api/v1/spaces/${owner.spaceId}/transactions`)
      .set('Authorization', `Bearer ${owner.token}`)
      .send({
        wallet_id: walletId,
        category_id: type === 'income' ? incomeCategoryId : expenseCategoryId,
        transaction_type: type,
        amount,
        timestamp,
      })
      .expect(201);
  }

  beforeAll(async () => {
    testApp = await createTestApp();
    owner = await createVerifiedMember(testApp, 'feed-totals');

    const server = testApp.app.getHttpServer();
    const wallet = await request(server)
      .post(`/api/v1/spaces/${owner.spaceId}/wallets`)
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ wallet_name: 'Card', initial_balance: '100', design: 'slate' })
      .expect(201);
    walletId = wallet.body.wallet.id;
    await testApp.dataSource.query('UPDATE transactions SET timestamp = ? WHERE wallet_id = ?', [
      new Date('2026-02-10T09:00:00.000Z'),
      walletId,
    ]);

    const categories = await request(server)
      .get(`/api/v1/spaces/${owner.spaceId}/categories`)
      .set('Authorization', `Bearer ${owner.token}`)
      .expect(200);
    expenseCategoryId = categories.body.expenses[0].id;
    incomeCategoryId = categories.body.incomes[0].id;

    await add('income', '50.00', '2026-02-09T10:00:00.000Z');
    for (const hour of ['10', '11', '12', '13']) {
      await add('expense', '1.00', `2026-02-10T${hour}:00:00.000Z`);
    }
    await add('expense', '2.00', '2026-02-11T10:00:00.000Z');

    // Europe/Berlin leaves summer time on 2025-10-26 (a 25-hour day)
    await add('expense', '1.00', '2025-10-25T21:30:00.000Z');
    await add('expense', '10.00', '2025-10-25T22:30:00.000Z');
    await add('expense', '5.00', '2025-10-26T22:30:00.000Z');
    await add('income', '100.00', '2025-10-26T23:30:00.000Z');

    // ... and enters it on 2026-03-29 (a 23-hour day)
    await add('expense', '4.00', '2026-03-28T23:30:00.000Z');
    await add('expense', '2.00', '2026-03-29T21:30:00.000Z');
    await add('expense', '3.00', '2026-03-29T22:30:00.000Z');

    for (const minute of ['00', '01', '02']) {
      await add('expense', '99999999.99', `2026-01-15T10:${minute}:00.000Z`);
    }
    await add('income', '99999999.99', '2026-01-16T10:00:00.000Z');
  });

  afterAll(async () => {
    try {
      await deleteUsers(testApp.dataSource, [owner?.userId].filter(Boolean));
    } finally {
      await testApp.app.close();
    }
  });

  const february = 'from=2026-02-01T00:00:00.000Z&to=2026-02-28T23:59:59.999Z&time_zone=UTC';

  describe('summary', () => {
    it('covers the whole selection on the first page, initial balance counted but not income', async () => {
      const page = await feed(`${february}&limit=2`);

      expect(page.items).toHaveLength(2);
      expect(page.summary).toEqual({ count: 7, income: '50.00', expense: '6.00' });
    });

    it('is the same on every page of the query', async () => {
      const first = await feed(`${february}&limit=3`);
      const second = await feed(`${february}&limit=3&cursor=${first.page_info.next_cursor}`);

      expect(second.summary).toEqual(first.summary);
    });

    it('follows the search and the filters', async () => {
      expect((await feed(`${february}&kind=regular`)).summary).toEqual({ count: 6, income: '50.00', expense: '6.00' });
      expect((await feed(`${february}&transaction_type=expense`)).summary).toEqual({
        count: 5,
        income: '0.00',
        expense: '6.00',
      });
      expect((await feed(`${february}&q=initial`)).summary).toEqual({ count: 1, income: '0.00', expense: '0.00' });
      expect((await feed(`${february}&q=nothing-like-it`)).summary).toEqual({
        count: 0,
        income: '0.00',
        expense: '0.00',
      });
    });

    it('sums exactly beyond the maximum of one amount', async () => {
      const page = await feed('from=2026-01-01T00:00:00.000Z&to=2026-01-31T23:59:59.999Z&time_zone=UTC&limit=1');

      expect(page.summary).toEqual({ count: 4, income: '99999999.99', expense: '299999999.97' });
      expect(page.day_totals).toEqual([{ date: '2026-01-16', net: '99999999.99' }]);

      const next = await feed(
        `from=2026-01-01T00:00:00.000Z&to=2026-01-31T23:59:59.999Z&time_zone=UTC&limit=1&cursor=${page.page_info.next_cursor}`,
      );
      expect(next.day_totals).toEqual([{ date: '2026-01-15', net: '-299999999.97' }]);
    });
  });

  describe('day_totals', () => {
    it('totals each day of the page in full, also when it is split between pages', async () => {
      const pages: FeedBody[] = [await feed(`${february}&limit=2`)];

      while (pages[pages.length - 1].page_info.next_cursor) {
        pages.push(await feed(`${february}&limit=2&cursor=${pages[pages.length - 1].page_info.next_cursor}`));
      }

      expect(pages.map((page) => page.day_totals)).toEqual([
        [
          { date: '2026-02-11', net: '-2.00' },
          { date: '2026-02-10', net: '-4.00' },
        ],
        [{ date: '2026-02-10', net: '-4.00' }],
        [{ date: '2026-02-10', net: '-4.00' }],
        [{ date: '2026-02-09', net: '50.00' }],
      ]);
      expect(pages[2].items.map((item) => item.kind)).toEqual(['regular', 'initial_balance']);
    });

    it('lists a day that only has the initial balance with a zero net', async () => {
      expect((await feed(`${february}&q=initial`)).day_totals).toEqual([{ date: '2026-02-10', net: '0.00' }]);
    });

    it('counts only the part of a day inside the period', async () => {
      const page = await feed('from=2026-02-10T11:30:00.000Z&to=2026-02-10T23:59:59.999Z&time_zone=UTC');

      expect(page.day_totals).toEqual([{ date: '2026-02-10', net: '-2.00' }]);
    });

    it('groups by the local day of time_zone', async () => {
      const page = await feed('from=2026-02-01T00:00:00.000Z&to=2026-02-28T23:59:59.999Z&time_zone=Asia/Tokyo');

      // 2026-02-10T13:00Z is 22:00 in Tokyo; 2026-02-11T10:00Z is 19:00 on the 11th
      expect(page.day_totals).toEqual([
        { date: '2026-02-11', net: '-2.00' },
        { date: '2026-02-10', net: '-4.00' },
        { date: '2026-02-09', net: '50.00' },
      ]);
    });

    it('takes a 25-hour day when summer time ends', async () => {
      const page = await feed(
        'from=2025-10-20T00:00:00.000Z&to=2025-10-31T23:59:59.999Z&time_zone=Europe/Berlin&limit=2',
      );

      expect(page.day_totals).toEqual([
        { date: '2025-10-27', net: '100.00' },
        { date: '2025-10-26', net: '-15.00' },
      ]);

      const next = await feed(
        `from=2025-10-20T00:00:00.000Z&to=2025-10-31T23:59:59.999Z&time_zone=Europe/Berlin&limit=2&cursor=${page.page_info.next_cursor}`,
      );
      expect(next.day_totals).toEqual([
        { date: '2025-10-26', net: '-15.00' },
        { date: '2025-10-25', net: '-1.00' },
      ]);
    });

    it('takes a 23-hour day when summer time starts', async () => {
      const page = await feed('from=2026-03-20T00:00:00.000Z&to=2026-03-31T23:59:59.999Z&time_zone=Europe/Berlin');

      expect(page.day_totals).toEqual([
        { date: '2026-03-30', net: '-3.00' },
        { date: '2026-03-29', net: '-6.00' },
      ]);
    });
  });

  describe('GET /transactions/count', () => {
    const count = async (query: string) =>
      (
        await request(testApp.app.getHttpServer())
          .get(`/api/v1/spaces/${owner.spaceId}/transactions/count?${query}`)
          .set('Authorization', `Bearer ${owner.token}`)
      ).body;
    const period = 'from=2026-02-01T00:00:00.000Z&to=2026-02-28T23:59:59.999Z';

    it.each(['', 'q=initial', 'q=%20%20Card%20', 'q=nothing-like-it', 'q=card&kind=regular', 'q=%20%20%20'])(
      'counts what the feed summary counts for %p',
      async (query) => {
        const feedCount = (await feed(`${period}&time_zone=UTC&${query}`)).summary.count;

        expect(await count(`${period}&${query}`)).toEqual({ count: feedCount });
      },
    );

    it('counts every record of the period without q, as before', async () => {
      expect(await count(period)).toEqual({ count: 7 });
    });

    it('refuses a q longer than 255 characters or repeated', async () => {
      expect(await count(`${period}&q=${'x'.repeat(256)}`)).toMatchObject({
        statusCode: 400,
        code: 'VALIDATION_FAILED',
        message: [{ field: 'q', error: 'q must be at most 255 characters' }],
      });
      expect(await count(`${period}&q=a&q=b`)).toMatchObject({
        statusCode: 400,
        message: [{ field: 'q', error: 'q must be a string' }],
      });
    });

    it('keeps the old parameter rules: date-only bounds and the month default', async () => {
      expect(await count('from=2026-02-01&to=2026-02-28')).toEqual({ count: 7 });
      expect(await count('')).toEqual({ count: expect.any(Number) });
      expect(await count('from=2026-02-28T00:00:00.000Z&to=2026-02-01T00:00:00.000Z')).toMatchObject({
        statusCode: 400,
        message: [{ field: 'from', error: 'from must not be after to' }],
      });
    });
  });

  it('matches its OpenAPI schema', async () => {
    const document = createOpenApiDocument(testApp.app);
    const page = await feed(`${february}&limit=2`);

    expect(schemaErrors(document, okResponseSchema(document, '/transactions/feed'), page)).toEqual([]);
  });
});
