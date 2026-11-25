import request from 'supertest';

import {
  type Member,
  type TestApp,
  createTestApp,
  createVerifiedMember,
  deleteUsers,
  insertLegacyTransaction,
  shiftDate,
  today,
} from './support/app';
import { createOpenApiDocument, okResponseSchema, schemaErrors } from './support/openapi';
import { calendarDateIn, monthPeriodAt } from '@shared/utils';
import { TransactionQueriesService } from '@modules/transaction-queries/transaction-queries.service';

const dayBefore = (date: string) => shiftDate(date, -1);
const dayAfter = (date: string) => shiftDate(date, 1);

describe('Transactions (e2e)', () => {
  let testApp: TestApp;
  let owner: Member;
  let outsider: Member;
  let expenseCategoryId: number;
  let secondExpenseCategoryId: number;
  let incomeCategoryId: number;

  beforeAll(async () => {
    testApp = await createTestApp();
    owner = await createVerifiedMember(testApp, 'transactions-owner');
    outsider = await createVerifiedMember(testApp, 'transactions-outsider');

    const categories = await api(owner)
      .get(`${base(owner)}/categories`)
      .expect(200);
    expenseCategoryId = categories.body.expenses[0].id;
    secondExpenseCategoryId = categories.body.expenses[1].id;
    incomeCategoryId = categories.body.incomes[0].id;
  });

  afterEach(() => {
    jest.restoreAllMocks();
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

  function transactions(member: Member): string {
    return `/api/v2/spaces/${member.spaceId}/transactions`;
  }

  function api(member: Member) {
    const agent = request(testApp.app.getHttpServer());
    const withAuth =
      (method: 'get' | 'post' | 'patch' | 'delete') =>
      (url: string): request.Test =>
        agent[method](url).set('Authorization', `Bearer ${member.token}`);

    return { get: withAuth('get'), post: withAuth('post'), patch: withAuth('patch'), delete: withAuth('delete') };
  }

  // a starting balance a wallet left in the history of the space
  async function startingBalance(member: Member, amount: string, date = today()): Promise<string> {
    const [system] = await testApp.dataSource.query('SELECT id FROM categories WHERE space_id = ? AND is_system = 1', [
      member.spaceId,
    ]);
    const [{ id }] = await testApp.dataSource.query('SELECT UUID() AS id');
    await insertLegacyTransaction(testApp.dataSource, {
      id,
      spaceId: member.spaceId,
      categoryId: system.id,
      type: 'income',
      amount,
      date,
    });

    return id;
  }

  async function createTransaction(member: Member, categoryId = expenseCategoryId) {
    const res = await api(member)
      .post(transactions(member))
      .send({
        category_id: categoryId,
        transaction_type: 'expense',
        amount: '12.3',
        date: '2026-09-15',
        time_zone: 'UTC',
        description: 'Lunch',
        assignment: { kind: 'space' },
      })
      .expect(201);

    return res.body.transaction.id as string;
  }

  async function foreignTransaction(): Promise<string> {
    const categories = await api(outsider)
      .get(`${base(outsider)}/categories`)
      .expect(200);

    return createTransaction(outsider, categories.body.expenses[0].id);
  }

  describe('GET /transactions/:id', () => {
    it('returns the same view as the feed, as the OpenAPI schema describes', async () => {
      const id = await createTransaction(owner);

      const res = await api(owner)
        .get(`${transactions(owner)}/${id}`)
        .expect(200);
      const feed = await api(owner)
        .get(`${transactions(owner)}/feed`)
        .query({ from_date: '2026-09-01', to_date: '2026-09-30' })
        .expect(200);

      expect(res.body).toEqual(feed.body.items.find((item: { id: string }) => item.id === id));
      expect(res.body).toEqual({
        id,
        kind: 'regular',
        transaction_type: 'expense',
        amount: '12.30',
        date: '2026-09-15',
        description: 'Lunch',
        version: 1,
        category: expect.objectContaining({ id: expenseCategoryId, is_active: 1, is_archived: false }),
        author: { user_id: owner.userId, name: 'E2E', status: 'member', source: 'recorded' },
        assignment: { kind: 'space', user_id: null, name: null, status: null },
      });

      const document = createOpenApiDocument(testApp.app);
      expect(schemaErrors(document, okResponseSchema(document, '/transactions/{transactionId}'), res.body)).toEqual([]);
    });

    it('reads a starting balance as a system record', async () => {
      const id = await startingBalance(owner, '25');

      const res = await api(owner)
        .get(`${transactions(owner)}/${id}`)
        .expect(200);

      expect(res.body).toEqual(
        expect.objectContaining({ kind: 'initial_balance', transaction_type: 'income', amount: '25.00' }),
      );
    });

    it('reads a transaction of an archived category', async () => {
      const category = await api(owner)
        .post(`${base(owner)}/categories`)
        .send({ name: 'Short-lived', transaction_type: 'expense', icon: 'Other', color: 'slate' })
        .expect(201);
      const id = await createTransaction(owner, category.body.id);
      await api(owner)
        .delete(`${base(owner)}/categories/${category.body.id}`)
        .expect(200);

      const res = await api(owner)
        .get(`${transactions(owner)}/${id}`)
        .expect(200);

      expect(res.body.category).toEqual(expect.objectContaining({ id: category.body.id, is_archived: true }));
    });

    it('does not reveal a transaction of another space', async () => {
      const foreignId = await foreignTransaction();

      const foreign = await api(owner)
        .get(`${transactions(owner)}/${foreignId}`)
        .expect(404);
      const missing = await api(owner)
        .get(`${transactions(owner)}/00000000-0000-0000-0000-000000000000`)
        .expect(404);
      const malformed = await api(owner)
        .get(`${transactions(owner)}/not-a-uuid`)
        .expect(404);

      for (const res of [foreign, missing, malformed]) {
        expect(res.body).toEqual(
          expect.objectContaining({ statusCode: 404, code: 'TRANSACTION_NOT_FOUND', message: 'Transaction not found' }),
        );
      }
    });

    it('refuses a non-member with the space access error, whatever the transaction', async () => {
      const id = await createTransaction(owner);

      for (const transactionId of [id, 'not-a-uuid']) {
        const res = await api(outsider)
          .get(`${transactions(owner)}/${transactionId}`)
          .expect(403);

        expect(res.body).toEqual(expect.objectContaining({ statusCode: 403, code: 'FORBIDDEN_SPACE' }));
      }
    });

    it('answers an unexpected failure in the API error shape, with the request id and no details', async () => {
      jest
        .spyOn(testApp.app.get(TransactionQueriesService), 'getLatest')
        .mockRejectedValueOnce(new Error('connect ECONNREFUSED 10.0.0.5:3306'));

      const res = await api(owner)
        .get(`${transactions(owner)}/latest`)
        .expect(500);

      expect(res.body).toEqual({
        timestamp: expect.any(String),
        path: `${transactions(owner)}/latest`,
        requestId: res.headers['x-request-id'],
        statusCode: 500,
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Internal server error',
      });
      expect(res.body.requestId).toEqual(expect.any(String));
    });

    it('requires authentication', async () => {
      const res = await request(testApp.app.getHttpServer())
        .get(`${transactions(owner)}/latest`)
        .expect(401);

      expect(res.body.code).toBe('UNAUTHORIZED');
    });
  });

  describe('DELETE /transactions/:id', () => {
    async function exists(id: string): Promise<boolean> {
      const rows: unknown[] = await testApp.dataSource.query('SELECT id FROM transactions WHERE id = ?', [id]);
      return rows.length > 0;
    }

    it('deletes with the version the client read, and a repeat is not found', async () => {
      const id = await createTransaction(owner);

      const res = await api(owner)
        .delete(`${transactions(owner)}/${id}`)
        .set('If-Match', '"1"')
        .expect(200);
      expect(res.text).toBe('true');
      expect(await exists(id)).toBe(false);

      const repeat = await api(owner)
        .delete(`${transactions(owner)}/${id}`)
        .set('If-Match', '"1"')
        .expect(404);
      expect(repeat.body.code).toBe('TRANSACTION_NOT_FOUND');
    });

    it('requires If-Match and keeps the record without it', async () => {
      const id = await createTransaction(owner);

      const res = await api(owner)
        .delete(`${transactions(owner)}/${id}`)
        .expect(428);

      expect(res.body.code).toBe('TRANSACTION_VERSION_REQUIRED');
      expect(await exists(id)).toBe(true);
    });

    it('refuses a stale version and keeps the record', async () => {
      const id = await createTransaction(owner);
      await testApp.dataSource.query('UPDATE transactions SET version = 2 WHERE id = ?', [id]);

      const res = await api(owner)
        .delete(`${transactions(owner)}/${id}`)
        .set('If-Match', '"1"')
        .expect(409);

      expect(res.body).toEqual(expect.objectContaining({ statusCode: 409, code: 'TRANSACTION_VERSION_CONFLICT' }));
      expect(await exists(id)).toBe(true);
    });

    it('rejects a malformed If-Match before looking the record up', async () => {
      const res = await api(outsider)
        .delete(`${transactions(owner)}/not-a-uuid`)
        .set('If-Match', 'W/"1"')
        .expect(400);

      expect(res.body).toEqual(
        expect.objectContaining({
          code: 'VALIDATION_FAILED',
          message: [{ field: 'If-Match', error: 'If-Match must be a record version, e.g. "3"' }],
        }),
      );
    });

    it('refuses a starting balance', async () => {
      const id = await startingBalance(owner, '25');

      const res = await api(owner)
        .delete(`${transactions(owner)}/${id}`)
        .set('If-Match', '"1"')
        .expect(400);

      expect(res.body).toEqual(expect.objectContaining({ statusCode: 400, code: 'TRANSACTION_IS_SYSTEM' }));
      expect(await exists(id)).toBe(true);
    });

    it('does not reveal or delete a transaction of another space', async () => {
      const foreignId = await foreignTransaction();

      for (const id of [foreignId, '00000000-0000-0000-0000-000000000000', 'not-a-uuid']) {
        const res = await api(owner)
          .delete(`${transactions(owner)}/${id}`)
          .set('If-Match', '"1"')
          .expect(404);

        expect(res.body.code).toBe('TRANSACTION_NOT_FOUND');
      }
      expect(await exists(foreignId)).toBe(true);
    });

    it('refuses a non-member with the space access error', async () => {
      const id = await createTransaction(owner);

      const res = await api(outsider)
        .delete(`${transactions(owner)}/${id}`)
        .set('If-Match', '"1"')
        .expect(403);

      expect(res.body.code).toBe('FORBIDDEN_SPACE');
      expect(await exists(id)).toBe(true);
    });
  });

  describe('POST /transactions', () => {
    const body = (overrides: Record<string, unknown> = {}) => ({
      category_id: expenseCategoryId,
      transaction_type: 'expense',
      amount: '12.3',
      date: '2026-09-15',
      time_zone: 'UTC',
      assignment: { kind: 'space' },
      ...overrides,
    });

    it('returns the created transaction as GET /:id reads it', async () => {
      const res = await api(owner)
        .post(transactions(owner))
        .send(body({ description: '  Lunch  ' }))
        .expect(201);
      const read = await api(owner)
        .get(`${transactions(owner)}/${res.body.transaction.id}`)
        .expect(200);

      expect(res.body).toEqual({ transaction: read.body });
      expect(res.body.transaction).toEqual(expect.objectContaining({ amount: '12.30', description: 'Lunch' }));
      const document = createOpenApiDocument(testApp.app);
      expect(schemaErrors(document, okResponseSchema(document, '/transactions', 'post'), res.body)).toEqual([]);
    });

    it.each<[string, Record<string, unknown>, string]>([
      ['a zero amount', { amount: '0.00' }, 'amount must be greater than 0'],
      ['a date after today', { date: dayAfter(today()) }, 'date must not be after today in time_zone'],
      [
        'a date with a time',
        { date: '2026-09-15T10:00:00.000Z' },
        'date must be a calendar date as YYYY-MM-DD from 1000-01-01 to 9999-12-31',
      ],
      [
        'a timestamp of an earlier release',
        { timestamp: '2026-09-15T10:00:00.000Z' },
        'property timestamp should not exist',
      ],
      [
        'a description over 140 characters',
        { description: 'x'.repeat(141) },
        'description must be at most 140 characters',
      ],
    ])('refuses %s', async (_, overrides, error) => {
      const res = await api(owner).post(transactions(owner)).send(body(overrides)).expect(400);

      expect(res.body).toEqual(
        expect.objectContaining({ code: 'VALIDATION_FAILED', message: [{ field: Object.keys(overrides)[0], error }] }),
      );
    });

    it('accepts today in the zone of the writer and 140 emoji', async () => {
      const res = await api(owner)
        .post(transactions(owner))
        .send(
          body({
            date: calendarDateIn(new Date(), 'Pacific/Kiritimati'),
            time_zone: 'Pacific/Kiritimati',
            description: '🙂'.repeat(140),
          }),
        )
        .expect(201);

      expect([...res.body.transaction.description]).toHaveLength(140);
      expect(res.body.transaction.date).toBe(calendarDateIn(new Date(), 'Pacific/Kiritimati'));
    });

    it('stores a blank description as null', async () => {
      const res = await api(owner)
        .post(transactions(owner))
        .send(body({ description: '   ' }))
        .expect(201);
      const [row] = await testApp.dataSource.query('SELECT description FROM transactions WHERE id = ?', [
        res.body.transaction.id,
      ]);

      expect(row.description).toBeNull();
    });

    it('refuses a category of the other type and an archived category', async () => {
      const archived = await api(owner)
        .post(`${base(owner)}/categories`)
        .send({ name: 'Old', transaction_type: 'expense', icon: 'Other', color: 'slate' })
        .expect(201);
      // with history, deleting a category archives it
      await createTransaction(owner, archived.body.id);
      await api(owner)
        .delete(`${base(owner)}/categories/${archived.body.id}`)
        .expect(200);

      const mismatch = await api(owner)
        .post(transactions(owner))
        .send(body({ category_id: incomeCategoryId }))
        .expect(400);
      const archivedRes = await api(owner)
        .post(transactions(owner))
        .send(body({ category_id: archived.body.id }))
        .expect(400);

      expect(mismatch.body.code).toBe('CATEGORY_TYPE_MISMATCH');
      expect(archivedRes.body.code).toBe('CATEGORY_ARCHIVED');
    });
  });

  describe('PATCH /transactions/:id', () => {
    function patch(id: string, version: number | null, body: object): request.Test {
      const req = api(owner).patch(`${transactions(owner)}/${id}`);
      return (version === null ? req : req.set('If-Match', `"${version}"`)).send(body);
    }

    it('changes the amount, bumps the version and returns what GET /:id reads, as the schema describes', async () => {
      const id = await createTransaction(owner);

      const res = await patch(id, 1, { amount: '20' }).expect(200);
      const read = await api(owner)
        .get(`${transactions(owner)}/${id}`)
        .expect(200);

      expect(res.body).toEqual({ transaction: read.body });
      expect(read.body).toEqual(expect.objectContaining({ amount: '20.00', version: 2 }));

      const document = createOpenApiDocument(testApp.app);
      expect(
        schemaErrors(document, okResponseSchema(document, '/transactions/{transactionId}', 'patch'), res.body),
      ).toEqual([]);
    });

    it('changes the type together with a matching category, and refuses a mismatch', async () => {
      const id = await createTransaction(owner);

      const mismatch = await patch(id, 1, { transaction_type: 'income' }).expect(400);
      expect(mismatch.body.code).toBe('CATEGORY_TYPE_MISMATCH');

      const res = await patch(id, 1, { transaction_type: 'income', category_id: incomeCategoryId }).expect(200);

      expect(res.body.transaction).toEqual(
        expect.objectContaining({
          transaction_type: 'income',
          category: expect.objectContaining({ id: incomeCategoryId }),
        }),
      );
    });

    it('moves the transaction between periods and categories in statistics', async () => {
      const id = await createTransaction(owner);
      const summary = async (anchor: string) =>
        (
          await api(owner)
            .get(`/api/v2/spaces/${owner.spaceId}/statistics/breakdown`)
            .query({ period: 'month', time_zone: 'UTC', anchor_date: anchor })
            .expect(200)
        ).body;
      const amountOf = (
        block: { by_category: { primary_items: { id: number; amount: string }[] } },
        categoryId: number,
      ) => block.by_category.primary_items.find((item) => item.id === categoryId)?.amount;
      const before = await summary('2026-08-01');

      await patch(id, 1, { date: '2026-08-20', time_zone: 'UTC', category_id: secondExpenseCategoryId }).expect(200);

      const after = await summary('2026-08-01');
      const previous = Number(amountOf(before, secondExpenseCategoryId) ?? 0);
      expect(Number(amountOf(after, secondExpenseCategoryId))).toBeCloseTo(previous + 12.3, 2);
    });

    it('moves the transaction between assignments in statistics, the author kept', async () => {
      const id = await createTransaction(owner);
      const groups = async () =>
        (
          await api(owner)
            .get(`/api/v2/spaces/${owner.spaceId}/statistics/breakdown`)
            .query({ period: 'month', time_zone: 'UTC', anchor_date: '2026-09-15' })
            .expect(200)
        ).body.by_assignment.primary_items.map((item: { key: string; amount: string }) => [item.key, item.amount]);
      const space = (await groups()).find(([key]: [string]) => key === 'space')[1];

      const res = await patch(id, 1, { assignment: { kind: 'member', user_id: owner.userId } }).expect(200);

      expect(res.body.transaction).toMatchObject({
        version: 2,
        author: { user_id: owner.userId, source: 'recorded' },
        assignment: { kind: 'member', user_id: owner.userId },
      });
      expect(await groups()).toEqual(
        expect.arrayContaining([
          [`member:${owner.userId}`, '12.30'],
          ['space', (Number(space) - 12.3).toFixed(2)],
        ]),
      );
    });

    it('keeps its own archived category while other fields change', async () => {
      const category = await api(owner)
        .post(`${base(owner)}/categories`)
        .send({ name: 'Fading', transaction_type: 'expense', icon: 'Other', color: 'slate' })
        .expect(201);
      const id = await createTransaction(owner, category.body.id);
      await api(owner)
        .delete(`${base(owner)}/categories/${category.body.id}`)
        .expect(200);

      const res = await patch(id, 1, { category_id: category.body.id, description: 'Still here' }).expect(200);

      expect(res.body.transaction).toEqual(
        expect.objectContaining({
          description: 'Still here',
          category: expect.objectContaining({ id: category.body.id, is_archived: true }),
        }),
      );
    });

    it('keeps the version when nothing changes', async () => {
      const id = await createTransaction(owner);

      const res = await patch(id, 1, {
        amount: '12.30',
        description: ' Lunch ',
        date: '2026-09-15',
        time_zone: 'Asia/Tokyo',
        assignment: { kind: 'space' },
      }).expect(200);

      expect(res.body.transaction.version).toBe(1);
    });

    it('keeps a legacy zero amount when another field changes, but refuses setting zero', async () => {
      const id = await createTransaction(owner);
      await testApp.dataSource.query('UPDATE transactions SET amount = 0 WHERE id = ?', [id]);

      const res = await patch(id, 1, { amount: '0', description: 'Legacy' }).expect(200);
      expect(res.body.transaction).toEqual(expect.objectContaining({ amount: '0.00', description: 'Legacy' }));

      const zero = await patch(id, 2, { amount: '5' }).expect(200);
      expect(zero.body.transaction.amount).toBe('5.00');
      const refused = await patch(id, 3, { amount: '0' }).expect(400);
      expect(refused.body.message).toEqual([{ field: 'amount', error: 'amount must be greater than 0' }]);
    });

    it('refuses a stale version and a missing If-Match', async () => {
      const id = await createTransaction(owner);
      await patch(id, 1, { amount: '20' }).expect(200);

      const stale = await patch(id, 1, { amount: '30' }).expect(409);
      const missing = await patch(id, null, { amount: '30' }).expect(428);

      expect(stale.body.code).toBe('TRANSACTION_VERSION_CONFLICT');
      expect(missing.body.code).toBe('TRANSACTION_VERSION_REQUIRED');
    });

    it.each<[string, object]>([
      ['a null category', { category_id: null }],
      ['a wallet', { wallet_id: 3 }],
      ['an unknown field', { kind: 'regular' }],
      ['a malformed amount', { amount: '1.234' }],
    ])('rejects %s before If-Match and the record are looked at', async (_, body) => {
      const res = await patch('not-a-uuid', null, body).expect(400);

      expect(res.body.code).toBe('VALIDATION_FAILED');
    });

    it('refuses a starting balance', async () => {
      const id = await startingBalance(owner, '25');

      const res = await patch(id, 1, { amount: '30' }).expect(400);

      expect(res.body.code).toBe('TRANSACTION_IS_SYSTEM');
    });

    it('answers a repeat with the same Idempotency-Key with the original result', async () => {
      const id = await createTransaction(owner);
      const send = () => patch(id, 1, { amount: '20' }).set('Idempotency-Key', `patch-${id}`);

      const first = await send().expect(200);
      const repeat = await send().expect(200);

      expect(repeat.body).toEqual(first.body);
      expect(repeat.body.transaction.version).toBe(2);
    });

    it('is not found for a transaction of another space', async () => {
      const foreignId = await foreignTransaction();

      const res = await patch(foreignId, 1, { amount: '1' }).expect(404);

      expect(res.body.code).toBe('TRANSACTION_NOT_FOUND');
    });
  });

  describe('Undo of a create', () => {
    async function addGuest(): Promise<Member> {
      const guest = await createVerifiedMember(testApp, 'transactions-guest');
      guests.push(guest.userId);
      await testApp.dataSource.query("INSERT INTO space_members (space_id, user_id, role) VALUES (?, ?, 'member')", [
        owner.spaceId,
        guest.userId,
      ]);
      return guest;
    }

    const guests: number[] = [];

    afterAll(async () => {
      await deleteUsers(testApp.dataSource, guests);
    });

    async function createAsOwner() {
      const res = await api(owner)
        .post(transactions(owner))
        .send({
          category_id: expenseCategoryId,
          transaction_type: 'expense',
          amount: '12.3',
          date: '2026-09-15',
          time_zone: 'UTC',
          assignment: { kind: 'space' },
        })
        .expect(201);
      return res.body.transaction as { id: string; version: number };
    }

    const undo = (member: Member, transaction: { id: string; version: number }) =>
      api(member)
        .delete(`${transactions(owner)}/${transaction.id}`)
        .set('If-Match', `"${transaction.version}"`);

    it('deletes the created record with the version from the POST result', async () => {
      const created = await createAsOwner();

      await undo(owner, created).expect(200);

      const read = await api(owner)
        .get(`${transactions(owner)}/${created.id}`)
        .expect(404);
      expect(read.body.code).toBe('TRANSACTION_NOT_FOUND');
    });

    it('refuses to undo a record another member edited meanwhile, and keeps the new version', async () => {
      const created = await createAsOwner();
      const guest = await addGuest();
      await api(guest)
        .patch(`${transactions(owner)}/${created.id}`)
        .set('If-Match', '"1"')
        .send({ amount: '99' })
        .expect(200);

      const res = await undo(owner, created).expect(409);

      expect(res.body.code).toBe('TRANSACTION_VERSION_CONFLICT');
      const read = await api(owner)
        .get(`${transactions(owner)}/${created.id}`)
        .expect(200);
      expect(read.body).toEqual(expect.objectContaining({ amount: '99.00', version: 2 }));
    });

    it('tells a member who lost access from a record that is gone', async () => {
      const guest = await addGuest();
      const created = await createAsOwner();
      await testApp.dataSource.query('DELETE FROM space_members WHERE space_id = ? AND user_id = ?', [
        owner.spaceId,
        guest.userId,
      ]);

      const lost = await undo(guest, created).expect(403);
      await undo(owner, created).expect(200);
      const gone = await undo(owner, created).expect(404);

      expect(lost.body.code).toBe('FORBIDDEN_SPACE');
      expect(gone.body.code).toBe('TRANSACTION_NOT_FOUND');
    });
  });

  describe('deleting a record', () => {
    it('changes history, statistics and limits, whoever it is assigned to', async () => {
      const member = await createVerifiedMember(testApp, 'transactions-delete-derived');

      try {
        const categories = await api(member)
          .get(`${base(member)}/categories`)
          .expect(200);
        const categoryId = categories.body.expenses[0].id;
        const add = (assignment: object, amount: string) =>
          api(member)
            .post(transactions(member))
            .send({
              assignment,
              category_id: categoryId,
              transaction_type: 'expense',
              amount,
              date: today(),
              time_zone: 'UTC',
            })
            .expect(201)
            .then((res) => res.body.transaction.id as string);
        await add({ kind: 'space' }, '10');
        const doomedId = await add({ kind: 'unassigned' }, '25');
        await api(member)
          .post(`${base(member)}/limits`)
          .send({ amount: '1000' })
          .expect(201);

        const snapshot = async () => {
          const [limits, summary, history] = await Promise.all([
            api(member)
              .get(`${base(member)}/limits`)
              .expect(200),
            api(member)
              .get(`/api/v2/spaces/${member.spaceId}/statistics/summary`)
              .query({ period: 'month', time_zone: 'UTC' })
              .expect(200),
            api(member)
              .get(`${transactions(member)}/feed`)
              .query({ from_date: '2000-01-01', to_date: '2099-12-31' })
              .expect(200),
          ]);
          return {
            spent: limits.body.total.spent,
            expense: summary.body.expense,
            history: history.body.items.map((row: { id: string }) => row.id),
          };
        };
        const before = await snapshot();

        await api(member)
          .delete(`${transactions(member)}/${doomedId}`)
          .set('If-Match', '"1"')
          .expect(200);

        const after = await snapshot();
        expect([before.spent, after.spent]).toEqual([35, 10]);
        expect([before.expense, after.expense]).toEqual([
          { amount: '35.00', count: 2 },
          { amount: '10.00', count: 1 },
        ]);
        expect(before.history).toContain(doomedId);
        expect(after.history).not.toContain(doomedId);
      } finally {
        await deleteUsers(testApp.dataSource, [member.userId]);
      }
    });
  });

  describe('history feed and count', () => {
    it('orders the records of a date by creation and counts what the feed returns, starting balance included', async () => {
      const member = await createVerifiedMember(testApp, 'transactions-history');

      try {
        const categories = await api(member)
          .get(`${base(member)}/categories`)
          .expect(200);
        await startingBalance(member, '50', '2026-09-14');
        const created: string[] = [];
        for (let i = 0; i < 3; i++) {
          const res = await api(member)
            .post(transactions(member))
            .send({
              category_id: categories.body.expenses[0].id,
              transaction_type: 'expense',
              amount: '1',
              date: '2026-09-15',
              time_zone: 'UTC',
              assignment: { kind: 'space' },
            })
            .expect(201);
          created.push(res.body.transaction.id);
        }
        const query = { from_date: '2026-09-14', to_date: '2026-09-15' };

        const list = await api(member)
          .get(`${transactions(member)}/feed`)
          .query(query)
          .expect(200);
        const count = await api(member)
          .get(`${transactions(member)}/count`)
          .query(query)
          .expect(200);
        const expenses = await api(member)
          .get(`${transactions(member)}/count`)
          .query({ ...query, transaction_type: 'expense' })
          .expect(200);

        expect(list.body.items.map((row: { id: string; date: string }) => [row.id, row.date])).toEqual([
          ...created.reverse().map((id) => [id, '2026-09-15']),
          [expect.any(String), '2026-09-14'],
        ]);
        expect(list.body.items.some((row: { kind: string }) => row.kind === 'initial_balance')).toBe(true);
        expect(count.body).toEqual({ count: list.body.items.length });
        expect(list.body.items).toHaveLength(4);
        expect(expenses.body).toEqual({ count: 3 });

        const document = createOpenApiDocument(testApp.app);
        expect(schemaErrors(document, okResponseSchema(document, '/transactions/count'), count.body)).toEqual([]);
      } finally {
        await deleteUsers(testApp.dataSource, [member.userId]);
      }
    });

    it('counts a lone starting balance as one row, though Income is zero', async () => {
      const member = await createVerifiedMember(testApp, 'transactions-only-initial');

      try {
        await startingBalance(member, '10');
        const query = { from_date: dayBefore(today()), to_date: today() };

        const count = await api(member)
          .get(`${transactions(member)}/count`)
          .query(query)
          .expect(200);
        const summary = await api(member)
          .get(`/api/v2/spaces/${member.spaceId}/statistics/summary`)
          .query({ period: 'month', time_zone: 'UTC' })
          .expect(200);

        expect(count.body).toEqual({ count: 1 });
        expect(summary.body.income).toEqual({ amount: '0.00', count: 0 });
      } finally {
        await deleteUsers(testApp.dataSource, [member.userId]);
      }
    });

    it('rejects from_date after to_date on the count', async () => {
      const res = await api(owner)
        .get(`${transactions(owner)}/count`)
        .query({ from_date: '2026-09-02', to_date: '2026-09-01' })
        .expect(400);

      expect(res.body).toEqual(
        expect.objectContaining({
          code: 'VALIDATION_FAILED',
          message: [{ field: 'from_date', error: 'from_date must not be after to_date' }],
        }),
      );
    });

    it('refuses the instant bounds of earlier releases', async () => {
      const res = await api(owner)
        .get(`${transactions(owner)}/feed`)
        .query({ from: '2026-09-01T00:00:00.000Z', to: '2026-09-30T23:59:59.999Z', time_zone: 'UTC' })
        .expect(400);

      expect(res.body.code).toBe('VALIDATION_FAILED');
      expect(res.body.message.map((error: { field: string }) => error.field).sort()).toEqual(
        expect.arrayContaining(['from', 'from_date', 'time_zone', 'to', 'to_date']),
      );
    });
  });

  describe('derived data after an edit', () => {
    let member: Member;

    beforeEach(async () => {
      member = await createVerifiedMember(testApp, 'transactions-derived');
    });

    afterEach(async () => {
      await deleteUsers(testApp.dataSource, [member.userId]);
    });

    async function expenseCategories(): Promise<{ id: number; transaction_count: number }[]> {
      const res = await api(member)
        .get(`${base(member)}/categories`)
        .expect(200);
      return res.body.expenses;
    }

    function addExpense(categoryId: number, amount: string, date: string, timeZone: string) {
      return api(member)
        .post(transactions(member))
        .send({
          category_id: categoryId,
          transaction_type: 'expense',
          amount,
          date,
          time_zone: timeZone,
          assignment: { kind: 'member', user_id: member.userId },
        })
        .expect(201)
        .then((res) => res.body.transaction as { id: string; version: number });
    }

    it('counts limits in the month of the requested zone and reports its bounds', async () => {
      const [category] = await expenseCategories();
      await api(member)
        .post(`${base(member)}/limits`)
        .send({ amount: '1000' })
        .expect(201);
      // the first day of this month at UTC+14 is always past there, and still
      // the previous month at UTC-11 unless that zone's month has turned too
      const east = monthPeriodAt(new Date(), 'Pacific/Kiritimati');
      await addExpense(category.id, '10', east.start_date, 'Pacific/Kiritimati');

      const limitsIn = (timeZone: string) =>
        api(member)
          .get(`${base(member)}/limits`)
          .query({ time_zone: timeZone })
          .expect(200)
          .then((res) => res.body);
      const eastLimits = await limitsIn('Pacific/Kiritimati');
      const westLimits = await limitsIn('Pacific/Pago_Pago');
      const west = monthPeriodAt(new Date(), 'Pacific/Pago_Pago');

      expect(eastLimits.period).toEqual({
        time_zone: 'Pacific/Kiritimati',
        start_date: east.start_date,
        end_date: east.end_date,
      });
      expect(eastLimits.total.spent).toBe(10);
      expect(westLimits.total.spent).toBe(east.start_date === west.start_date ? 10 : 0);
    });

    it('rejects a fixed offset as the limits zone', async () => {
      const res = await api(member)
        .get(`${base(member)}/limits`)
        .query({ time_zone: '+03:00' })
        .expect(400);

      expect(res.body.message).toEqual([{ field: 'time_zone', error: 'time_zone must be an IANA time zone name' }]);
    });

    it('moves an edited expense across the month boundary in limits, statistics, history and counters', async () => {
      const [first, second] = await expenseCategories();
      await api(member)
        .post(`${base(member)}/limits`)
        .send({ amount: '1000' })
        .expect(201);
      await api(member)
        .post(`${base(member)}/limits`)
        .send({ amount: '500', category_ids: [first.id] })
        .expect(201);
      const zone = 'Europe/Moscow';
      const month = monthPeriodAt(new Date(), zone);
      const created = await addExpense(first.id, '25', month.start_date, zone);
      const previousMonthEnd = dayBefore(month.start_date);
      const bounds = { from_date: month.start_date, to_date: month.end_date };

      const snapshot = async () => {
        const [limits, summary, breakdown, history, count, categories] = await Promise.all([
          api(member)
            .get(`${base(member)}/limits`)
            .query({ time_zone: zone })
            .expect(200),
          api(member)
            .get(`/api/v2/spaces/${member.spaceId}/statistics/summary`)
            .query({ period: 'month', time_zone: zone })
            .expect(200),
          api(member)
            .get(`/api/v2/spaces/${member.spaceId}/statistics/breakdown`)
            .query({ period: 'month', time_zone: zone })
            .expect(200),
          api(member)
            .get(`${transactions(member)}/feed`)
            .query({ ...bounds, transaction_type: 'expense' })
            .expect(200),
          api(member)
            .get(`${transactions(member)}/count`)
            .query({ ...bounds, transaction_type: 'expense' })
            .expect(200),
          expenseCategories(),
        ]);
        const counter = (id: number) => categories.find((category) => category.id === id)?.transaction_count;
        return {
          total: limits.body.total.spent,
          firstLimit: limits.body.categories[0].spent,
          expense: summary.body.expense,
          personal: breakdown.body.by_assignment.primary_items.map((item: { amount: string }) => item.amount),
          history: history.body.items.length,
          count: count.body.count,
          counters: [counter(first.id), counter(second.id)],
        };
      };

      expect(await snapshot()).toEqual({
        total: 25,
        firstLimit: 25,
        expense: { amount: '25.00', count: 1 },
        personal: ['25.00'],
        history: 1,
        count: 1,
        counters: [1, 0],
      });

      await api(member)
        .patch(`${transactions(member)}/${created.id}`)
        .set('If-Match', '"1"')
        .send({ date: previousMonthEnd, time_zone: zone, category_id: second.id, amount: '30' })
        .expect(200);

      expect(await snapshot()).toEqual({
        total: 0,
        firstLimit: 0,
        expense: { amount: '0.00', count: 0 },
        personal: [],
        history: 0,
        count: 0,
        counters: [0, 1],
      });
    });
  });
});
