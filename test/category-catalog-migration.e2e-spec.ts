import { randomUUID } from 'node:crypto';
import type { QueryRunner } from 'typeorm';

import { ReplaceCategoryCatalog1790900000000 } from '../src/migrations/1790900000000-ReplaceCategoryCatalog';
import { SpacesService } from '@modules/spaces/spaces.service';
import { UsersService } from '@modules/users/users.service';
import { DEFAULT_CATEGORIES } from '@shared/constants';
import { SpaceType } from '@shared/enums';
import { PASSWORD, type TestApp, createTestApp, createVerifiedMember, deleteUsers, uniqueEmail } from './support/app';

type Type = 'income' | 'expense';

interface LegacyCategory {
  type: Type;
  name: string;
  icon: string;
  archived?: boolean;
  // the catalog category it should end up in
  target: string;
}

interface CategoryRow {
  id: number;
  name: string;
  transaction_type: Type;
  icon: string;
  color: string;
  is_active: number;
  archived_at: Date | null;
  sort: number;
  is_system: number;
  updated_at: Date;
}

interface TransactionRow {
  id: string;
  wallet_id: number;
  category_id: number;
  transaction_type: Type;
  amount: string;
  timestamp: Date;
  description: string | null;
  version: number;
}

const LEGACY: LegacyCategory[] = [
  { type: 'income', name: 'Salary', icon: 'Salary', target: 'Salary' },
  { type: 'income', name: 'Gifts', icon: 'Gifts', target: 'Gifts' },
  { type: 'income', name: 'Bonus', icon: 'Bonus', target: 'Salary' },
  { type: 'income', name: 'Dividends', icon: 'Dividends', target: 'Other income' },
  { type: 'expense', name: 'Grocery', icon: 'Grocery', target: 'Groceries' },
  { type: 'expense', name: 'Restaurant', icon: 'Restaurant', target: 'Eating out' },
  { type: 'expense', name: 'Coffee shops', icon: 'Cafe', target: 'Eating out' },
  { type: 'expense', name: 'Housing', icon: 'Housing', target: 'Housing' },
  { type: 'expense', name: 'Transport', icon: 'Transport', target: 'Transport' },
  { type: 'expense', name: 'Taxi', icon: 'Taxi', archived: true, target: 'Transport' },
  { type: 'expense', name: 'Fuel', icon: 'Fuel', target: 'Car' },
  { type: 'expense', name: 'Car', icon: 'Car', target: 'Car' },
  { type: 'expense', name: 'Clothes', icon: 'Clothes', target: 'Clothes' },
  { type: 'expense', name: 'Health', icon: 'Health', target: 'Health' },
  { type: 'expense', name: 'Pharmacy', icon: 'Pharmacy', archived: true, target: 'Health' },
  { type: 'expense', name: 'Entertainment', icon: 'Entertainment', target: 'Entertainment' },
  { type: 'expense', name: 'Education', icon: 'Education', target: 'Education' },
  { type: 'expense', name: 'Travel', icon: 'Travel', target: 'Travel' },
  { type: 'expense', name: 'Pets', icon: 'Pets', target: 'Other expenses' },
  { type: 'expense', name: 'Electronics', icon: 'Electronics', target: 'Home goods' },
  { type: 'expense', name: 'Utilities', icon: 'Utilities', target: 'Utilities' },
  { type: 'expense', name: 'Subscriptions', icon: 'Subscriptions', archived: true, target: 'Subscriptions' },
  { type: 'expense', name: 'Mystery', icon: 'Other', target: 'Other expenses' },
  { type: 'expense', name: 'Flowers', icon: 'Gifts', target: 'Gifts' },
];

const key = (type: string, name: string) => `${type}:${name}`;

// DEFAULT_CATEGORIES is grouped by type, so this is its own order
const catalogSort = (index: number) =>
  DEFAULT_CATEGORIES[index].transaction_type === 'income' ? 101 + index : 201 + index - 4;

