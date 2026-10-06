import request from 'supertest';
import { DateTime } from 'luxon';

import { TransactionQueriesService } from '@modules/transaction-queries/transaction-queries.service';
import { monthPeriodAt } from '@shared/utils';
import { type Member, type TestApp, createTestApp, createVerifiedMember, deleteUsers } from './support/app';
import { overlap, pauseAfterFirstCall } from './support/concurrency';
import { createOpenApiDocument } from './support/openapi';

const ZONE = 'Europe/Moscow';

describe('Transaction lifecycle (e2e)', () => {
  let testApp: TestApp;
  let member: Member;
  let categories: { incomes: { id: number }[]; expenses: { id: number }[] };

  beforeAll(async () => {
    testApp = await createTestApp();
  });

  beforeEach(async () => {
    member = await createVerifiedMember(testApp, 'tx-lifecycle');
    categories = (await api().get(`${base()}/categories`).expect(200)).body;
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await deleteUsers(testApp.dataSource, [member.userId]);
  });

  afterAll(async () => {
    await testApp.app.close();
  });

  function base(): string {
    return `/api/v1/spaces/${member.spaceId}`;
  }

  function api() {
    const agent = request(testApp.app.getHttpServer());
    const withAuth =
      (method: 'get' | 'post' | 'patch' | 'delete') =>
      (url: string): request.Test =>
        agent[method](url).set('Authorization', `Bearer ${member.token}`);

    return { get: withAuth('get'), post: withAuth('post'), patch: withAuth('patch'), delete: withAuth('delete') };
  }

  async function createWallet(name: string, initialBalance = '0'): Promise<number> {
    const res = await api()
      .post(`${base()}/wallets`)
      .send({ wallet_name: name, initial_balance: initialBalance, design: 'slate' })
      .expect(201);
    return res.body.wallet.id;
  }

  function create(body: Record<string, unknown>) {
    return api().post(`${base()}/transactions`).send(body);
  }

  function patch(id: string, version: number, body: object) {
    return api().patch(`${base()}/transactions/${id}`).set('If-Match', `"${version}"`).send(body);
  }

  function remove(id: string, version: number) {
    return api().delete(`${base()}/transactions/${id}`).set('If-Match', `"${version}"`);
  }

  // every derived figure of the space for the current month in ZONE
  async function snapshot() {
    const month = monthPeriodAt(new Date(), ZONE);
    const bounds = { from: month.from.toISOString(), to: month.to.toISOString() };
    const [wallets, limits, summary, count, list] = await Promise.all([
      api().get(`${base()}/wallets`).query(bounds).expect(200),
      api().get(`${base()}/limits`).query({ time_zone: ZONE }).expect(200),
      api().get(`${base()}/statistics/summary`).query({ period: 'month', time_zone: ZONE }).expect(200),
      api().get(`${base()}/transactions/count`).query(bounds).expect(200),
      api().get(`${base()}/categories`).expect(200),
    ]);
    const balances = Object.fromEntries(
      wallets.body.wallets.map((entry: { wallet: { wallet_name: string; balance: number } }) => [
        entry.wallet.wallet_name,
        entry.wallet.balance,
      ]),
    );
    const counters = [...list.body.incomes, ...list.body.expenses]
      .filter((category: { transaction_count: number }) => category.transaction_count > 0)
      .map((category: { id: number; transaction_count: number }) => [category.id, category.transaction_count]);

    return {
      balances,
      total_balance: wallets.body.total_balance,
      spent: limits.body.total?.spent ?? null,
      income: summary.body.income,
      expense: summary.body.expense,
      rows: count.body.count,
      counters,
    };
  }

  it('keeps every derived figure consistent through create, edits, a move, delete and undo', async () => {
    const card = await createWallet('Card', '100');
    const pocket = await createWallet('Pocket');
    const [salary] = categories.incomes;
    const [food, transport] = categories.expenses;
    await api().post(`${base()}/limits`).send({ amount: '1000' }).expect(201);
    const now = () => new Date(Date.now() - 1000).toISOString();

    expect(await snapshot()).toEqual({
      balances: { Card: 100, Pocket: 0, Cash: 0 },
      total_balance: 100,
      spent: 0,
      income: { amount: '0.00', count: 0 },
      expense: { amount: '0.00', count: 0 },
      rows: 1,
      counters: [],
    });

    const created = await create({
      wallet_id: card,
      category_id: food.id,
      transaction_type: 'expense',
      amount: '12.30',
      timestamp: now(),
      description: 'Lunch',
    }).expect(201);
    const id = created.body.transaction.id;
    expect(created.body).toEqual(
      expect.objectContaining({ previous_balance: 100, wallet: expect.objectContaining({ balance: 87.7 }) }),
    );
    const read = await api().get(`${base()}/transactions/${id}`).expect(200);
    expect(read.body).toEqual(created.body.transaction);
    expect(await snapshot()).toEqual(
      expect.objectContaining({
        balances: { Card: 87.7, Pocket: 0, Cash: 0 },
        spent: 12.3,
        expense: { amount: '12.30', count: 1 },
        rows: 2,
        counters: [[food.id, 1]],
      }),
    );

    await patch(id, 1, { amount: '20.00', category_id: transport.id }).expect(200);
    expect(await snapshot()).toEqual(
      expect.objectContaining({
        balances: { Card: 80, Pocket: 0, Cash: 0 },
        spent: 20,
        expense: { amount: '20.00', count: 1 },
        counters: [[transport.id, 1]],
      }),
    );

    const moved = await patch(id, 2, { wallet_id: pocket }).expect(200);
    expect(moved.body.wallets).toEqual([
      { id: card, balance: 100, is_deleted: false },
      { id: pocket, balance: -20, is_deleted: false },
    ]);
    expect(await snapshot()).toEqual(
      expect.objectContaining({ balances: { Card: 100, Pocket: -20, Cash: 0 }, total_balance: 80, spent: 20 }),
    );

    await patch(id, 3, { transaction_type: 'income', category_id: salary.id }).expect(200);
    expect(await snapshot()).toEqual(
      expect.objectContaining({
        balances: { Card: 100, Pocket: 20, Cash: 0 },
        spent: 0,
        income: { amount: '20.00', count: 1 },
        expense: { amount: '0.00', count: 0 },
        counters: [[salary.id, 1]],
      }),
    );

    await patch(id, 4, { transaction_type: 'expense', category_id: food.id }).expect(200);
    expect(await snapshot()).toEqual(
      expect.objectContaining({ balances: { Card: 100, Pocket: -20, Cash: 0 }, spent: 20, counters: [[food.id, 1]] }),
    );

    await remove(id, 5).expect(200);
    expect(await snapshot()).toEqual({
      balances: { Card: 100, Pocket: 0, Cash: 0 },
      total_balance: 100,
      spent: 0,
      income: { amount: '0.00', count: 0 },
      expense: { amount: '0.00', count: 0 },
      rows: 1,
      counters: [],
    });

    // undo: the delete of the record just created, with the version POST returned
    const again = await create({
      wallet_id: card,
      category_id: food.id,
      transaction_type: 'expense',
      amount: '5',
      timestamp: now(),
    }).expect(201);
    await remove(again.body.transaction.id, again.body.transaction.version).expect(200);
    expect(await snapshot()).toEqual(
      expect.objectContaining({ balances: { Card: 100, Pocket: 0, Cash: 0 }, spent: 0, rows: 1 }),
    );
  });

  it('moves a transaction off a deleted wallet onto an active one', async () => {
    const old = await createWallet('Old');
    const active = await createWallet('Active', '50');
    const created = await create({
      wallet_id: old,
      category_id: categories.expenses[0].id,
      transaction_type: 'expense',
      amount: '10',
      timestamp: '2026-09-15T10:00:00.000Z',
    }).expect(201);
    await api().delete(`${base()}/wallets/${old}`).expect(200);

    const res = await patch(created.body.transaction.id, 1, { wallet_id: active }).expect(200);

    expect(res.body.wallets).toEqual([
      { id: old, balance: 0, is_deleted: true },
      { id: active, balance: 40, is_deleted: false },
    ]);
    expect(res.body.transaction.wallet).toEqual(expect.objectContaining({ id: active }));
  });

  it('refuses moving to another archived category while keeping its own', async () => {
    const wallet = await createWallet('Card');
    const archive = async (name: string) => {
      const category = await api()
        .post(`${base()}/categories`)
        .send({ name, transaction_type: 'expense', icon: 'Other', color: 'slate' })
        .expect(201);
      return category.body.id as number;
    };
    const own = await archive('Own');
    const other = await archive('Other');
    const created = await create({
      wallet_id: wallet,
      category_id: own,
      transaction_type: 'expense',
      amount: '1',
      timestamp: '2026-09-15T10:00:00.000Z',
    }).expect(201);
    // gives Other history too, so deleting it archives it
    const keepOther = await create({
      wallet_id: wallet,
      category_id: other,
      transaction_type: 'expense',
      amount: '1',
      timestamp: '2026-09-15T10:00:00.000Z',
    }).expect(201);
    for (const id of [own, other]) {
      expect((await api().delete(`${base()}/categories/${id}`).expect(200)).body).toEqual({ archived: true });
    }

    const kept = await patch(created.body.transaction.id, 1, { category_id: own, amount: '2' }).expect(200);
    const refused = await patch(created.body.transaction.id, 2, { category_id: other }).expect(400);

    expect(kept.body.transaction.category).toEqual(expect.objectContaining({ id: own, is_archived: true }));
    expect(refused.body.code).toBe('CATEGORY_ARCHIVED');
    expect(keepOther.status).toBe(201);
  });

  it('keeps a legacy future timestamp on an unrelated edit and refuses a new future one', async () => {
    const wallet = await createWallet('Card');
    const created = await create({
      wallet_id: wallet,
      category_id: categories.expenses[0].id,
      transaction_type: 'expense',
      amount: '1',
      timestamp: '2026-09-15T10:00:00.000Z',
    }).expect(201);
    const id = created.body.transaction.id;
    const legacyFuture = new Date('2037-06-01T00:00:00.000Z');
    await testApp.dataSource.query('UPDATE transactions SET timestamp = ? WHERE id = ?', [legacyFuture, id]);

    const kept = await patch(id, 1, { description: 'Still planned', timestamp: legacyFuture.toISOString() }).expect(
      200,
    );
    const refused = await patch(id, 2, { timestamp: '2037-07-01T00:00:00.000Z' }).expect(400);

    expect(kept.body.transaction).toEqual(
      expect.objectContaining({ timestamp: legacyFuture.toISOString(), description: 'Still planned' }),
    );
    expect(refused.body.message).toEqual([{ field: 'timestamp', error: 'timestamp must not be in the future' }]);
  });

  it('refuses a delete of the version an edit is replacing: the delete waits, then conflicts', async () => {
    const wallet = await createWallet('Card');
    const created = await create({
      wallet_id: wallet,
      category_id: categories.expenses[0].id,
      transaction_type: 'expense',
      amount: '1',
      timestamp: '2026-09-15T10:00:00.000Z',
    }).expect(201);
    const id = created.body.transaction.id;
    const queries = testApp.app.get(TransactionQueriesService);
    const checkpoint = pauseAfterFirstCall(queries, 'getOneInSpace', (_self, args) => args.length === 3);

    const [edited, deleted] = await overlap(
      testApp.dataSource,
      checkpoint,
      '%FROM `transactions` `row`%FOR UPDATE%',
      () => patch(id, 1, { amount: '2' }),
      () => remove(id, 1),
    );

    expect(edited.status).toBe(200);
    expect(deleted.status).toBe(409);
    expect(deleted.body.code).toBe('TRANSACTION_VERSION_CONFLICT');
    expect((await api().get(`${base()}/transactions/${id}`).expect(200)).body).toEqual(
      expect.objectContaining({ amount: '2.00', version: 2 }),
    );
  });

  it('bounds a local day across a DST change the same way in history and statistics', async () => {
    const zone = 'America/New_York';
    const wallet = await createWallet('Card');
    // 2026-03-08 is 23 hours long in New York: clocks go from 02:00 EST to 03:00 EDT
    const day = DateTime.fromISO('2026-03-08', { zone });
    const from = day.startOf('day').toJSDate();
    const to = new Date(day.plus({ days: 1 }).startOf('day').toJSDate().getTime() - 1);
    expect(to.getTime() - from.getTime()).toBe(23 * 3_600_000 - 1);
    const add = async (timestamp: string) =>
      create({
        wallet_id: wallet,
        category_id: categories.expenses[0].id,
        transaction_type: 'expense',
        amount: '1',
        timestamp,
      }).expect(201);
    // 23:30 EDT on March 8, the day's last half hour
    const late = await add('2026-03-09T03:30:00.000Z');
    // 00:30 EDT on March 9: inside a naive 24-hour day from midnight EST
    await add('2026-03-09T04:30:00.000Z');

    const count = await api()
      .get(`${base()}/transactions/count`)
      .query({ from: from.toISOString(), to: to.toISOString() })
      .expect(200);
    const statistics = await api()
      .get(`${base()}/statistics/summary`)
      .query({ period: 'custom', from_date: '2026-03-08', to_date: '2026-03-08', time_zone: zone })
      .expect(200);

    expect(count.body).toEqual({ count: 1 });
    expect(statistics.body.expense).toEqual({ amount: '1.00', count: 1 });
    expect(statistics.body.period).toEqual(expect.objectContaining({ from: from.toISOString(), to: to.toISOString() }));

    // moving it by an hour, across midnight, takes it out of the day everywhere
    await patch(late.body.transaction.id, 1, { timestamp: '2026-03-09T04:15:00.000Z' }).expect(200);
    const after = await api()
      .get(`${base()}/transactions/count`)
      .query({ from: from.toISOString(), to: to.toISOString() })
      .expect(200);
    const statisticsAfter = await api()
      .get(`${base()}/statistics/summary`)
      .query({ period: 'custom', from_date: '2026-03-08', to_date: '2026-03-08', time_zone: zone })
      .expect(200);
    expect(after.body).toEqual({ count: 0 });
    expect(statisticsAfter.body.expense).toEqual({ amount: '0.00', count: 0 });
  });

  describe('OpenAPI', () => {
    type Operation = {
      parameters?: { name: string; in: string; required?: boolean }[];
      requestBody?: unknown;
      responses: Record<string, unknown>;
    };

    function operation(method: string, pathSuffix: string): Operation {
      const document = createOpenApiDocument(testApp.app);
      const path = Object.keys(document.paths).find((candidate) => candidate.endsWith(pathSuffix))!;

      return (document.paths[path] as Record<string, Operation>)[method];
    }

    const header = (op: Operation, name: string) => op.parameters?.find((p) => p.in === 'header' && p.name === name);

    it.each<[string, string, boolean | undefined, string[]]>([
      ['post', '/transactions', undefined, ['201', '400', '403', '409']],
      ['patch', '/transactions/{transactionId}', true, ['200', '400', '404', '409', '428']],
      ['delete', '/transactions/{transactionId}', true, ['200', '400', '404', '409', '428']],
    ])('documents %s %s with its headers and errors', (method, path, ifMatch, statuses) => {
      const op = operation(method, path);

      expect(header(op, 'Idempotency-Key')).toEqual(expect.objectContaining({ required: false }));
      if (ifMatch === undefined) {
        expect(header(op, 'If-Match')).toBeUndefined();
      } else {
        expect(header(op, 'If-Match')).toEqual(expect.objectContaining({ required: true }));
      }
      expect(Object.keys(op.responses)).toEqual(expect.arrayContaining(statuses));
    });

    it('documents the request bodies, the count and the limits zone', () => {
      expect(operation('post', '/transactions').requestBody).toBeDefined();
      expect(operation('patch', '/transactions/{transactionId}').requestBody).toBeDefined();
      expect(Object.keys(operation('get', '/transactions/count').responses)).toContain('200');
      expect(operation('get', '/limits').parameters).toEqual(
        expect.arrayContaining([expect.objectContaining({ name: 'time_zone', in: 'query', required: false })]),
      );
    });
  });
});
