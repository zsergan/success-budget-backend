import { randomUUID } from 'node:crypto';
import type { QueryRunner } from 'typeorm';

import { AddTransactionSpaceOwnership1791200000000 } from '../src/migrations/1791200000000-AddTransactionSpaceOwnership';
import { AddCompatibilityWallet1791300000000 } from '../src/migrations/1791300000000-AddCompatibilityWallet';
import { DropWallets1791400000000 } from '../src/migrations/1791400000000-DropWallets';
import {
  compareLedgers,
  findOwnershipProblems,
  readOwnershipInvariants,
  readTransactionLedger,
} from '../src/database/transaction-ownership';
import { SpacesService } from '@modules/spaces/spaces.service';
import { SpaceType } from '@shared/enums';
import { type TestApp, createTestApp, createVerifiedMember, deleteUsers } from './support/app';
import { assertDisposableDatabase, disposableDatabaseName } from './support/disposable-database';

interface OwnedRow {
  id: string;
  wallet_space_id: number;
  space_id: number;
  author_user_id: number;
  author_source: string;
  assignment_kind: string;
  assigned_user_id: number | null;
  version: number;
}

// Runs the migration over the whole database, like the CLI would: the schema
// is taken back to before it (through DropWallets1791400000000, which came
// later), legacy rows are written the way the previous app wrote them, and
// the migration runs again. Every test leaves the database fully migrated.
// Only `npm run test:e2e:migrations` runs it, on a disposable database
// (test/jest-migration-e2e.config.js).
describe('AddTransactionSpaceOwnership migration (e2e)', () => {
  let testApp: TestApp;
  let disposable = false;
  const ownership = new AddTransactionSpaceOwnership1791200000000();
  const compatibility = new AddCompatibilityWallet1791300000000();
  const walletRemoval = new DropWallets1791400000000();
  let userIds: number[];
  let strayIds: { spaceIds: number[] };

  let group: { spaceId: number; activeWallet: number; deletedWallet: number; expected: number };
  let personal: { spaceId: number; wallet: number; deletedWallet: number; expected: number };
  let ids: string[];

  const query = <T = Record<string, unknown>>(sql: string, parameters?: unknown[]): Promise<T[]> =>
    testApp.dataSource.query(sql, parameters);

  // Answers like the CLI's query runner; `before` runs ahead of the first
  // statement that matches it, `interruptAt` stops the run there.
  const runner = (options: { interruptAt?: RegExp; before?: [RegExp, () => Promise<unknown>] } = {}) => {
    let hookRan = false;

    return {
      query: async (sql: string, parameters?: unknown[]) => {
        if (options.interruptAt?.test(sql)) {
          throw new Error('deploy interrupted');
        }

        if (options.before && !hookRan && options.before[0].test(sql)) {
          hookRan = true;
          await options.before[1]();
        }

        return testApp.dataSource.query(sql, parameters);
      },
    } as unknown as QueryRunner;
  };

  const hasColumn = async (table: string, column: string) =>
    (
      await query(
        `SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
        [table, column],
      )
    ).length > 0;

  async function migrate(): Promise<void> {
    await ownership.up(runner());
    await compatibility.up(runner());
  }

  async function revert(): Promise<void> {
    if (!(await hasColumn('transactions', 'wallet_id'))) {
      const queryRunner = testApp.dataSource.createQueryRunner();

      try {
        await walletRemoval.down(queryRunner);
      } finally {
        await queryRunner.release();
      }
    }

    await compatibility.down(runner());
    await ownership.down(runner());
  }

  async function removeWallets(): Promise<void> {
    const queryRunner = testApp.dataSource.createQueryRunner();

    try {
      await walletRemoval.up(queryRunner);
    } finally {
      await queryRunner.release();
    }
  }

  async function insertWallet(spaceId: number, name: string, deleted = false): Promise<number> {
    const result: { insertId: number } = await testApp.dataSource.query(
      'INSERT INTO wallets (space_id, wallet_name, design, is_deleted, deleted_at) VALUES (?, ?, ?, ?, ?)',
      [spaceId, name, 'slate', deleted ? 1 : 0, deleted ? new Date('2026-09-20T00:00:00Z') : null],
    );
    return Number(result.insertId);
  }

  async function categoryOf(spaceId: number, where: string): Promise<number> {
    const [row] = await query<{ id: number }>(`SELECT id FROM categories WHERE space_id = ? AND ${where} LIMIT 1`, [
      spaceId,
    ]);
    return Number(row.id);
  }

  // as the previous app wrote it: no space, author or assignment
  async function insertLegacy(walletId: number, categoryId: number, type: string, amount: string, version = 1) {
    const id = randomUUID();
    ids.push(id);
    await query(
      `INSERT INTO transactions (id, wallet_id, category_id, transaction_type, amount, timestamp, description, version)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        walletId,
        categoryId,
        type,
        amount,
        new Date(Date.UTC(2026, (ids.length % 3) + 7, 9, 9, 30, 0, 123)),
        null,
        version,
      ],
    );
    return id;
  }

  async function addMember(spaceId: number, userId: number, role: string, createdAt: string): Promise<void> {
    await query('INSERT INTO space_members (space_id, user_id, role, created_at) VALUES (?, ?, ?, ?)', [
      spaceId,
      userId,
      role,
      new Date(createdAt),
    ]);
  }

  // Written on the schema before the migration: the users and spaces through
  // the app, the wallets and records as the previous app wrote them.
  async function seed(): Promise<void> {
    const creator = await createVerifiedMember(testApp, 'own-creator');
    const first = await createVerifiedMember(testApp, 'own-first');
    const tied = await createVerifiedMember(testApp, 'own-tied');
    const solo = await createVerifiedMember(testApp, 'own-solo');
    userIds.push(creator.userId, first.userId, tied.userId, solo.userId);

    const space = await testApp.app.get(SpacesService).create(creator.userId, {
      name: 'Family',
      type: SpaceType.GROUP,
      currency_id: testApp.currencyId,
    });
    // the creator left; `first` and `tied` joined in the same second, `first`
    // with the lower membership id; `tied` was handed ownership
    await addMember(space.id, first.userId, 'member', '2026-09-02T10:00:00Z');
    await addMember(space.id, tied.userId, 'owner', '2026-09-02T10:00:00Z');
    await query('DELETE FROM space_members WHERE space_id = ? AND user_id = ?', [space.id, creator.userId]);

    group = {
      spaceId: space.id,
      activeWallet: await insertWallet(space.id, 'Card'),
      deletedWallet: await insertWallet(space.id, 'Old card', true),
      expected: first.userId,
    };
    personal = {
      spaceId: solo.spaceId,
      wallet: await insertWallet(solo.spaceId, 'Cash'),
      deletedWallet: await insertWallet(solo.spaceId, 'Closed', true),
      expected: solo.userId,
    };
    await query('UPDATE categories SET is_active = 0, archived_at = NOW() WHERE id = ?', [
      await categoryOf(group.spaceId, "name = 'Travel'"),
    ]);
  }

  async function insertHistory(): Promise<void> {
    const groupExpense = await categoryOf(group.spaceId, "is_system = 0 AND transaction_type = 'expense'");
    const groupIncome = await categoryOf(group.spaceId, "is_system = 0 AND transaction_type = 'income'");
    const archived = await categoryOf(group.spaceId, "name = 'Travel'");
    const groupSystem = await categoryOf(group.spaceId, 'is_system = 1');
    const personalExpense = await categoryOf(personal.spaceId, "is_system = 0 AND transaction_type = 'expense'");
    const personalSystem = await categoryOf(personal.spaceId, 'is_system = 1');

    await insertLegacy(group.activeWallet, groupSystem, 'income', '500.00');
    await insertLegacy(group.activeWallet, groupExpense, 'expense', '12.30', 3);
    await insertLegacy(group.activeWallet, groupIncome, 'income', '2500.00', 2);
    await insertLegacy(group.activeWallet, groupExpense, 'expense', '0.00');
    await insertLegacy(group.deletedWallet, archived, 'expense', '99.99', 5);
    await insertLegacy(group.deletedWallet, groupSystem, 'income', '40.00');
    await insertLegacy(personal.wallet, personalSystem, 'income', '100.00');
    await insertLegacy(personal.wallet, personalExpense, 'expense', '7.50');
    await insertLegacy(personal.deletedWallet, personalExpense, 'expense', '3.25', 4);
  }

  const ownedRows = () =>
    query<OwnedRow>(
      `SELECT t.id, w.space_id AS wallet_space_id, t.space_id, t.author_user_id, t.author_source,
              t.assignment_kind, t.assigned_user_id, t.version
       FROM transactions t INNER JOIN wallets w ON w.id = t.wallet_id WHERE t.id IN (?) ORDER BY t.id`,
      [ids],
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

    userIds = [];
    ids = [];
    strayIds = { spaceIds: [] };
    await revert();
    await seed();
  });

  afterEach(async () => {
    if (!disposable) {
      return;
    }

    if (!(await hasColumn('transactions', 'space_id')) || !(await hasColumn('wallets', 'compat_space_id'))) {
      if (strayIds.spaceIds.length) {
        await query('DELETE t FROM transactions t INNER JOIN wallets w ON w.id = t.wallet_id WHERE w.space_id IN (?)', [
          strayIds.spaceIds,
        ]);
      }

      await migrate();
    }

    if (await hasColumn('transactions', 'wallet_id')) {
      await removeWallets();
    }

    if (strayIds.spaceIds.length) {
      await query('DELETE FROM transactions WHERE space_id IN (?)', [strayIds.spaceIds]);
      await query('DELETE FROM spaces WHERE id IN (?)', [strayIds.spaceIds]);
    }

    await deleteUsers(testApp.dataSource, userIds);
  });

  afterAll(async () => {
    if (disposable) {
      await testApp.app.close();
    }
  });

  it('moves every record to its space, assigned to the space, authored by the earliest current member', async () => {
    await insertHistory();
    const before = await readTransactionLedger(testApp.dataSource);

    await migrate();

    expect(compareLedgers(before, await readTransactionLedger(testApp.dataSource))).toEqual([]);
    expect(await readOwnershipInvariants(testApp.dataSource)).toEqual({
      misplaced: 0,
      withoutAuthor: 0,
      inconsistentAssignments: 0,
    });

    const rows = await ownedRows();
    expect(rows).toHaveLength(9);

    for (const row of rows) {
      expect(row).toMatchObject({
        space_id: row.wallet_space_id,
        author_user_id: row.wallet_space_id === group.spaceId ? group.expected : personal.expected,
        author_source: 'imported',
        assignment_kind: 'space',
        assigned_user_id: null,
      });
    }

    expect(rows.map((row) => Number(row.version)).sort()).toEqual([1, 1, 1, 1, 1, 2, 3, 4, 5]);
  });

  it('keeps the totals, initial balances and versions of every space and month', async () => {
    await insertHistory();
    const before = await readTransactionLedger(testApp.dataSource);
    const groupMonths = before.months.filter((month) => month.space_id === group.spaceId);

    await migrate();
    const after = await readTransactionLedger(testApp.dataSource);

    expect(after.months.filter((month) => month.space_id === group.spaceId)).toEqual(groupMonths);
    expect(after.initial_balances.find((balances) => balances.space_id === group.spaceId)).toEqual({
      space_id: group.spaceId,
      count: 2,
      amount: '540.00',
    });
    expect(after.initial_balances.find((balances) => balances.space_id === personal.spaceId)).toEqual({
      space_id: personal.spaceId,
      count: 1,
      amount: '100.00',
    });
  });

  it('refuses to change anything while a space with records has no member, naming it', async () => {
    await insertHistory();
    const { insertId: strayId }: { insertId: number } = await testApp.dataSource.query(
      "INSERT INTO spaces (name, type, currency_id) VALUES ('Stray', 'group', ?)",
      [testApp.currencyId],
    );
    strayIds.spaceIds.push(Number(strayId));
    await query(
      `INSERT INTO categories (space_id, name, transaction_type, icon, color, is_active, sort, is_system)
       VALUES (?, 'Stray', 'expense', 'Other', 'slate', 1, 0, 0)`,
      [strayId],
    );
    await insertLegacy(
      await insertWallet(Number(strayId), 'Stray'),
      await categoryOf(Number(strayId), '1 = 1'),
      'expense',
      '1.00',
    );

    expect((await findOwnershipProblems(testApp.dataSource)).spacesWithoutMembers).toContainEqual({
      space_id: Number(strayId),
      transactions: 1,
    });
    await expect(ownership.up(runner())).rejects.toThrow(
      new RegExp(`spaces with transactions but no member: .*${strayId} \\(1 transactions\\)`),
    );
    expect(await hasColumn('transactions', 'space_id')).toBe(false);

    await query('DELETE t FROM transactions t INNER JOIN wallets w ON w.id = t.wallet_id WHERE w.space_id = ?', [
      strayId,
    ]);
    ids.pop();
    await migrate();

    expect(await readOwnershipInvariants(testApp.dataSource)).toMatchObject({ misplaced: 0, withoutAuthor: 0 });
  });

  it('finishes when run again after it stopped between its steps', async () => {
    await insertHistory();
    const before = await readTransactionLedger(testApp.dataSource);

    await expect(ownership.up(runner({ interruptAt: /MODIFY `space_id` int NOT NULL/ }))).rejects.toThrow(
      'deploy interrupted',
    );
    // the previous app wrote one more record before the next attempt
    await insertLegacy(
      personal.wallet,
      await categoryOf(personal.spaceId, "transaction_type = 'expense'"),
      'expense',
      '1.00',
    );
    await expect(ownership.up(runner({ interruptAt: /ADD CONSTRAINT/ }))).rejects.toThrow('deploy interrupted');
    await migrate();

    const rows = await ownedRows();
    expect(rows).toHaveLength(10);
    expect(rows.every((row) => row.space_id === row.wallet_space_id && row.author_source === 'imported')).toBe(true);
    expect(compareLedgers(before, await readTransactionLedger(testApp.dataSource))).toEqual([
      expect.stringMatching(/^transactions: \d+ before, \d+ after$/),
      expect.stringMatching(new RegExp(`^space ${personal.spaceId}:`)),
      expect.stringMatching(new RegExp(`^month ${personal.spaceId}/`)),
    ]);
  });

  it('refuses to finish while records are written without an owner during the run', async () => {
    await insertHistory();
    const category = await categoryOf(personal.spaceId, "transaction_type = 'expense'");

    await expect(
      ownership.up(
        runner({ before: [/AS incomplete/, () => insertLegacy(personal.wallet, category, 'expense', '2.00')] }),
      ),
    ).rejects.toThrow(/1 transactions were written without an owner .* write pause/);
    expect(
      (
        await query<{ IS_NULLABLE: string }>(
          `SELECT IS_NULLABLE FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'transactions' AND COLUMN_NAME = 'space_id'`,
        )
      )[0].IS_NULLABLE,
    ).toBe('YES');

    await migrate();

    expect((await ownedRows()).every((row) => row.space_id === row.wallet_space_id)).toBe(true);
  });

  it('passes when run again after it finished', async () => {
    await insertHistory();
    await migrate();
    const ledger = await readTransactionLedger(testApp.dataSource);

    await migrate();

    expect(compareLedgers(ledger, await readTransactionLedger(testApp.dataSource))).toEqual([]);
  });
});