// Runs the migration over the whole test database, like the CLI would. Every
// test builds its spaces from scratch and removes them afterwards.
describe('ReplaceCategoryCatalog migration (e2e)', () => {
  let testApp: TestApp;
  const migration = new ReplaceCategoryCatalog1790900000000();
  let userIds: number[];

  let personal: { spaceId: number; categories: Map<string, number>; limits: Record<string, number> };
  let group: { spaceId: number; groceries: number; snacks: number };
  let unverifiedSpaceId: number;

  const query = <T = Record<string, unknown>>(sql: string, parameters?: unknown[]): Promise<T[]> =>
    testApp.dataSource.query(sql, parameters);

  beforeAll(async () => {
    testApp = await createTestApp();
  });

  beforeEach(async () => {
    userIds = [];
    const owner = await createVerifiedMember(testApp, 'catalog-owner');
    userIds.push(owner.userId);
    personal = await seedLegacySpace(owner.spaceId);
    group = await seedGroupSpace(owner.userId);

    const unverified = await testApp.app.get(UsersService).register({
      name: 'E2E',
      email: uniqueEmail('catalog-unverified'),
      password: PASSWORD,
      base_currency_id: testApp.currencyId,
    });
    userIds.push(unverified.id);
    [{ space_id: unverifiedSpaceId }] = await query<{ space_id: number }>(
      'SELECT space_id FROM space_members WHERE user_id = ?',
      [unverified.id],
    );
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await deleteUsers(testApp.dataSource, userIds);
  });

  afterAll(async () => {
    await testApp.app.close();
  });

  async function insertCategory(spaceId: number, type: Type, name: string, icon: string, archived = false) {
    const result: { insertId: number } = await testApp.dataSource.query(
      `INSERT INTO categories (space_id, name, transaction_type, icon, color, is_active, archived_at, sort, is_system)
       VALUES (?, ?, ?, ?, 'plum', ?, ?, 0, 0)`,
      [spaceId, name, type, icon, archived ? 0 : 1, archived ? new Date('2026-08-01T00:00:00Z') : null],
    );
    return Number(result.insertId);
  }

  async function insertWallet(spaceId: number, name: string, deleted = false) {
    const result: { insertId: number } = await testApp.dataSource.query(
      'INSERT INTO wallets (wallet_name, design, is_deleted, deleted_at, space_id) VALUES (?, ?, ?, ?, ?)',
      [name, 'slate', deleted ? 1 : 0, deleted ? new Date('2026-09-20T00:00:00Z') : null, spaceId],
    );
    return Number(result.insertId);
  }

  let day = 0;
  async function insertTransaction(walletId: number, categoryId: number, type: Type, amount: string) {
    day = (day % 27) + 1;
    await query(
      `INSERT INTO transactions (id, wallet_id, category_id, transaction_type, amount, timestamp, description, version)
       VALUES (?, ?, ?, ?, ?, ?, ?, 3)`,
      [
        randomUUID(),
        walletId,
        categoryId,
        type,
        amount,
        new Date(Date.UTC(2026, 8, day, 9, 30, 0, 123)),
        `note ${day}`,
      ],
    );
  }

  async function insertLimit(spaceId: number, name: string | null, amount: string, categoryIds: number[]) {
    const result: { insertId: number } = await testApp.dataSource.query(
      'INSERT INTO limits (space_id, name, limit_type, amount) VALUES (?, ?, ?, ?)',
      [spaceId, name, categoryIds.length ? 'category' : 'others', amount],
    );
    const limitId = Number(result.insertId);
    for (const categoryId of categoryIds) {
      await query('INSERT INTO limit_categories (limit_id, category_id) VALUES (?, ?)', [limitId, categoryId]);
    }
    return limitId;
  }

  async function seedLegacySpace(spaceId: number) {
    await query('DELETE FROM categories WHERE space_id = ? AND is_system = 0', [spaceId]);
    const categories = new Map<string, number>();
    for (const category of LEGACY) {
      categories.set(
        key(category.type, category.name),
        await insertCategory(spaceId, category.type, category.name, category.icon, category.archived),
      );
    }
    const id = (type: Type, name: string) => categories.get(key(type, name))!;

    const [{ id: cash }] = await query<{ id: number }>('SELECT id FROM wallets WHERE space_id = ?', [spaceId]);
    const closed = await insertWallet(spaceId, 'Closed card', true);
    const [{ id: system }] = await query<{ id: number }>(
      'SELECT id FROM categories WHERE space_id = ? AND is_system = 1',
      [spaceId],
    );

    await insertTransaction(cash, system, 'income', '1000.00');
    await insertTransaction(cash, id('income', 'Salary'), 'income', '3000.00');
    await insertTransaction(closed, id('income', 'Bonus'), 'income', '500.00');
    await insertTransaction(cash, id('income', 'Dividends'), 'income', '40.10');
    await insertTransaction(cash, id('expense', 'Grocery'), 'expense', '80.50');
    await insertTransaction(closed, id('expense', 'Grocery'), 'expense', '19.50');
    await insertTransaction(cash, id('expense', 'Restaurant'), 'expense', '45.00');
    await insertTransaction(closed, id('expense', 'Coffee shops'), 'expense', '12.30');
    await insertTransaction(cash, id('expense', 'Pharmacy'), 'expense', '20.00');
    await insertTransaction(closed, id('expense', 'Taxi'), 'expense', '15.00');
    await insertTransaction(cash, id('expense', 'Transport'), 'expense', '7.77');
    await insertTransaction(cash, id('expense', 'Pets'), 'expense', '60.00');
    await insertTransaction(cash, id('expense', 'Mystery'), 'expense', '5.00');
    await insertTransaction(cash, id('expense', 'Flowers'), 'expense', '25.00');
    await insertTransaction(cash, id('expense', 'Fuel'), 'expense', '50.00');
    await insertTransaction(cash, id('expense', 'Electronics'), 'expense', '999.99');
    await insertTransaction(closed, id('expense', 'Subscriptions'), 'expense', '9.99');

    const limits = {
      single: await insertLimit(spaceId, null, '300.00', [id('expense', 'Grocery')]),
      fun: await insertLimit(spaceId, 'Fun', '200.00', [
        id('expense', 'Restaurant'),
        id('expense', 'Coffee shops'),
        id('expense', 'Entertainment'),
      ]),
      other: await insertLimit(spaceId, null, '100.00', [id('expense', 'Pets')]),
      total: await insertLimit(spaceId, null, '2000.00', []),
    };

    return { spaceId, categories, limits };
  }

  async function seedGroupSpace(ownerId: number) {
    const space = await testApp.app.get(SpacesService).create(ownerId, {
      name: `e2e-catalog-${Date.now()}`,
      type: SpaceType.GROUP,
      currency_id: testApp.currencyId,
    });
    const [{ id: groceries }] = await query<{ id: number }>(
      "SELECT id FROM categories WHERE space_id = ? AND name = 'Groceries'",
      [space.id],
    );
    const snacks = await insertCategory(space.id, 'expense', 'Snacks', 'Grocery');
    const wallet = await insertWallet(space.id, 'Shared');
    await insertTransaction(wallet, snacks, 'expense', '3.50');
    await insertTransaction(wallet, groceries, 'expense', '10.00');

    return { spaceId: space.id, groceries, snacks };
  }

  async function migrate(failOn?: RegExp, queryRunner?: QueryRunner) {
    const runner = queryRunner ?? testApp.dataSource.createQueryRunner();
    if (failOn) {
      const original = runner.query.bind(runner);
      jest.spyOn(runner, 'query').mockImplementation(((sql: string, ...rest: unknown[]) => {
        if (failOn.test(sql)) {
          return Promise.reject(new Error('injected failure'));
        }
        return (original as (...args: unknown[]) => Promise<unknown>)(sql, ...rest);
      }) as QueryRunner['query']);
    }

    try {
      await migration.up(runner);
    } finally {
      if (!queryRunner) {
        await runner.release();
      }
    }
  }

  const categoriesOf = (spaceId: number) =>
    query<CategoryRow>(
      `SELECT id, name, transaction_type, icon, color, is_active, archived_at, sort, is_system, updated_at
       FROM categories WHERE space_id = ? ORDER BY id`,
      [spaceId],
    );

  const transactionsOf = (spaceId: number) =>
    query<TransactionRow>(
      `SELECT t.id, t.wallet_id, t.category_id, t.transaction_type, t.amount, t.timestamp, t.description, t.version
       FROM transactions t INNER JOIN wallets w ON w.id = t.wallet_id WHERE w.space_id = ? ORDER BY t.id`,
      [spaceId],
    );

  const limitsOf = async (spaceId: number) => {
    const limits = await query<{ id: number; name: string | null; limit_type: string; amount: string }>(
      'SELECT id, name, limit_type, amount FROM limits WHERE space_id = ? ORDER BY id',
      [spaceId],
    );
    const links = await query<{ limit_id: number; category_id: number }>(
      'SELECT limit_id, category_id FROM limit_categories WHERE limit_id IN (?) ORDER BY category_id',
      [limits.length ? limits.map((limit) => limit.id) : [0]],
    );
    return limits.map((limit) => ({
      ...limit,
      category_ids: links.filter((link) => link.limit_id === limit.id).map((link) => link.category_id),
    }));
  };

  const money = (spaceId: number) =>
    query(
      `SELECT w.id AS wallet_id, COUNT(t.id) AS count,
              SUM(CASE t.transaction_type WHEN 'income' THEN t.amount ELSE -t.amount END) AS balance,
              SUM(CASE WHEN t.transaction_type = 'income' AND c.is_system = 0 THEN t.amount ELSE 0 END) AS income,
              SUM(CASE WHEN t.transaction_type = 'expense' THEN t.amount ELSE 0 END) AS expense
       FROM wallets w
       LEFT JOIN transactions t ON t.wallet_id = w.id
       LEFT JOIN categories c ON c.id = t.category_id
       WHERE w.space_id = ? GROUP BY w.id ORDER BY w.id`,
      [spaceId],
    );

  const breakdown = async (spaceId: number) =>
    Object.fromEntries(
      (
        await query<{ type: string; name: string; amount: string }>(
          `SELECT c.transaction_type AS type, c.name, SUM(t.amount) AS amount
           FROM transactions t INNER JOIN categories c ON c.id = t.category_id
           INNER JOIN wallets w ON w.id = t.wallet_id
           WHERE w.space_id = ? GROUP BY c.id ORDER BY c.id`,
          [spaceId],
        )
      ).map((row) => [key(row.type, row.name), Number(row.amount)]),
    );

  const state = async () => {
    const spaces = [personal.spaceId, group.spaceId, unverifiedSpaceId];
    return Promise.all(
      spaces.map(async (spaceId) => ({
        categories: await categoriesOf(spaceId),
        transactions: await transactionsOf(spaceId),
        limits: await limitsOf(spaceId),
      })),
    );
  };

  async function expectCatalog(spaceId: number) {
    const categories = await categoriesOf(spaceId);
    const ordinary = categories
      .filter((category) => !category.is_system)
      .sort((a, b) => a.sort - b.sort)
      .map(({ name, transaction_type, icon, color, is_active, archived_at, sort }) => ({
        name,
        transaction_type,
        icon,
        color,
        is_active,
        archived_at,
        sort,
      }));

    expect(ordinary).toEqual(
      DEFAULT_CATEGORIES.map((category, index) => ({
        name: category.name,
        transaction_type: category.transaction_type,
        icon: category.icon,
        color: category.color,
        is_active: 1,
        archived_at: null,
        sort: catalogSort(index),
      })),
    );
    expect(categories.filter((category) => category.is_system)).toEqual([
      expect.objectContaining({ name: 'Initial balance', transaction_type: 'income' }),
    ]);

    return new Map(categories.map((category) => [key(category.transaction_type, category.name), category.id]));
  }

  it('replaces the catalog, keeping every transaction, balance and limit', async () => {
    const before = await state();
    const [personalBefore, groupBefore] = before;
    const moneyBefore = await money(personal.spaceId);
    const breakdownBefore = await breakdown(personal.spaceId);
    const legacyName = new Map(
      personalBefore.categories.map((category) => [category.id, key(category.transaction_type, category.name)]),
    );

    await migrate();

    const ids = await expectCatalog(personal.spaceId);
    const target = (type: Type, name: string) => ids.get(key(type, name))!;
    const legacy = (type: Type, name: string) => personal.categories.get(key(type, name))!;

    // same name or a known rename keeps the id, an archived one is restored
    expect(target('income', 'Salary')).toBe(legacy('income', 'Salary'));
    expect(target('expense', 'Groceries')).toBe(legacy('expense', 'Grocery'));
    expect(target('expense', 'Eating out')).toBe(legacy('expense', 'Restaurant'));
    expect(target('expense', 'Home goods')).toBe(legacy('expense', 'Electronics'));
    expect(target('expense', 'Car')).toBe(legacy('expense', 'Car'));
    expect(target('expense', 'Subscriptions')).toBe(legacy('expense', 'Subscriptions'));
    const removed = LEGACY.filter((category) => category.target !== category.name)
      .filter((category) => !['Grocery', 'Restaurant', 'Electronics'].includes(category.name))
      .map((category) => legacy(category.type, category.name));
    expect(removed).toHaveLength(9);
    expect([...ids.values()].filter((id) => removed.includes(id))).toEqual([]);

    const expectedTarget = new Map(LEGACY.map((category) => [key(category.type, category.name), category.target]));
    const after = await transactionsOf(personal.spaceId);
    expect(after.map((row) => row.id)).toEqual(personalBefore.transactions.map((row) => row.id));
    for (const [index, row] of personalBefore.transactions.entries()) {
      const name = legacyName.get(row.category_id)!;
      const expectedId = expectedTarget.has(name)
        ? target(row.transaction_type, expectedTarget.get(name)!)
        : row.category_id;
      expect(after[index]).toEqual({
        ...row,
        category_id: expectedId,
        version: expectedId === row.category_id ? row.version : row.version + 1,
      });
    }

    expect(await money(personal.spaceId)).toEqual(moneyBefore);
    const expectedBreakdown: Record<string, number> = {};
    for (const [name, amount] of Object.entries(breakdownBefore)) {
      const [type] = name.split(':');
      const mapped = expectedTarget.has(name) ? key(type, expectedTarget.get(name)!) : name;
      expectedBreakdown[mapped] = Math.round(((expectedBreakdown[mapped] ?? 0) + amount) * 100) / 100;
    }
    expect(await breakdown(personal.spaceId)).toEqual(expectedBreakdown);
    expect(expectedBreakdown).toMatchObject({
      'income:Salary': 3500,
      'expense:Eating out': 57.3,
      'expense:Other expenses': 65,
      'income:Initial balance': 1000,
    });

    expect(await limitsOf(personal.spaceId)).toEqual([
      {
        id: personal.limits.single,
        name: null,
        limit_type: 'category',
        amount: '300.00',
        category_ids: [target('expense', 'Groceries')],
      },
      {
        id: personal.limits.fun,
        name: 'Fun',
        limit_type: 'category',
        amount: '200.00',
        category_ids: [target('expense', 'Eating out'), target('expense', 'Entertainment')].sort((a, b) => a - b),
      },
      {
        id: personal.limits.other,
        name: null,
        limit_type: 'category',
        amount: '100.00',
        category_ids: [target('expense', 'Other expenses')],
      },
      { id: personal.limits.total, name: null, limit_type: 'others', amount: '2000.00', category_ids: [] },
    ]);

    const groupIds = await expectCatalog(group.spaceId);
    expect(groupIds.get('expense:Groceries')).toBe(group.groceries);
    expect(groupIds.has('expense:Snacks')).toBe(false);
    expect((await transactionsOf(group.spaceId)).map((row) => row.category_id)).toEqual(
      groupBefore.transactions.map(() => group.groceries),
    );

    expect(await categoriesOf(unverifiedSpaceId)).toEqual([]);
  });

  it('maps names and icons that are also inherited object properties like any other', async () => {
    const [{ id: cash }] = await query<{ id: number }>(
      "SELECT id FROM wallets WHERE space_id = ? AND wallet_name = 'Cash'",
      [personal.spaceId],
    );
    const cases: { type: Type; name: string; icon: string; target: string }[] = [
      { type: 'expense', name: 'Constructor', icon: 'Home goods', target: 'Home goods' },
      { type: 'expense', name: '__proto__', icon: 'Home goods', target: 'Home goods' },
      { type: 'expense', name: 'Oddity', icon: 'constructor', target: 'Other expenses' },
      { type: 'income', name: 'Royalties', icon: 'constructor', target: 'Other income' },
    ];
    const legacyIds = new Map<number, string>();
    for (const category of cases) {
      const id = await insertCategory(personal.spaceId, category.type, category.name, category.icon);
      legacyIds.set(id, category.target);
      await insertTransaction(cash, id, category.type, '1.25');
    }
    const before = await transactionsOf(personal.spaceId);

    await migrate();

    const ids = await expectCatalog(personal.spaceId);
    const after = await transactionsOf(personal.spaceId);
    expect(after.map((row) => row.id)).toEqual(before.map((row) => row.id));
    expect(after.every((row) => [...ids.values()].includes(row.category_id))).toBe(true);
    const moved = before.filter((row) => legacyIds.has(row.category_id));
    expect(moved).toHaveLength(cases.length);
    for (const row of moved) {
      expect(after.find((found) => found.id === row.id)).toEqual({
        ...row,
        category_id: ids.get(key(row.transaction_type, legacyIds.get(row.category_id)!)),
        version: row.version + 1,
      });
    }
  });

  it('changes nothing when run again after a completed pass', async () => {
    await migrate();
    const migrated = await state();

    await migrate();

    expect(await state()).toEqual(migrated);
  });

  it('stops with a report and changes nothing when limits would merge or collapse', async () => {
    const other = await createVerifiedMember(testApp, 'catalog-conflict');
    userIds.push(other.userId);
    await query('DELETE FROM categories WHERE space_id = ? AND is_system = 0', [other.spaceId]);
    const grocery = await insertCategory(other.spaceId, 'expense', 'Grocery', 'Grocery');
    const supermarket = await insertCategory(other.spaceId, 'expense', 'Corner shop', 'Grocery');
    const taxi = await insertCategory(other.spaceId, 'expense', 'Taxi', 'Taxi');
    const transport = await insertCategory(other.spaceId, 'expense', 'Transport', 'Transport');
    const first = await insertLimit(other.spaceId, null, '100.00', [grocery]);
    const second = await insertLimit(other.spaceId, null, '50.00', [supermarket]);
    const rides = await insertLimit(other.spaceId, 'Rides', '70.00', [taxi, transport]);
    const before = await state();
    const conflictBefore = await categoriesOf(other.spaceId);

    const failure = migrate().then(
      () => {
        throw new Error('expected the migration to stop');
      },
      (error: Error) => error.message,
    );
    const message = await failure;

    expect(message).toContain('stopped before changing any data: 2 limit conflict(s)');
    expect(message).toContain(
      `space ${other.spaceId}: expense category "Groceries" would be in 2 limits: ` +
        `limit #${first} via "Grocery" #${grocery}; limit #${second} via "Corner shop" #${supermarket}`,
    );
    expect(message).toContain(
      `space ${other.spaceId}: group limit #${rides} "Rides" would cover only expense category "Transport"`,
    );
    expect(await state()).toEqual(before);
    expect(await categoriesOf(other.spaceId)).toEqual(conflictBefore);
  });

  it('rolls every change back when a statement fails', async () => {
    const before = await state();

    await expect(migrate(/^DELETE FROM categories/)).rejects.toThrow('injected failure');

    expect(await state()).toEqual(before);
  });

  it('rolls back on its own even after an earlier migration of the run committed implicitly', async () => {
    const before = await state();
    const table = `catalog_probe_${process.pid}`;
    const runner = testApp.dataSource.createQueryRunner();

    try {
      await runner.startTransaction();
      await runner.query(`CREATE TABLE \`${table}\` (id int)`);
      await expect(migrate(/^DELETE FROM categories/, runner)).rejects.toThrow('injected failure');
      await runner.rollbackTransaction();
    } finally {
      jest.restoreAllMocks();
      await runner.query(`DROP TABLE IF EXISTS \`${table}\``);
      await runner.release();
    }

    expect(await state()).toEqual(before);
  });
});
