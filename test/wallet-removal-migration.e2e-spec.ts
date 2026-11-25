import { randomUUID } from 'node:crypto';
import request from 'supertest';
import type { QueryRunner } from 'typeorm';

import { DropWallets1791400000000 } from '../src/migrations/1791400000000-DropWallets';
import { ReplaceTransactionTimestampWithDate1791500000000 } from '../src/migrations/1791500000000-ReplaceTransactionTimestampWithDate';
import {
  compareLedgers,
  findMisplacedTransactions,
  readOwnershipInvariants,
  readOwnershipSchema,
  readTransactionLedger,
} from '../src/database/transaction-ownership';
import { type Member, type TestApp, createTestApp, createVerifiedMember, deleteUsers } from './support/app';
import { assertDisposableDatabase, disposableDatabaseName } from './support/disposable-database';

interface Space {
  id: number;
  owner: Member;
  lena: Member;
  expense: number;
  income: number;
  system: number;
  wallets: { card: number; cash: number; closed: number; shared: number };
  ids: Record<string, string>;
  operationId: string;
}

// Runs DropWallets over the whole database, like the CLI would, from a
// database as Release A left it: wallets active and deleted, the
// compatibility wallet of v2 records, starting balances, assignments of every
// kind, operation records and stored v1 results. The schema is taken back
// before each test, through the later date migration, and every test leaves
// it migrated. Only
// `npm run test:e2e:migrations` runs it, on a disposable database
// (test/jest-migration-e2e.config.js).
describe('DropWallets migration (e2e)', () => {
  let testApp: TestApp;
  let disposable = false;
  const migration = new DropWallets1791400000000();
  const dates = new ReplaceTransactionTimestampWithDate1791500000000();
  let userIds: number[];
  let space: Space;

  const query = <T = Record<string, unknown>>(sql: string, parameters?: unknown[]): Promise<T[]> =>
    testApp.dataSource.query(sql, parameters);

  // a real query runner, stopped before the first statement matching `interruptAt`
  async function withRunner<T>(work: (runner: QueryRunner) => Promise<T>, interruptAt?: RegExp): Promise<T> {
    const runner = testApp.dataSource.createQueryRunner();
    const original = runner.query.bind(runner);

    if (interruptAt) {
      jest.spyOn(runner, 'query').mockImplementation(((sql: string, ...rest: unknown[]) => {
        if (interruptAt.test(sql)) {
          return Promise.reject(new Error('deploy interrupted'));
        }

        return (original as (...args: unknown[]) => Promise<unknown>)(sql, ...rest);
      }) as QueryRunner['query']);
    }

    try {
      return await work(runner);
    } finally {
      await runner.release();
    }
  }

  const up = (interruptAt?: RegExp) => withRunner((runner) => migration.up(runner), interruptAt);
  const down = () => withRunner((runner) => migration.down(runner));
  const hasDates = async () =>
    (
      await query(
        `SELECT 1 FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'transactions' AND COLUMN_NAME = 'date'`,
      )
    ).length > 0;
  // the migration that came later: reverted for each test, run again after it
  const datesUp = async () => {
    if (!(await hasDates())) {
      await withRunner((runner) => dates.up(runner));
    }
  };
  const datesDown = async () => {
    if (await hasDates()) {
      await withRunner((runner) => dates.down(runner));
    }
  };

  const schema = async () => {
    const [{ wallets }] = await query<{ wallets: number }>(
      `SELECT COUNT(*) AS wallets FROM information_schema.TABLES
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'wallets'`,
    );
    const indexes = await query<{ INDEX_NAME: string }>(
      `SELECT DISTINCT INDEX_NAME FROM information_schema.STATISTICS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'transactions' AND INDEX_NAME LIKE '%wallet%'`,
    );
    const foreignKeys = await query<{ COLUMN_NAME: string }>(
      `SELECT COLUMN_NAME FROM information_schema.KEY_COLUMN_USAGE
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'transactions' AND REFERENCED_TABLE_NAME IS NOT NULL`,
    );

    return {
      ...(await readOwnershipSchema(testApp.dataSource)),
      walletsTable: Number(wallets) === 1,
      walletIndexes: indexes.map((row) => row.INDEX_NAME),
      foreignKeys: foreignKeys.map((row) => row.COLUMN_NAME).sort(),
    };
  };

  const MIGRATED = {
    hasOwners: true,
    hasWallets: false,
    walletsTable: false,
    walletIndexes: [],
    foreignKeys: ['assigned_user_id', 'author_user_id', 'category_id', 'space_id'],
  };

  async function insertWallet(spaceId: number, name: string, options: { deleted?: boolean; compat?: boolean } = {}) {
    const result: { insertId: number } = await testApp.dataSource.query(
      `INSERT INTO wallets (space_id, wallet_name, design, is_deleted, deleted_at, compat_space_id)
       VALUES (?, ?, 'slate', ?, ?, ?)`,
      [
        spaceId,
        name,
        options.deleted ? 1 : 0,
        options.deleted ? new Date('2026-09-20T00:00:00Z') : null,
        options.compat ? spaceId : null,
      ],
    );

    return Number(result.insertId);
  }

  // a record as Release A wrote it: its wallet and its own space, author and assignment
  async function insertRecord(
    key: string,
    row: {
      walletId: number;
      categoryId: number;
      type: 'income' | 'expense';
      amount: string;
      timestamp: string;
      author: number;
      source?: 'recorded' | 'imported';
      assignment?: 'member' | 'space' | 'unassigned';
      assignee?: number | null;
      version?: number;
    },
  ): Promise<void> {
    const id = randomUUID();
    space.ids[key] = id;
    await query(
      `INSERT INTO transactions (id, wallet_id, space_id, category_id, transaction_type, amount, timestamp, description,
         version, author_user_id, author_source, assignment_kind, assigned_user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        row.walletId,
        space.id,
        row.categoryId,
        row.type,
        row.amount,
        new Date(row.timestamp),
        key,
        row.version ?? 1,
        row.author,
        row.source ?? 'recorded',
        row.assignment ?? 'space',
        row.assignee ?? null,
      ],
    );
  }

  // Built through the app on the migrated schema (users, spaces, categories),
  // then the wallets and records Release A had, once the schema is back.
  async function seedUsers(): Promise<{ owner: Member; lena: Member; spaceId: number }> {
    const owner = await createVerifiedMember(testApp, 'drop-wallets-owner');
    const lena = await createVerifiedMember(testApp, 'drop-wallets-lena');
    userIds.push(owner.userId, lena.userId);
    const created = await request(testApp.app.getHttpServer())
      .post('/api/v1/spaces')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ name: 'Family', type: 'group', currency_id: testApp.currencyId })
      .expect(201);
    await query("INSERT INTO space_members (space_id, user_id, role) VALUES (?, ?, 'member')", [
      created.body.id,
      lena.userId,
    ]);

    return { owner, lena, spaceId: created.body.id };
  }

  async function seedReleaseA(users: { owner: Member; lena: Member; spaceId: number }): Promise<void> {
    const category = async (where: string) =>
      Number(
        (
          await query<{ id: number }>(`SELECT id FROM categories WHERE space_id = ? AND ${where} LIMIT 1`, [
            users.spaceId,
          ])
        )[0].id,
      );
    space = {
      id: users.spaceId,
      owner: users.owner,
      lena: users.lena,
      expense: await category("is_system = 0 AND transaction_type = 'expense'"),
      income: await category("is_system = 0 AND transaction_type = 'income'"),
      system: await category('is_system = 1'),
      wallets: {
        card: await insertWallet(users.spaceId, 'Card'),
        cash: await insertWallet(users.spaceId, 'Cash'),
        closed: await insertWallet(users.spaceId, 'Closed card', { deleted: true }),
        shared: await insertWallet(users.spaceId, 'Shared transactions', { compat: true }),
      },
      ids: {},
      operationId: randomUUID(),
    };
    const { owner, lena } = space;
    const { card, cash, closed, shared } = space.wallets;

    // starting balances of two wallets, one deleted since
    await insertRecord('cardStart', {
      walletId: card,
      categoryId: space.system,
      type: 'income',
      amount: '500.00',
      timestamp: '2026-08-01T09:00:00.000Z',
      author: owner.userId,
      source: 'imported',
    });
    await insertRecord('closedStart', {
      walletId: closed,
      categoryId: space.system,
      type: 'income',
      amount: '40.00',
      timestamp: '2026-08-02T09:00:00.000Z',
      author: owner.userId,
    });
    // imported history and v1 records
    await insertRecord('imported', {
      walletId: card,
      categoryId: space.expense,
      type: 'expense',
      amount: '12.30',
      timestamp: '2026-09-01T10:00:00.000Z',
      author: owner.userId,
      source: 'imported',
      version: 3,
    });
    await insertRecord('closedExpense', {
      walletId: closed,
      categoryId: space.expense,
      type: 'expense',
      amount: '99.99',
      timestamp: '2026-09-03T10:00:00.000Z',
      author: owner.userId,
      version: 2,
    });
    await insertRecord('v1Salary', {
      walletId: cash,
      categoryId: space.income,
      type: 'income',
      amount: '2500.00',
      timestamp: '2026-09-05T10:00:00.000Z',
      author: lena.userId,
    });
    // v2 records in the compatibility wallet
    await insertRecord('forLena', {
      walletId: shared,
      categoryId: space.expense,
      type: 'expense',
      amount: '45.00',
      timestamp: '2026-09-10T10:00:00.000Z',
      author: owner.userId,
      assignment: 'member',
      assignee: lena.userId,
    });
    await insertRecord('nobody', {
      walletId: shared,
      categoryId: space.expense,
      type: 'expense',
      amount: '7.50',
      timestamp: '2026-09-11T10:00:00.000Z',
      author: lena.userId,
      assignment: 'unassigned',
    });
    // a create of the old build that committed with its operation id
    await query(
      'INSERT INTO transaction_operations (space_id, operation_id, transaction_id, created_at) VALUES (?, ?, ?, ?)',
      [space.id, space.operationId, space.ids.v1Salary, new Date('2026-09-05T10:00:01.000Z')],
    );
  }

  const v2 = (path = '') => `/api/v2/spaces/${space.id}${path}`;
  const api = (member: Member) => {
    const agent = request(testApp.app.getHttpServer());

    return {
      get: (url: string) => agent.get(url).set('Authorization', `Bearer ${member.token}`),
      post: (url: string) => agent.post(url).set('Authorization', `Bearer ${member.token}`),
      patch: (url: string) => agent.patch(url).set('Authorization', `Bearer ${member.token}`),
    };
  };

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

    userIds = [];
    const users = await seedUsers();
    await datesDown();
    await down();
    await seedReleaseA(users);
  });

  afterEach(async () => {
    jest.restoreAllMocks();

    if (!disposable) {
      return;
    }

    if ((await readOwnershipSchema(testApp.dataSource)).hasWallets) {
      await query('UPDATE transactions t INNER JOIN wallets w ON w.id = t.wallet_id SET t.space_id = w.space_id');
      await up();
    }

    await datesUp();
    await deleteUsers(testApp.dataSource, userIds);
  });

  afterAll(async () => {
    if (disposable) {
      await testApp.app.close();
    }
  });

  it('drops the wallets, keeping every record, its owner, the totals and the starting balances', async () => {
    const before = await readTransactionLedger(testApp.dataSource);
    expect(before.spaces.find((ledger) => ledger.space_id === space.id)).toMatchObject({
      transactions: 7,
      owners: expect.any(String),
    });

    await up();

    expect(await schema()).toEqual(MIGRATED);
    const after = await readTransactionLedger(testApp.dataSource);
    expect(compareLedgers(before, after)).toEqual([]);
    expect(after.initial_balances.find((balances) => balances.space_id === space.id)).toEqual({
      space_id: space.id,
      count: 2,
      amount: '540.00',
    });
    expect(await readOwnershipInvariants(testApp.dataSource)).toEqual({
      misplaced: 0,
      withoutAuthor: 0,
      inconsistentAssignments: 0,
    });
    const [{ operations }] = await query<{ operations: number }>(
      'SELECT COUNT(*) AS operations FROM transaction_operations WHERE space_id = ?',
      [space.id],
    );
    expect(Number(operations)).toBe(1);
  });

  it('serves the migrated history through v2, and recovers the pending writes of an old build', async () => {
    await up();
    await datesUp();
    const { owner, lena } = space;
    const september = { from_date: '2026-09-01', to_date: '2026-09-30' };

    const feed = await api(owner)
      .get(`${v2('/transactions/feed')}`)
      .query({ ...september, limit: 100 })
      .expect(200);
    expect(feed.body.items.map((item: { description: string }) => item.description)).toEqual([
      'nobody',
      'forLena',
      'v1Salary',
      'closedExpense',
      'imported',
    ]);
    expect(feed.body.summary).toEqual({ count: 5, income: '2500.00', expense: '164.79' });
    expect(feed.body.items.every((item: object) => !('wallet' in item))).toBe(true);

    const starts = await api(owner)
      .get(`${v2('/transactions/count')}`)
      .query({ from_date: '2026-08-01', to_date: september.to_date, kind: 'initial_balance' })
      .expect(200);
    expect(starts.body).toEqual({ count: 2 });

    const breakdown = await api(owner)
      .get(`${v2('/statistics/breakdown')}`)
      .query({ period: 'month', anchor_date: '2026-09-15', time_zone: 'UTC', as_of: '2026-10-01T00:00:00Z' })
      .expect(200);
    expect(breakdown.body.total).toEqual({ amount: '164.79', count: 4 });
    expect(
      breakdown.body.by_assignment.primary_items.map((item: { key: string; amount: string }) => [
        item.key,
        item.amount,
      ]),
    ).toEqual([
      ['space', '112.29'],
      [`member:${lena.userId}`, '45.00'],
      ['unassigned', '7.50'],
    ]);

    // a create the old build sent before the upgrade: found, and never created twice
    const found = await api(lena)
      .get(`${v2(`/transactions/operations/${space.operationId}`)}`)
      .expect(200);
    expect(found.body).toMatchObject({ status: 'applied', transaction: { id: space.ids.v1Salary, amount: '2500.00' } });
    const resent = await api(lena)
      .post(v2('/transactions'))
      .set('Idempotency-Key', space.operationId)
      .send({
        category_id: space.income,
        transaction_type: 'income',
        amount: '2500.00',
        date: '2026-09-05',
        time_zone: 'America/Chicago',
        client_operation_id: space.operationId,
        assignment: { kind: 'space' },
      })
      .expect(409);
    expect(resent.body.code).toBe('TRANSACTION_OPERATION_EXISTS');

    // a pending edit of a record of a deleted wallet, with its wallet dropped by the client
    const edited = await api(owner)
      .patch(`${v2(`/transactions/${space.ids.closedExpense}`)}`)
      .set('If-Match', '"2"')
      .send({ amount: '100' })
      .expect(200);
    expect(edited.body.transaction).toMatchObject({ amount: '100.00', version: 3 });

    // a new record needs no wallet
    await api(lena)
      .post(v2('/transactions'))
      .send({
        category_id: space.expense,
        transaction_type: 'expense',
        amount: '1.00',
        date: '2026-09-20',
        time_zone: 'America/Chicago',
        assignment: { kind: 'member', user_id: owner.userId },
      })
      .expect(201);

    await request(testApp.app.getHttpServer())
      .get(`/api/v1/spaces/${space.id}/wallets`)
      .set('Authorization', `Bearer ${owner.token}`)
      .expect(410);
  });

  it('refuses to drop anything while a record disagrees with its wallet about its space, naming it', async () => {
    const other = await createVerifiedMember(testApp, 'drop-wallets-other');
    userIds.push(other.userId);
    await query('UPDATE transactions SET space_id = ? WHERE id = ?', [other.spaceId, space.ids.imported]);

    expect(await findMisplacedTransactions(testApp.dataSource)).toEqual([space.ids.imported]);
    await expect(up()).rejects.toThrow(
      new RegExp(`space_id differs from their wallet's space: ${space.ids.imported}\\.`),
    );
    expect(await schema()).toMatchObject({ hasWallets: true, walletsTable: true });

    await query('UPDATE transactions SET space_id = ? WHERE id = ?', [space.id, space.ids.imported]);
    await up();

    expect(await schema()).toEqual(MIGRATED);
  });

  it.each([/DROP FOREIGN KEY/, /DROP INDEX/, /DROP COLUMN `wallet_id`/, /DROP TABLE `wallets`/])(
    'finishes when run again after it stopped before %s',
    async (step) => {
      const before = await readTransactionLedger(testApp.dataSource);

      await expect(up(step)).rejects.toThrow('deploy interrupted');
      await up();

      expect(await schema()).toEqual(MIGRATED);
      expect(compareLedgers(before, await readTransactionLedger(testApp.dataSource))).toEqual([]);
    },
  );

  it('passes when run again after it finished', async () => {
    await up();
    const ledger = await readTransactionLedger(testApp.dataSource);

    await up();

    expect(await schema()).toEqual(MIGRATED);
    expect(compareLedgers(ledger, await readTransactionLedger(testApp.dataSource))).toEqual([]);
  });

  it('reverts to the Release A schema with one wallet per space holding its records', async () => {
    await up();
    const ledger = await readTransactionLedger(testApp.dataSource);

    await down();

    expect(await schema()).toMatchObject({ hasWallets: true, walletsTable: true });
    const wallets = await query<{ wallet_name: string; compat_space_id: number; records: string | number }>(
      `SELECT w.wallet_name, w.compat_space_id, COUNT(t.id) AS records
       FROM wallets w LEFT JOIN transactions t ON t.wallet_id = w.id WHERE w.space_id = ? GROUP BY w.id`,
      [space.id],
    );
    expect(wallets.map((wallet) => ({ ...wallet, records: Number(wallet.records) }))).toEqual([
      { wallet_name: 'Shared transactions', compat_space_id: space.id, records: 7 },
    ]);
    expect(await findMisplacedTransactions(testApp.dataSource)).toEqual([]);
    expect(compareLedgers(ledger, await readTransactionLedger(testApp.dataSource))).toEqual([]);

    await up();

    expect(await schema()).toEqual(MIGRATED);
    expect(compareLedgers(ledger, await readTransactionLedger(testApp.dataSource))).toEqual([]);
  });
});
