import { randomUUID } from 'node:crypto';
import request from 'supertest';
import type { QueryRunner } from 'typeorm';

import { ReplaceTransactionTimestampWithDate1791500000000 } from '../src/migrations/1791500000000-ReplaceTransactionTimestampWithDate';
import { compareDateLedgers, readDateLedger, readDateSchema } from '../src/database/transaction-dates';
import { type Member, type TestApp, createTestApp, createVerifiedMember, deleteUsers } from './support/app';
import { assertDisposableDatabase, disposableDatabaseName } from './support/disposable-database';

// Each instant and the Chicago day it must get, with the rules of its own
// year: before 2007 DST began on the first Sunday of April and ended on the
// last Sunday of October.
const INSTANTS: [key: string, instant: string, date: string][] = [
  ['winterLastMs', '2026-01-15T05:59:59.999Z', '2026-01-14'],
  ['winterMidnight', '2026-01-15T06:00:00.000Z', '2026-01-15'],
  ['summerLastMs', '2026-07-15T04:59:59.999Z', '2026-07-14'],
  ['summerMidnight', '2026-07-15T05:00:00.000Z', '2026-07-15'],
  ['beforeSpringDay', '2026-03-08T05:59:59.999Z', '2026-03-07'],
  ['springMidnight', '2026-03-08T06:00:00.000Z', '2026-03-08'],
  ['beforeJump', '2026-03-08T07:59:59.999Z', '2026-03-08'],
  ['afterJump', '2026-03-08T08:00:00.000Z', '2026-03-08'],
  ['springLastMs', '2026-03-09T04:59:59.999Z', '2026-03-08'],
  ['octoberLastMs', '2026-11-01T04:59:59.999Z', '2026-10-31'],
  ['fallMidnight', '2026-11-01T05:00:00.000Z', '2026-11-01'],
  ['firstHalfPastOne', '2026-11-01T06:30:00.000Z', '2026-11-01'],
  ['secondHalfPastOne', '2026-11-01T07:30:00.000Z', '2026-11-01'],
  ['fallLastMs', '2026-11-02T05:59:59.999Z', '2026-11-01'],
  ['yearLastMs', '2027-01-01T05:59:59.999Z', '2026-12-31'],
  ['newYear', '2027-01-01T06:00:00.000Z', '2027-01-01'],
  ['oldSpring', '2006-04-02T05:30:00.000Z', '2006-04-01'],
  ['oldFall', '2006-11-01T05:30:00.000Z', '2006-10-31'],
  ['tieA', '2026-09-15T15:00:00.000Z', '2026-09-15'],
  ['tieB', '2026-09-15T15:00:00.000Z', '2026-09-15'],
  ['tieC', '2026-09-15T15:00:00.000Z', '2026-09-15'],
];

