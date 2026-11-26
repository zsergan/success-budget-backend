import type { QueryRunner } from 'typeorm';

import { AllowCustomCategoryColors1791600000000 } from '../src/migrations/1791600000000-AllowCustomCategoryColors';
import { type TestApp, createTestApp, createVerifiedMember, deleteUsers } from './support/app';
import { assertDisposableDatabase, disposableDatabaseName } from './support/disposable-database';

// Runs AllowCustomCategoryColors over the whole database, like the CLI would.
// Every test leaves the schema migrated. Only `npm run test:e2e:migrations`
// runs it, on a disposable database (test/jest-migration-e2e.config.js).
describe('AllowCustomCategoryColors migration (e2e)', () => {
  let testApp: TestApp;
  let disposable = false;
  const migration = new AllowCustomCategoryColors1791600000000();
  let userIds: number[];

  const query = <T = Record<string, unknown>>(sql: string, parameters?: unknown[]): Promise<T[]> =>
    testApp.dataSource.query(sql, parameters);

  async function withRunner(work: (runner: QueryRunner) => Promise<void>): Promise<void> {
    const runner = testApp.dataSource.createQueryRunner();

    try {
      await work(runner);
    } finally {
      await runner.release();
    }
  }

  const up = () => withRunner((runner) => migration.up(runner));
  const down = () => withRunner((runner) => migration.down(runner));
  const columnType = async () =>
    (
      await query<{ COLUMN_TYPE: string; COLUMN_DEFAULT: string }>(
        `SELECT COLUMN_TYPE, COLUMN_DEFAULT FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'categories' AND COLUMN_NAME = 'color'`,
      )
    )[0];
  const colors = async () =>
    Object.fromEntries(
      (await query<{ id: number; color: string }>('SELECT id, color FROM categories ORDER BY id')).map((row) => [
        row.id,
        row.color,
      ]),
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

    const member = await createVerifiedMember(testApp, 'color-migration');
    userIds = [member.userId];
  });

  afterEach(async () => {
    if (!disposable) {
      return;
    }

    await query("UPDATE categories SET color = 'slate' WHERE color LIKE '#%'");
    await up();
    await deleteUsers(testApp.dataSource, userIds);
  });

  afterAll(async () => {
    if (disposable) {
      await testApp.app.close();
    }
  });

  it('turns the enum into a bounded string, keeping every preset exactly', async () => {
    await down();
    expect(await columnType()).toEqual({
      COLUMN_TYPE: "enum('slate','amber','evergreen','indigo','clay','plum')",
      COLUMN_DEFAULT: 'slate',
    });
    const before = await colors();
    expect(new Set(Object.values(before))).toEqual(new Set(['slate', 'amber', 'evergreen', 'indigo', 'clay', 'plum']));

    await up();

    expect(await columnType()).toEqual({ COLUMN_TYPE: 'varchar(16)', COLUMN_DEFAULT: 'slate' });
    expect(await colors()).toEqual(before);
  });

  it('passes when run again after it finished', async () => {
    const before = await colors();

    await up();

    expect(await columnType()).toEqual({ COLUMN_TYPE: 'varchar(16)', COLUMN_DEFAULT: 'slate' });
    expect(await colors()).toEqual(before);
  });

  it('refuses to revert while a category has a custom color, naming it and changing nothing', async () => {
    const [{ id }] = await query<{ id: number }>('SELECT id FROM categories ORDER BY id DESC LIMIT 1');
    await query("UPDATE categories SET color = '#3A7BD5' WHERE id = ?", [id]);

    await expect(down()).rejects.toThrow(new RegExp(`Categories with a custom color: ${id}\\.`));

    expect(await columnType()).toEqual({ COLUMN_TYPE: 'varchar(16)', COLUMN_DEFAULT: 'slate' });
    expect((await colors())[id]).toBe('#3A7BD5');
  });
});
