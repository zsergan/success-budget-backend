import { createHash, randomUUID } from 'node:crypto';
import request from 'supertest';

import { encodeFeedCursor } from '@modules/transactions/feed-cursor';

import {
  type Member,
  type TestApp,
  createTestApp,
  createVerifiedMember,
  deleteUsers,
  insertLegacyTransaction,
} from './support/app';
import { createOpenApiDocument, okResponseSchema, schemaErrors } from './support/openapi';

interface Item {
  id: string;
  amount: string;
  transaction_type: string;
  kind: string;
  author: { user_id: number | null; status: string; source: string };
  assignment: { kind: string; user_id: number | null; status: string | null };
}

interface BreakdownItem {
  kind: string;
  key: string;
  amount: string;
  opens_history: boolean;
  status?: string | null;
  children?: BreakdownItem[];
}

// October 2026 in Berlin: DST ends on the 25th, so that day lasts 25 hours.
const OCTOBER = { from: '2026-09-30T22:00:00.000Z', to: '2026-10-31T22:59:59.999Z', time_zone: 'Europe/Berlin' };
const MONTH = { period: 'month', anchor_date: '2026-10-15', time_zone: 'Europe/Berlin', as_of: '2026-11-10T00:00:00Z' };

// Reads of the v2 API over space-owned records (docs/transactions-v2-contract.md).
describe('Transactions v2 reads and statistics (e2e)', () => {
  let testApp: TestApp;
  const userIds: number[] = [];

  let owner: Member;
  let lena: Member;
  let mark: Member;
  let gone: Member;
  let spaceId: number;
  let groceries: number;
  let eatingOut: number;
  let salary: number;
  let archived: number;
  const ids: Record<string, string> = {};

  function api(member: Member) {
    const agent = request(testApp.app.getHttpServer());

    return {
      get: (url: string) => agent.get(url).set('Authorization', `Bearer ${member.token}`),
      post: (url: string) => agent.post(url).set('Authorization', `Bearer ${member.token}`),
      patch: (url: string) => agent.patch(url).set('Authorization', `Bearer ${member.token}`),
      delete: (url: string) => agent.delete(url).set('Authorization', `Bearer ${member.token}`),
    };
  }

  const v2 = (path = '') => `/api/v2/spaces/${spaceId}${path}`;
  const forUser = (member: Member) => ({ kind: 'member', user_id: member.userId });

  async function add(
    key: string,
    by: Member,
    assignment: object,
    amount: string,
    timestamp: string,
    category = groceries,
    type = 'expense',
    description: string | null = null,
  ) {
    const created = await api(by)
      .post(v2('/transactions'))
      .send({ category_id: category, transaction_type: type, amount, timestamp, assignment, description })
      .expect(201);
    ids[key] = created.body.transaction.id;
  }

  async function feedAll(query: object, limit = 2) {
    const items: Item[] = [];
    let cursor: string | null = null;
    let first: { summary: unknown; day_totals: { date: string; net: string }[] } | null = null;
    const days = new Map<string, string>();

    do {
      const page: request.Response = await api(owner)
        .get(v2('/transactions/feed'))
        .query({ ...OCTOBER, ...query, limit, ...(cursor === null ? {} : { cursor }) })
        .expect(200);
      first ??= page.body;
      items.push(...page.body.items);
      page.body.day_totals.forEach((day: { date: string; net: string }) => days.set(day.date, day.net));
      cursor = page.body.page_info.next_cursor;
    } while (cursor);

    return { items, summary: first!.summary, days };
  }

  const cents = (amount: string) => Math.round(Number(amount) * 100);
  const sum = (items: Item[], type: string) =>
    (
      items
        .filter((item) => item.transaction_type === type && item.kind === 'regular')
        .reduce((total, item) => total + cents(item.amount), 0) / 100
    ).toFixed(2);

  beforeAll(async () => {
    testApp = await createTestApp();
    owner = await createVerifiedMember(testApp, 'v2r-owner');
    lena = await createVerifiedMember(testApp, 'v2r-lena');
    mark = await createVerifiedMember(testApp, 'v2r-mark');
    gone = await createVerifiedMember(testApp, 'v2r-gone');
    userIds.push(owner.userId, lena.userId, mark.userId, gone.userId);
    await testApp.dataSource.query('UPDATE users SET name = ? WHERE id = ?', ['Lena', lena.userId]);
    await testApp.dataSource.query('UPDATE users SET name = ? WHERE id = ?', ['Mark', mark.userId]);

    const space = await api(owner)
      .post('/api/v1/spaces')
      .send({ name: 'Family', type: 'group', currency_id: testApp.currencyId })
      .expect(201);
    spaceId = space.body.id;

    for (const member of [lena, mark, gone]) {
      await testApp.dataSource.query("INSERT INTO space_members (space_id, user_id, role) VALUES (?, ?, 'member')", [
        spaceId,
        member.userId,
      ]);
    }

    const categories = await api(owner).get(`/api/v1/spaces/${spaceId}/categories`).expect(200);
    const named = (list: { id: number; name: string }[], name: string) => list.find((c) => c.name === name)!.id;
    groceries = named(categories.body.expenses, 'Groceries');
    eatingOut = named(categories.body.expenses, 'Eating out');
    archived = named(categories.body.expenses, 'Travel');
    salary = named(categories.body.incomes, 'Salary');

    // a starting balance a wallet left, at the very start of October in Berlin
    const [system] = await testApp.dataSource.query('SELECT id FROM categories WHERE space_id = ? AND is_system = 1', [
      spaceId,
    ]);
    ids.initial = randomUUID();
    await insertLegacyTransaction(testApp.dataSource, {
      id: ids.initial,
      spaceId,
      categoryId: system.id,
      type: 'income',
      amount: '500.00',
      timestamp: new Date('2026-09-30T22:00:00.000Z'),
    });

    await add('ownerGroceries', owner, forUser(owner), '1450.00', '2026-10-03T10:00:00.000Z');
    await add('rent', lena, { kind: 'space' }, '1100.00', '2026-10-01T08:00:00.000Z', eatingOut);
    await add('lenaLunch', owner, forUser(lena), '450.00', '2026-10-25T00:30:00.000Z', eatingOut, 'expense', 'Lunch');
    await add('cafe', mark, { kind: 'unassigned' }, '150.00', '2026-10-25T23:30:00.000Z', groceries, 'expense', 'Café');
    await add('markTrip', mark, forUser(mark), '40.00', '2026-10-31T22:59:59.999Z', archived);
    await add('goneGift', owner, forUser(gone), '20.00', '2026-10-10T12:00:00.000Z');
    await add('salary', lena, { kind: 'space' }, '3000.00', '2026-10-02T07:00:00.000Z', salary, 'income');
    await add('november', owner, forUser(owner), '9.00', '2026-10-31T23:00:00.000Z');
    // imported from wallets: the whole space, the earliest member as the author
    await insertLegacyTransaction(testApp.dataSource, {
      spaceId,
      categoryId: groceries,
      type: 'expense',
      amount: '30.00',
      timestamp: new Date('2026-10-15T12:00:00.000Z'),
      description: 'Imported',
    });
    await testApp.dataSource.query(`UPDATE categories SET is_active = 0, archived_at = NOW() WHERE id = ?`, [archived]);

    // Mark leaves; the account of `gone` is deleted with its personal space
    await api(owner).delete(`/api/v1/spaces/${spaceId}/members/${mark.userId}`).expect(200);
    await testApp.dataSource.query('DELETE FROM space_members WHERE space_id = ? AND user_id = ?', [
      spaceId,
      gone.userId,
    ]);
    await deleteUsers(testApp.dataSource, [gone.userId]);
  });

  afterAll(async () => {
    try {
      await deleteUsers(testApp.dataSource, userIds);
    } finally {
      await testApp.app.close();
    }
  });

  describe('records', () => {
    it('tells members, former members, deleted accounts and imported authors apart', async () => {
      const { items } = await feedAll({}, 100);
      const byId = new Map(items.map((item) => [item.id, item]));

      expect(byId.get(ids.markTrip)).toMatchObject({
        author: { user_id: mark.userId, status: 'former_member', source: 'recorded' },
        assignment: { kind: 'member', user_id: mark.userId, status: 'former_member' },
      });
      expect(byId.get(ids.goneGift)).toMatchObject({
        author: { user_id: owner.userId, status: 'member' },
        assignment: { kind: 'member', user_id: null, status: 'deleted' },
      });
      expect(byId.get(ids.cafe)?.assignment).toEqual({ kind: 'unassigned', user_id: null, name: null, status: null });
      expect(items.find((item) => item.author.source === 'imported')).toMatchObject({
        author: { user_id: owner.userId, status: 'member', source: 'imported' },
        assignment: { kind: 'space' },
      });
      expect(byId.get(ids.initial)).toMatchObject({ kind: 'initial_balance', assignment: { kind: 'space' } });
    });

    it('matches the OpenAPI schemas of the feed and the assignees', async () => {
      const document = createOpenApiDocument(testApp.app);
      const feed = await api(owner)
        .get(v2('/transactions/feed'))
        .query({ ...OCTOBER, limit: 100 })
        .expect(200);
      const assignees = await api(owner).get(v2('/transactions/assignees')).expect(200);

      expect(
        schemaErrors(document, okResponseSchema(document, 'v2/spaces/{spaceId}/transactions/feed'), feed.body),
      ).toEqual([]);
      expect(
        schemaErrors(
          document,
          okResponseSchema(document, 'v2/spaces/{spaceId}/transactions/assignees'),
          assignees.body,
        ),
      ).toEqual([]);
    });
  });

  describe('assignment filter', () => {
    it.each([
      ['a member', () => `member:${owner.userId}`, ['ownerGroceries']],
      ['a former member', () => `member:${mark.userId}`, ['markTrip']],
      ['deleted accounts', () => 'deleted_member', ['goneGift']],
      ['nobody', () => 'unassigned', ['cafe']],
    ])('selects the records of %s, with totals of exactly them', async (_label, assignment, keys) => {
      const { items, summary } = await feedAll({ assignment: assignment() });

      expect(items.map((item) => item.id).sort()).toEqual(keys.map((key) => ids[key]).sort());
      expect(summary).toEqual({ count: keys.length, income: sum(items, 'income'), expense: sum(items, 'expense') });
    });

    it('selects the whole space apart from unassigned, initial balances and imported records included', async () => {
      const { items, summary } = await feedAll({ assignment: 'space' });

      expect(items).toHaveLength(4);
      expect(items.every((item) => item.assignment.kind === 'space')).toBe(true);
      expect(summary).toEqual({ count: 4, income: '3000.00', expense: '1130.00' });
    });

    it('counts like the feed and nets each local day over the filtered records only', async () => {
      const { items, summary, days } = await feedAll({ assignment: 'unassigned', transaction_type: 'expense' }, 1);
      const count = await api(owner)
        .get(v2('/transactions/count'))
        .query({ from: OCTOBER.from, to: OCTOBER.to, assignment: 'unassigned', transaction_type: 'expense' })
        .expect(200);

      expect(count.body.count).toBe((summary as { count: number }).count);
      expect(items).toHaveLength(1);
      // 23:30 UTC on the 25th is the 26th in Berlin after the DST change
      expect([...days.entries()]).toEqual([['2026-10-26', '-150.00']]);
    });

    it('keeps the day of a 25-hour DST day whole', async () => {
      const { days } = await feedAll({ assignment: `member:${lena.userId}` });

      expect([...days.entries()]).toEqual([['2026-10-25', '-450.00']]);
    });

    it('carries the assignment in the cursor', async () => {
      const page = await api(owner)
        .get(v2('/transactions/feed'))
        .query({ ...OCTOBER, assignment: 'space', limit: 1 })
        .expect(200);
      const cursor = page.body.page_info.next_cursor;

      const other = await api(owner)
        .get(v2('/transactions/feed'))
        .query({ ...OCTOBER, assignment: 'unassigned', limit: 1, cursor })
        .expect(400);
      // a cursor of the retired v1 feed for the same query: its digest had the wallet filter last
      const v1Digest = createHash('sha256')
        .update(
          JSON.stringify([
            spaceId,
            Date.parse(OCTOBER.from),
            Date.parse(OCTOBER.to),
            OCTOBER.time_zone,
            null,
            null,
            null,
            null,
            null,
          ]),
        )
        .digest('base64url');
      const v1Cursor = await api(owner)
        .get(v2('/transactions/feed'))
        .query({
          ...OCTOBER,
          limit: 1,
          cursor: encodeFeedCursor(
            { direction: 'older', position: { timestamp: new Date('2026-10-25T00:30:00.000Z'), id: ids.lenaLunch } },
            v1Digest,
          ),
        })
        .expect(400);

      expect(other.body.message).toEqual([{ field: 'cursor', error: 'cursor does not belong to this query' }]);
      expect(v1Cursor.body.message).toEqual([{ field: 'cursor', error: 'cursor does not belong to this query' }]);
    });

    it('refuses a user never assigned in the space, and a malformed value', async () => {
      const outsider = await api(owner)
        .get(v2('/transactions/feed'))
        .query({ ...OCTOBER, assignment: `member:${lena.userId + 100000}` })
        .expect(403);
      const malformed = await api(owner)
        .get(v2('/transactions/count'))
        .query({ from: OCTOBER.from, to: OCTOBER.to, assignment: 'wallet:3' })
        .expect(400);

      expect(outsider.body.code).toBe('FORBIDDEN_MEMBER');
      expect(malformed.body.message).toEqual([expect.objectContaining({ field: 'assignment' })]);
    });

    it('refuses the v1 wallet filter', async () => {
      const refused = await api(owner)
        .get(v2('/transactions/feed'))
        .query({ ...OCTOBER, wallet_id: 7 })
        .expect(400);

      expect(refused.body.message).toEqual([expect.objectContaining({ field: 'wallet_id' })]);
    });
  });

  describe('search', () => {
    it('matches descriptions and category names, not wallet or people names', async () => {
      const search = async (q: string) =>
        (
          await api(owner)
            .get(v2('/transactions/feed'))
            .query({ ...OCTOBER, q, limit: 100 })
            .expect(200)
        ).body.items.map((item: Item) => item.id);

      expect(await search('cafe')).toEqual([ids.cafe]);
      expect(await search('travel')).toEqual([ids.markTrip]);
      expect(await search('Card')).toEqual([]);
      expect(await search('Lena')).toEqual([]);
    });
  });

  describe('periods', () => {
    it('reads an empty month and a month with only a starting balance', async () => {
      const empty = await api(owner)
        .get(v2('/transactions/feed'))
        .query({ from: '2026-07-31T22:00:00.000Z', to: '2026-08-31T21:59:59.999Z', time_zone: 'Europe/Berlin' })
        .expect(200);
      const firstMillisecond = await api(owner)
        .get(v2('/transactions/feed'))
        .query({ from: '2026-09-30T22:00:00.000Z', to: '2026-09-30T22:00:00.000Z', time_zone: 'Europe/Berlin' })
        .expect(200);

      expect(empty.body).toEqual({
        items: [],
        page_info: { next_cursor: null, previous_cursor: null },
        summary: { count: 0, income: '0.00', expense: '0.00' },
        day_totals: [],
      });
      expect(firstMillisecond.body.summary).toEqual({ count: 1, income: '0.00', expense: '0.00' });
      expect(firstMillisecond.body.day_totals).toEqual([{ date: '2026-10-01', net: '0.00' }]);
    });

    it('keeps the last millisecond of the month in and the next one out', async () => {
      const { items } = await feedAll({}, 100);

      expect(items.map((item) => item.id)).toContain(ids.markTrip);
      expect(items.map((item) => item.id)).not.toContain(ids.november);
    });
  });

  describe('assignees', () => {
    it('lists members, former members with records, and deleted accounts', async () => {
      const { body } = await api(lena).get(v2('/transactions/assignees')).expect(200);

      expect(body).toEqual({
        members: [
          { key: `member:${owner.userId}`, user_id: owner.userId, name: 'E2E', status: 'member' },
          { key: `member:${lena.userId}`, user_id: lena.userId, name: 'Lena', status: 'member' },
        ],
        former_members: [{ key: `member:${mark.userId}`, user_id: mark.userId, name: 'Mark', status: 'former_member' }],
        has_deleted_members: true,
      });
    });
  });

  describe('statistics v2', () => {
    const breakdown = async (type = 'expense') =>
      (
        await api(owner)
          .get(v2('/statistics/breakdown'))
          .query({ ...MONTH, transaction_type: type })
          .expect(200)
      ).body;

    it('adds up the assignment groups exactly to the expenses, starting balances left out', async () => {
      const [summary, body] = await Promise.all([
        api(owner).get(v2('/statistics/summary')).query(MONTH).expect(200),
        breakdown(),
      ]);

      expect(summary.body.expense).toEqual({ amount: '3240.00', count: 7 });
      expect(summary.body.income).toEqual({ amount: '3000.00', count: 1 });
      expect(body.total).toEqual(summary.body.expense);
      expect(body.by_assignment.total_amount).toBe('3240.00');
      expect(body.by_category.total_amount).toBe('3240.00');
      expect(body).not.toHaveProperty('by_wallet');

      const items: BreakdownItem[] = [
        ...body.by_assignment.primary_items,
        ...(body.by_assignment.other?.children ?? []),
      ];
      expect(Object.fromEntries(items.map((item) => [item.key, item.amount]))).toEqual({
        [`member:${owner.userId}`]: '1450.00',
        space: '1130.00',
        [`member:${lena.userId}`]: '450.00',
        unassigned: '150.00',
        [`member:${mark.userId}`]: '40.00',
        deleted_member: '20.00',
      });
      expect(body.by_assignment.primary_items.map((item: BreakdownItem) => item.key)).toEqual(
        expect.arrayContaining(['space', 'unassigned']),
      );
    });

    it('opens every item into a history whose total is its amount', async () => {
      const body = await breakdown();
      const items: BreakdownItem[] = [
        ...body.by_assignment.primary_items,
        ...(body.by_assignment.other?.children ?? []),
      ];

      for (const item of items) {
        const feed = await api(owner)
          .get(v2('/transactions/feed'))
          .query({
            from: body.period.from,
            to: body.period.actual_to,
            time_zone: body.period.time_zone,
            transaction_type: body.transaction_type,
            kind: 'regular',
            assignment: item.key,
          })
          .expect(200);

        expect([item.key, feed.body.summary.expense]).toEqual([item.key, item.amount]);
      }
    });

    it('groups income by assignment too', async () => {
      const body = await breakdown('income');

      expect(body.by_assignment.primary_items).toEqual([expect.objectContaining({ key: 'space', amount: '3000.00' })]);
    });

    it('no longer serves the v1 breakdown by wallet', async () => {
      const { body } = await api(owner).get(`/api/v1/spaces/${spaceId}/statistics/breakdown`).query(MONTH).expect(410);

      expect(body.code).toBe('LEGACY_API_RETIRED');
    });

    it('matches the OpenAPI schema', async () => {
      const document = createOpenApiDocument(testApp.app);

      expect(
        schemaErrors(
          document,
          okResponseSchema(document, 'v2/spaces/{spaceId}/statistics/breakdown'),
          await breakdown(),
        ),
      ).toEqual([]);
    });
  });

  describe('limits', () => {
    it('count every expense of the space, whoever it is assigned to', async () => {
      await api(owner).post(`/api/v1/spaces/${spaceId}/limits`).send({ category_ids: [], amount: '5000' }).expect(201);
      const now = new Date().toISOString();
      const { body: before } = await api(owner)
        .get(`/api/v1/spaces/${spaceId}/limits`)
        .query({ time_zone: 'UTC' })
        .expect(200);

      await add('limitLena', owner, forUser(lena), '11.00', now);
      await add('limitSpace', owner, { kind: 'space' }, '22.00', now);
      await add('limitNobody', owner, { kind: 'unassigned' }, '33.00', now);
      const { body: after } = await api(owner)
        .get(`/api/v1/spaces/${spaceId}/limits`)
        .query({ time_zone: 'UTC' })
        .expect(200);

      expect(Math.round((after.total.spent - before.total.spent) * 100)).toBe(6600);
    });
  });
});
