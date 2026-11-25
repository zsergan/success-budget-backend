import request from 'supertest';

import {
  type Member,
  type TestApp,
  createTestApp,
  createVerifiedMember,
  deleteUsers,
  insertLegacyTransaction,
} from './support/app';

interface FeedBody {
  items: { id: string; date: string }[];
  page_info: { next_cursor: string | null; previous_cursor: string | null };
  summary: { count: number; income: string; expense: string };
  day_totals: { date: string; net: string }[];
}

// A period is two calendar dates compared with the stored date: no zone, no
// instant, and none of the limits a TIMESTAMP column had.
describe('Transactions feed date range (e2e)', () => {
  let testApp: TestApp;
  let owner: Member;
  const ids: Record<'lastOf1969' | 'firstOf1970' | 'secondOf1970' | 'in2040', string> = {} as never;

  const get = (url: string) =>
    request(testApp.app.getHttpServer()).get(url).set('Authorization', `Bearer ${owner.token}`);
  const base = () => `/api/v2/spaces/${owner.spaceId}/transactions`;

  beforeAll(async () => {
    testApp = await createTestApp();
    owner = await createVerifiedMember(testApp, 'feed-range');
    const categories = await get(`/api/v1/spaces/${owner.spaceId}/categories`).expect(200);
    const create = async (date: string, amount: string) =>
      (
        await request(testApp.app.getHttpServer())
          .post(base())
          .set('Authorization', `Bearer ${owner.token}`)
          .send({
            category_id: categories.body.expenses[0].id,
            transaction_type: 'expense',
            amount,
            date,
            time_zone: 'Asia/Tokyo',
            assignment: { kind: 'space' },
          })
          .expect(201)
      ).body.transaction.id as string;

    ids.lastOf1969 = await create('1969-12-31', '2.00');
    ids.firstOf1970 = await create('1970-01-01', '3.00');
    ids.secondOf1970 = await create('1970-01-02', '5.00');
    // a record of an older rule, dated after today
    const [{ id }] = await testApp.dataSource.query('SELECT UUID() AS id');
    await insertLegacyTransaction(testApp.dataSource, {
      id,
      spaceId: owner.spaceId,
      categoryId: categories.body.expenses[0].id,
      type: 'expense',
      amount: '7.00',
      date: '2040-01-01',
    });
    ids.in2040 = id;
  });

  afterAll(async () => {
    try {
      await deleteUsers(testApp.dataSource, [owner?.userId].filter(Boolean));
    } finally {
      await testApp.app.close();
    }
  });

  it('opens January 1970 by its dates, its first day included, like the count does', async () => {
    const period = 'from_date=1970-01-01&to_date=1970-01-31';
    const count = await get(`${base()}/count?${period}`).expect(200);
    const page = (await get(`${base()}/feed?${period}`).expect(200)).body as FeedBody;

    expect(page.items.map((item) => item.id)).toEqual([ids.secondOf1970, ids.firstOf1970]);
    expect(page.summary).toEqual({ count: count.body.count, income: '0.00', expense: '8.00' });
    expect(page.day_totals).toEqual([
      { date: '1970-01-02', net: '-5.00' },
      { date: '1970-01-01', net: '-3.00' },
    ]);
    expect(page.page_info).toEqual({ next_cursor: null, previous_cursor: null });
  });

  it('selects the dates a TIMESTAMP could not hold', async () => {
    const before = (await get(`${base()}/feed?from_date=1969-12-01&to_date=1969-12-31`).expect(200)).body as FeedBody;
    const after = (await get(`${base()}/feed?from_date=2040-01-01&to_date=2040-01-01`).expect(200)).body as FeedBody;

    expect(before.items.map((item) => [item.id, item.date])).toEqual([[ids.lastOf1969, '1969-12-31']]);
    expect(after.items.map((item) => [item.id, item.date])).toEqual([[ids.in2040, '2040-01-01']]);
    expect(after.day_totals).toEqual([{ date: '2040-01-01', net: '-7.00' }]);
  });

  it('returns a period without records as an empty page', async () => {
    const res = await get(`${base()}/feed?from_date=1000-01-01&to_date=1969-12-30`).expect(200);

    expect(res.body).toEqual({
      items: [],
      page_info: { next_cursor: null, previous_cursor: null },
      summary: { count: 0, income: '0.00', expense: '0.00' },
      day_totals: [],
    });
  });

  it.each([
    {
      name: 'all of the DATE range',
      from: '1000-01-01',
      to: '9999-12-31',
      found: ['in2040', 'secondOf1970', 'firstOf1970', 'lastOf1969'],
    },
    { name: 'one day', from: '1970-01-01', to: '1970-01-01', found: ['firstOf1970'] },
    { name: 'across the new year', from: '1969-12-31', to: '1970-01-01', found: ['firstOf1970', 'lastOf1969'] },
    { name: 'from the second day on', from: '1970-01-02', to: '9999-12-31', found: ['in2040', 'secondOf1970'] },
  ] as const)('counts $name like /count, page after page', async ({ from, to, found }) => {
    const period = `from_date=${from}&to_date=${to}`;
    const count = await get(`${base()}/count?${period}`).expect(200);
    const seen: string[] = [];
    let page = (await get(`${base()}/feed?${period}&limit=1`).expect(200)).body as FeedBody;
    seen.push(...page.items.map((item) => item.id));

    while (page.page_info.next_cursor) {
      page = (await get(`${base()}/feed?${period}&limit=1&cursor=${page.page_info.next_cursor}`).expect(200))
        .body as FeedBody;
      expect(page.summary.count).toBe(count.body.count);
      seen.push(...page.items.map((item) => item.id));
    }

    expect(count.body.count).toBe(found.length);
    expect(seen).toEqual(found.map((name) => ids[name]));
  });

  it('opens a record of 1969 in its month, and refuses it outside the period', async () => {
    const res = await get(`${base()}/feed?from_date=1969-12-01&to_date=1970-01-31&around_id=${ids.lastOf1969}`).expect(
      200,
    );
    const outside = await get(
      `${base()}/feed?from_date=1970-01-01&to_date=1970-01-31&around_id=${ids.lastOf1969}`,
    ).expect(404);

    expect(res.body.items.map((item: { id: string }) => item.id)).toEqual([
      ids.secondOf1970,
      ids.firstOf1970,
      ids.lastOf1969,
    ]);
    expect(outside.body.code).toBe('TRANSACTION_NOT_IN_FEED');
  });

  it.each([
    { case: 'from_date after to_date', query: 'from_date=2040-01-02&to_date=2040-01-01', field: 'from_date' },
    { case: 'a date with a time', query: 'from_date=1970-01-01T00:00:00Z&to_date=1970-01-31', field: 'from_date' },
    { case: 'an offset', query: 'from_date=1970-01-01&to_date=1970-01-31%2B03:00', field: 'to_date' },
    { case: 'not a day', query: 'from_date=1969-02-29&to_date=1970-01-31', field: 'from_date' },
    { case: 'a five-digit year', query: 'from_date=1970-01-01&to_date=%2B10000-01-01', field: 'to_date' },
    { case: 'a year before 1000', query: 'from_date=0999-12-31&to_date=1970-01-31', field: 'from_date' },
  ])('refuses $case', async ({ query, field }) => {
    const res = await get(`${base()}/feed?${query}`).expect(400);

    expect(res.body.code).toBe('VALIDATION_FAILED');
    expect(res.body.message.map((error: { field: string }) => error.field)).toContain(field);
  });
});
