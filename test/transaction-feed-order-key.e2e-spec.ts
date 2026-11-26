import request from 'supertest';

import { type Member, type TestApp, createTestApp, createVerifiedMember, deleteUsers } from './support/app';

interface FeedBody {
  items: { id: string; date: string }[];
  page_info: { next_cursor: string | null; previous_cursor: string | null };
  summary: { count: number; income: string; expense: string };
  day_totals: { date: string; net: string }[];
}

// Ordering keys are BIGINT: past 2^53 a JS number would lose the last digit,
// so a cursor must carry them as text. A record inserted with such a key
// moves the AUTO_INCREMENT counter past it, so the records created after it
// get larger keys, as a long-lived database would give them.
describe('Transactions feed ordering keys and the last date (e2e)', () => {
  let testApp: TestApp;
  let owner: Member;
  let categoryId: number;
  const ids: Record<string, string> = {};
  const BEYOND_SAFE_INTEGER = '9007199254740993';

  const get = (url: string) =>
    request(testApp.app.getHttpServer()).get(url).set('Authorization', `Bearer ${owner.token}`);
  const base = () => `/api/v2/spaces/${owner.spaceId}/transactions`;
  const feed = async (params: Record<string, string | number>): Promise<FeedBody> =>
    (await get(`${base()}/feed?${new URLSearchParams(params as never).toString()}`).expect(200)).body;
  const itemIds = (body: FeedBody) => body.items.map((item) => item.id);

  async function create(key: string, date: string): Promise<void> {
    const res = await request(testApp.app.getHttpServer())
      .post(base())
      .set('Authorization', `Bearer ${owner.token}`)
      .send({
        category_id: categoryId,
        transaction_type: 'expense',
        amount: '1.00',
        date,
        time_zone: 'UTC',
        description: key,
        assignment: { kind: 'space' },
      })
      .expect(201);
    ids[key] = res.body.transaction.id;
  }

  // beyond: the next key, but at least 2^53 + 1; otherwise the AUTO_INCREMENT one
  async function insert(key: string, date: string, beyond = false): Promise<void> {
    const [{ id }] = await testApp.dataSource.query('SELECT UUID() AS id');
    await testApp.dataSource.query(
      `INSERT INTO transactions (id, space_id, category_id, transaction_type, amount, date, order_key, description,
         author_user_id, author_source, assignment_kind)
       SELECT ?, ?, ?, 'expense', '1.00', ?,
              ${beyond ? 'GREATEST(COALESCE(top.order_key, 0) + 1, CAST(? AS UNSIGNED))' : 'NULL'},
              ?, ?, 'recorded', 'space'
       FROM (SELECT MAX(order_key) AS order_key FROM transactions) top`,
      [id, owner.spaceId, categoryId, date, ...(beyond ? [BEYOND_SAFE_INTEGER] : []), key, owner.userId],
    );
    ids[key] = id;
  }

  beforeAll(async () => {
    testApp = await createTestApp();
    owner = await createVerifiedMember(testApp, 'feed-order-key');
    categoryId = (await get(`/api/v1/spaces/${owner.spaceId}/categories`).expect(200)).body.expenses[0].id;

    await create('first', '2026-01-15');
    await insert('beyond', '2026-01-15', true);
    await create('after', '2026-01-15');
    await insert('lastDay', '9999-12-31');
  });

  afterAll(async () => {
    try {
      await deleteUsers(testApp.dataSource, [owner?.userId].filter(Boolean));
    } finally {
      await testApp.app.close();
    }
  });

  it('gives records created later larger keys than every existing one', async () => {
    const rows: { description: string; order_key: string }[] = await testApp.dataSource.query(
      "SELECT description, CAST(order_key AS CHAR) AS order_key FROM transactions WHERE space_id = ? AND date = '2026-01-15'",
      [owner.spaceId],
    );
    const keys = Object.fromEntries(rows.map((row) => [row.description, BigInt(row.order_key)]));

    expect(keys.beyond >= BigInt(BEYOND_SAFE_INTEGER)).toBe(true);
    expect(keys.first < keys.beyond && keys.beyond < keys.after).toBe(true);
  });

  it('pages one record at a time through keys beyond the safe integers, losing and repeating none', async () => {
    const day = { from_date: '2026-01-15', to_date: '2026-01-15' };
    const seen: string[] = [];
    let page = await feed({ ...day, limit: 1 });
    seen.push(...itemIds(page));

    while (page.page_info.next_cursor) {
      page = await feed({ ...day, limit: 1, cursor: page.page_info.next_cursor });
      seen.push(...itemIds(page));
    }

    expect(seen).toEqual([ids.after, ids.beyond, ids.first]);

    const back: string[] = [];
    while (page.page_info.previous_cursor) {
      page = await feed({ ...day, limit: 1, cursor: page.page_info.previous_cursor });
      back.unshift(...itemIds(page));
    }

    expect(back).toEqual([ids.after, ids.beyond]);
  });

  it('opens the history around a record with such a key', async () => {
    const page = await feed({ from_date: '2026-01-01', to_date: '2026-01-31', limit: 3, around_id: ids.beyond });

    expect(itemIds(page)).toEqual([ids.after, ids.beyond, ids.first]);
  });

  it('reads the last date of the DATE range, on the home screen and in the feed', async () => {
    const latest = await get(`${base()}/latest`).expect(200);
    const page = await feed({ from_date: '9999-12-31', to_date: '9999-12-31' });

    expect(latest.body).toMatchObject({ id: ids.lastDay, date: '9999-12-31' });
    expect(itemIds(page)).toEqual([ids.lastDay]);
    expect(page.day_totals).toEqual([{ date: '9999-12-31', net: '-1.00' }]);
  });
});
