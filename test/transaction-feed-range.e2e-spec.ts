import request from 'supertest';

import { type Member, type TestApp, createTestApp, createVerifiedMember, deleteUsers } from './support/app';

interface FeedBody {
  items: { id: string }[];
  page_info: { next_cursor: string | null; previous_cursor: string | null };
  summary: { count: number; income: string; expense: string };
  day_totals: { date: string; net: string }[];
}

// A period is a search range, not a stored value: its bounds may lie outside
// the range a TIMESTAMP column can hold, as long as the records inside it fit.
describe('Transactions feed period bounds (e2e)', () => {
  let testApp: TestApp;
  let owner: Member;
  let earliest: string;
  let secondDay: string;

  const get = (url: string) =>
    request(testApp.app.getHttpServer()).get(url).set('Authorization', `Bearer ${owner.token}`);
  const base = () => `/api/v1/spaces/${owner.spaceId}/transactions`;

  beforeAll(async () => {
    testApp = await createTestApp();
    owner = await createVerifiedMember(testApp, 'feed-range');
    const server = testApp.app.getHttpServer();
    const auth = { Authorization: `Bearer ${owner.token}` };
    const wallet = await request(server)
      .post(`/api/v1/spaces/${owner.spaceId}/wallets`)
      .set(auth)
      .send({ wallet_name: 'Card', initial_balance: '0', design: 'slate' })
      .expect(201);
    const categories = await get(`/api/v1/spaces/${owner.spaceId}/categories`).expect(200);
    const create = async (timestamp: string, amount: string) =>
      (
        await request(server)
          .post(base())
          .set(auth)
          .send({
            wallet_id: wallet.body.wallet.id,
            category_id: categories.body.expenses[0].id,
            transaction_type: 'expense',
            amount,
            timestamp,
          })
          .expect(201)
      ).body.transaction.id as string;

    earliest = await create('1970-01-01T00:00:01.000Z', '3.00');
    secondDay = await create('1970-01-02T00:00:00.000Z', '5.00');
  });

  afterAll(async () => {
    try {
      await deleteUsers(testApp.dataSource, [owner?.userId].filter(Boolean));
    } finally {
      await testApp.app.close();
    }
  });

  describe('January 1970', () => {
    it.failing.each([
      {
        zone: 'UTC',
        from: '1970-01-01T00:00:00.000Z',
        to: '1970-01-31T23:59:59.999Z',
        days: [
          { date: '1970-01-02', net: '-5.00' },
          { date: '1970-01-01', net: '-3.00' },
        ],
      },
      {
        zone: 'Asia/Tokyo',
        from: '1969-12-31T15:00:00.000Z',
        to: '1970-01-31T14:59:59.999Z',
        days: [
          { date: '1970-01-02', net: '-5.00' },
          { date: '1970-01-01', net: '-3.00' },
        ],
      },
    ])('opens the month in $zone like the history and the count do', async ({ zone, from, to, days }) => {
      const period = `from=${from}&to=${to}`;
      const history = await get(`${base()}?${period}`).expect(200);
      const count = await get(`${base()}/count?${period}`).expect(200);
      const res = await get(`${base()}/feed?${period}&time_zone=${zone}`);

      expect(res.status).toBe(200);
      const page = res.body as FeedBody;
      expect(page.items.map((item) => item.id)).toEqual([secondDay, earliest]);
      expect(page.items.map((item) => item.id)).toEqual(history.body.map((row: { id: string }) => row.id));
      expect(page.summary).toEqual({ count: count.body.count, income: '0.00', expense: '8.00' });
      expect(page.day_totals).toEqual(days);
      expect(page.page_info).toEqual({ next_cursor: null, previous_cursor: null });
    });
  });

  describe('a period outside the stored range', () => {
    it.failing.each([
      { name: 'December 1969', from: '1969-12-01T00:00:00.000Z', to: '1969-12-31T23:59:59.999Z' },
      { name: 'February 2038', from: '2038-02-01T00:00:00.000Z', to: '2038-02-28T23:59:59.999Z' },
    ])('returns $name as an empty page', async ({ from, to }) => {
      const res = await get(`${base()}/feed?from=${from}&to=${to}&time_zone=UTC`);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        items: [],
        page_info: { next_cursor: null, previous_cursor: null },
        summary: { count: 0, income: '0.00', expense: '0.00' },
        day_totals: [],
      });
    });
  });
});