// Runs ReplaceTransactionTimestampWithDate over the whole database, like the
// CLI would, from a database as Release B left it. The schema is taken back
// before each test and every test leaves it migrated. Only
// `npm run test:e2e:migrations` runs it, on a disposable database
// (test/jest-migration-e2e.config.js).
describe('ReplaceTransactionTimestampWithDate migration (e2e)', () => {
  let testApp: TestApp;
  let disposable = false;
  const migration = new ReplaceTransactionTimestampWithDate1791500000000();
  let userIds: number[];
  let member: Member;
  let ids: Record<string, string>;
  let categories: { expense: number; income: number; system: number };
  let operationId: string;

  const query = <T = Record<string, unknown>>(sql: string, parameters?: unknown[]): Promise<T[]> =>
    testApp.dataSource.query(sql, parameters);

  // a real query runner; `interruptAt` stops it before the first matching
  // statement, `before` runs ahead of it
  async function withRunner<T>(
    work: (runner: QueryRunner) => Promise<T>,
    options: { interruptAt?: RegExp; before?: [RegExp, () => Promise<unknown>] } = {},
  ): Promise<T> {
    const runner = testApp.dataSource.createQueryRunner();
    const original = runner.query.bind(runner) as (...args: unknown[]) => Promise<unknown>;
    let hookRan = false;

    jest.spyOn(runner, 'query').mockImplementation((async (sql: string, ...rest: unknown[]) => {
      if (options.interruptAt?.test(sql)) {
        throw new Error('deploy interrupted');
      }

      if (options.before && !hookRan && options.before[0].test(sql)) {
        hookRan = true;
        await options.before[1]();
      }

      return original(sql, ...rest);
    }) as QueryRunner['query']);

    try {
      return await work(runner);
    } finally {
      await runner.release();
    }
  }

  const up = (options?: Parameters<typeof withRunner>[1]) => withRunner((runner) => migration.up(runner), options);
  const down = () => withRunner((runner) => migration.down(runner));

  const schema = async () => {
    const columns = await query<{ COLUMN_NAME: string; IS_NULLABLE: string; EXTRA: string }>(
      `SELECT COLUMN_NAME, IS_NULLABLE, EXTRA FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'transactions' AND COLUMN_NAME IN ('timestamp', 'date', 'order_key')
       ORDER BY COLUMN_NAME`,
    );
    const indexes = await query<{ INDEX_NAME: string }>(
      `SELECT DISTINCT INDEX_NAME FROM information_schema.STATISTICS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'transactions'
         AND INDEX_NAME IN ('IDX_transactions_space_timestamp_id', 'IDX_transactions_space_assignment',
                            'IDX_transactions_space_date', 'IDX_transactions_space_assignment_date',
                            'UQ_transactions_order_key')
       ORDER BY INDEX_NAME`,
    );

    return {
      columns: columns.map((column) => `${column.COLUMN_NAME} ${column.IS_NULLABLE} ${column.EXTRA}`.trim()),
      indexes: indexes.map((index) => index.INDEX_NAME),
    };
  };

  const MIGRATED = {
    columns: ['date NO', 'order_key NO auto_increment'],
    indexes: ['IDX_transactions_space_assignment_date', 'IDX_transactions_space_date', 'UQ_transactions_order_key'],
  };

  const datesOf = async (): Promise<Record<string, string>> => {
    const rows = await query<{ id: string; date: string }>(
      "SELECT id, DATE_FORMAT(date, '%Y-%m-%d') AS date FROM transactions WHERE space_id = ?",
      [member.spaceId],
    );
    const byId = new Map(rows.map((row) => [row.id, row.date]));

    return Object.fromEntries(Object.entries(ids).map(([key, id]) => [key, byId.get(id)!]));
  };

  const expectedDates = () => ({
    ...Object.fromEntries(INSTANTS.map(([key, , date]) => [key, date])),
    start: '2026-08-01',
    recorded: '2026-09-20',
  });

  // the order of the history before the migration: (timestamp, id)
  const legacyOrder = () =>
    [
      ...INSTANTS.map(([key, instant]) => ({ key, instant })),
      { key: 'start', instant: '2026-08-01T14:00:00.000Z' },
      { key: 'recorded', instant: '2026-09-20T17:00:00.000Z' },
    ]
      .sort((a, b) => a.instant.localeCompare(b.instant) || (ids[a.key] < ids[b.key] ? -1 : 1))
      .map(({ key }) => ids[key]);

  const historyOrder = async () =>
    (
      await query<{ id: string }>('SELECT id FROM transactions WHERE space_id = ? ORDER BY date, order_key', [
        member.spaceId,
      ])
    ).map((row) => row.id);

  // the schema of Release B and its history, written the way that release wrote it
  async function seedReleaseB(): Promise<void> {
    ids = {};
    operationId = randomUUID();
    const insert = async (key: string, instant: string, categoryId: number, type: string, amount: string) => {
      const id = randomUUID();
      ids[key] = id;
      await query(
        `INSERT INTO transactions (id, space_id, category_id, transaction_type, amount, timestamp, description,
           version, author_user_id, author_source, assignment_kind, assigned_user_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, 2, ?, 'recorded', 'member', ?)`,
        [id, member.spaceId, categoryId, type, amount, new Date(instant), key, member.userId, member.userId],
      );
    };

    for (const [index, [key, instant]] of INSTANTS.entries()) {
      await insert(key, instant, categories.expense, 'expense', `${index + 1}.25`);
    }
    await insert('start', '2026-08-01T14:00:00.000Z', categories.system, 'income', '500.00');
    await insert('recorded', '2026-09-20T17:00:00.000Z', categories.income, 'income', '2500.00');
    await query(
      'INSERT INTO transaction_operations (space_id, operation_id, transaction_id, created_at) VALUES (?, ?, ?, ?)',
      [member.spaceId, operationId, ids.recorded, new Date('2026-09-20T17:00:01.000Z')],
    );

    const stored = async (operation: string, key: string, body: unknown) =>
      query(
        `INSERT INTO idempotency_keys (user_id, space_id, operation, idempotency_key, request_hash, response_body,
           created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, NOW(3), NOW(3) + INTERVAL 1 DAY)`,
        [member.userId, member.spaceId, operation, key, 'a'.repeat(64), JSON.stringify(body)],
      );
    await stored('transactions.v2.create', 'create-key', {
      transaction: { id: ids.octoberLastMs, amount: '10.25', timestamp: '2026-11-01T04:59:59.999Z', version: 1 },
    });
    await stored('transactions.v2.update', 'update-key', {
      transaction: { id: ids.recorded, amount: '2500.00', timestamp: '2026-09-20T17:00:00.000Z', version: 2 },
    });
    await stored('transactions.v2.delete', 'delete-key', true);
    await stored('spaces.create', 'space-key', { id: member.spaceId, timestamp: '2026-09-01T00:00:00.000Z' });
  }

  const storedResults = async () =>
    Object.fromEntries(
      (
        await query<{ idempotency_key: string; response_body: unknown; request_hash: string }>(
          'SELECT idempotency_key, response_body, request_hash FROM idempotency_keys WHERE user_id = ?',
          [member.userId],
        )
      ).map((row) => [row.idempotency_key, { body: row.response_body, hash: row.request_hash }]),
    );

  beforeAll(async () => {
    const database = disposableDatabaseName();
    testApp = await createTestApp();

    try {
      await assertDisposableDatabase(testApp.dataSource, database);
    } catch (error) {
      await testApp.app.close();
      throw error;
    }

    disposable = true;
  });

  beforeEach(async () => {
    if (!disposable) {
      throw new Error('Not a disposable database');
    }

    member = await createVerifiedMember(testApp, 'dates-migration');
    userIds = [member.userId];
    const category = async (where: string) =>
      Number(
        (
          await query<{ id: number }>(`SELECT id FROM categories WHERE space_id = ? AND ${where} LIMIT 1`, [
            member.spaceId,
          ])
        )[0].id,
      );
    categories = {
      expense: await category("is_system = 0 AND transaction_type = 'expense'"),
      income: await category("is_system = 0 AND transaction_type = 'income'"),
      system: await category('is_system = 1'),
    };
    await down();
    await seedReleaseB();
  });

  afterEach(async () => {
    jest.restoreAllMocks();

    if (!disposable) {
      return;
    }

    if ((await readDateSchema(testApp.dataSource)).hasTimestamp) {
      await up();
    }

    await deleteUsers(testApp.dataSource, userIds);
  });

  afterAll(async () => {
    if (disposable) {
      await testApp.app.close();
    }
  });

  it('dates every record by its Chicago day, keeps the order and every total, and drops the timestamp', async () => {
    const before = await readDateLedger(testApp.dataSource);
    const order = legacyOrder();

    await up();

    expect(await schema()).toEqual(MIGRATED);
    expect(await datesOf()).toEqual(expectedDates());
    expect(await historyOrder()).toEqual(order);
    expect(compareDateLedgers(before, await readDateLedger(testApp.dataSource))).toEqual([]);

    const [kept] = await query<{ version: number; amount: string; description: string; assignment_kind: string }>(
      'SELECT version, amount, description, assignment_kind FROM transactions WHERE id = ?',
      [ids.afterJump],
    );
    expect(kept).toEqual({ version: 2, amount: '8.25', description: 'afterJump', assignment_kind: 'member' });
  });

  it('keeps the day and month totals of the old Chicago reading, starting balances apart', async () => {
    const before = await readDateLedger(testApp.dataSource);

    await up();
    const after = await readDateLedger(testApp.dataSource);
    const mine = <T extends { space_id: number }>(totals: T[]) =>
      totals.filter((total) => total.space_id === member.spaceId);

    expect(mine(after.days)).toEqual(mine(before.days));
    expect(mine(after.months)).toEqual(mine(before.months));
    expect(mine(after.days).find((day) => day.period === '2026-11-01')).toEqual({
      space_id: member.spaceId,
      period: '2026-11-01',
      income: '0.00',
      expense: '51.00',
      count: 4,
    });
    expect(mine(after.months).find((month) => month.period === '2026-10')).toMatchObject({
      count: 1,
      expense: '10.25',
    });
    expect(after.initial_balances.find((balances) => balances.space_id === member.spaceId)).toEqual({
      space_id: member.spaceId,
      count: 1,
      amount: '500.00',
    });
  });

  it('converts the retained results of transaction writes only, keeping keys and fingerprints', async () => {
    const before = await storedResults();

    await up();
    const after = await storedResults();

    expect(after['create-key']).toEqual({
      body: { transaction: { id: ids.octoberLastMs, amount: '10.25', date: '2026-10-31', version: 1 } },
      hash: before['create-key'].hash,
    });
    expect(after['update-key'].body).toEqual({
      transaction: { id: ids.recorded, amount: '2500.00', date: '2026-09-20', version: 2 },
    });
    expect(after['delete-key']).toEqual(before['delete-key']);
    expect(after['space-key']).toEqual(before['space-key']);
  });

  it('serves the migrated history and keeps creates of before the release unique', async () => {
    await up();
    const api = request(testApp.app.getHttpServer());
    const auth = { Authorization: `Bearer ${member.token}` };
    const v2 = `/api/v2/spaces/${member.spaceId}/transactions`;

    const day = await api
      .get(`${v2}/feed`)
      .set(auth)
      .query({ from_date: '2026-11-01', to_date: '2026-11-01' })
      .expect(200);
    expect(day.body.items.map((item: { description: string }) => item.description)).toEqual([
      'fallLastMs',
      'secondHalfPastOne',
      'firstHalfPastOne',
      'fallMidnight',
    ]);
    expect(day.body.day_totals).toEqual([{ date: '2026-11-01', net: '-51.00' }]);

    const ties = await api
      .get(`${v2}/feed`)
      .set(auth)
      .query({ from_date: '2026-09-15', to_date: '2026-09-15' })
      .expect(200);
    expect(ties.body.items.map((item: { id: string }) => item.id)).toEqual(
      [ids.tieA, ids.tieB, ids.tieC].sort().reverse(),
    );

    const found = await api.get(`${v2}/operations/${operationId}`).set(auth).expect(200);
    expect(found.body).toMatchObject({ status: 'applied', transaction: { id: ids.recorded, date: '2026-09-20' } });
    const resent = await api
      .post(v2)
      .set(auth)
      .set('Idempotency-Key', operationId)
      .send({
        category_id: categories.income,
        transaction_type: 'income',
        amount: '2500.00',
        date: '2026-09-20',
        time_zone: 'America/Chicago',
        client_operation_id: operationId,
        assignment: { kind: 'space' },
      })
      .expect(409);
    expect(resent.body.code).toBe('TRANSACTION_OPERATION_EXISTS');

    // a record created now on a migrated day comes after the migrated ones
    const created = await api
      .post(v2)
      .set(auth)
      .send({
        category_id: categories.expense,
        transaction_type: 'expense',
        amount: '1.00',
        date: '2026-09-15',
        time_zone: 'America/Chicago',
        assignment: { kind: 'space' },
      })
      .expect(201);
    const [{ newer }] = await query<{ newer: number | string }>(
      'SELECT COUNT(*) AS newer FROM transactions WHERE order_key > (SELECT order_key FROM transactions WHERE id = ?)',
      [created.body.transaction.id],
    );
    expect(Number(newer)).toBe(0);
    const tiesAfter = await api
      .get(`${v2}/feed`)
      .set(auth)
      .query({ from_date: '2026-09-15', to_date: '2026-09-15' })
      .expect(200);
    expect(tiesAfter.body.items[0].id).toBe(created.body.transaction.id);
  });

  it.each([
    /ADD `date` date NULL/,
    /UPDATE `transactions` SET `date`/,
    /UPDATE `transactions` t/,
    /MODIFY `date` date NOT NULL/,
    /ADD INDEX `IDX_transactions_space_date`/,
    /DROP INDEX `IDX_transactions_space_timestamp_id`/,
    /UPDATE `idempotency_keys`/,
    /DROP COLUMN `timestamp`/,
  ])('finishes when run again after it stopped before %s', async (step) => {
    const before = await readDateLedger(testApp.dataSource);
    const order = legacyOrder();

    await expect(up({ interruptAt: step })).rejects.toThrow('deploy interrupted');
    await up();

    expect(await schema()).toEqual(MIGRATED);
    expect(await datesOf()).toEqual(expectedDates());
    expect(await historyOrder()).toEqual(order);
    expect(compareDateLedgers(before, await readDateLedger(testApp.dataSource))).toEqual([]);
  });

  it('refuses to drop the timestamps while a date disagrees with its instant, and finishes when run again', async () => {
    const corrupt = () => query('UPDATE transactions SET date = ? WHERE id = ?', ['2026-11-02', ids.fallLastMs]);

    await expect(up({ before: [/GROUP BY `date`/, corrupt] })).rejects.toThrow(
      /dated 2026-11-02 have instants outside that day in America\/Chicago/,
    );
    expect((await readDateSchema(testApp.dataSource)).hasTimestamp).toBe(true);

    await up();

    expect(await datesOf()).toEqual(expectedDates());
  });

  it('passes when run again after it finished', async () => {
    await up();
    const ledger = await readDateLedger(testApp.dataSource);

    await up();

    expect(await schema()).toEqual(MIGRATED);
    expect(compareDateLedgers({ ...ledger, read_from: 'timestamp' }, await readDateLedger(testApp.dataSource))).toEqual(
      [],
    );
  });

  it('reverts to timestamps at the start of each Chicago day, in the history order, and migrates back', async () => {
    const order = legacyOrder();
    await up();

    await down();

    expect((await readDateSchema(testApp.dataSource)).hasTimestamp).toBe(true);
    const rows = await query<{ id: string; epoch_ms: string | number }>(
      'SELECT id, CAST(ROUND(UNIX_TIMESTAMP(timestamp) * 1000) AS SIGNED) AS epoch_ms FROM transactions WHERE id IN (?)',
      [[ids.springMidnight, ids.beforeJump, ids.fallMidnight, ids.firstHalfPastOne]],
    );
    const instants = Object.fromEntries(rows.map((row) => [row.id, new Date(Number(row.epoch_ms)).toISOString()]));
    // the 8th of March starts at 06:00Z (CST), the 1st of November at 05:00Z (CDT)
    expect(instants[ids.springMidnight]).toBe('2026-03-08T06:00:00.000Z');
    expect(instants[ids.beforeJump]).toBe('2026-03-08T06:00:00.001Z');
    expect(instants[ids.fallMidnight]).toBe('2026-11-01T05:00:00.000Z');
    expect(instants[ids.firstHalfPastOne]).toBe('2026-11-01T05:00:00.001Z');
    expect((await storedResults())['create-key'].body).toEqual({
      transaction: { id: ids.octoberLastMs, amount: '10.25', timestamp: '2026-10-31T05:00:00.000Z', version: 1 },
    });

    await up();

    expect(await schema()).toEqual(MIGRATED);
    expect(await datesOf()).toEqual(expectedDates());
    expect(await historyOrder()).toEqual(order);
  });

  it('refuses to revert a date a TIMESTAMP cannot hold, changing nothing', async () => {
    await up();
    await query('UPDATE transactions SET date = ? WHERE id = ?', ['1969-12-31', ids.winterMidnight]);

    await expect(down()).rejects.toThrow(new RegExp(`outside what a TIMESTAMP holds: ${ids.winterMidnight}\\.`));
    expect(await schema()).toEqual(MIGRATED);

    await query('UPDATE transactions SET date = ? WHERE id = ?', ['2026-01-15', ids.winterMidnight]);
  });
});
