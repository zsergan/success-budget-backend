import type { QueryRunner } from 'typeorm';

import { ExtendTransactionWalletTimestampIndex1790500000000 } from '../src/migrations/1790500000000-ExtendTransactionWalletTimestampIndex';
import { type TestApp, createTestApp } from './support/app';

const OLD_INDEX = 'IDX_transactions_wallet_id_timestamp';
const NEW_INDEX = 'IDX_transactions_wallet_id_timestamp_id';

// MySQL commits each ALTER TABLE on its own, so a deploy stopped between the
// steps of a migration, or after them but before the migration is recorded,
// leaves part of the change behind. The next deploy runs the migration again
// and must finish it. Runs on a copy of the table, never on transactions.
describe('ExtendTransactionWalletTimestampIndex migration (e2e)', () => {
  let testApp: TestApp;
  const migration = new ExtendTransactionWalletTimestampIndex1790500000000();
  const table = `migration_probe_${process.pid}`;

  // the wallet foreign key needs an index led by wallet_id after every statement
  let walletKeyCovered: boolean[];

  // Answers like a query runner on the copy; `interruptAt` stops the run
  // before the first statement that matches it.
  const runner = (interruptAt?: RegExp) =>
    ({
      query: async (sql: string, parameters?: unknown[]) => {
        if (interruptAt?.test(sql)) {
          throw new Error('deploy interrupted');
        }

        const result: unknown = await testApp.dataSource.query(
          sql.replaceAll('`transactions`', `\`${table}\``),
          parameters?.map((value) => (value === 'transactions' ? table : value)),
        );

        if (sql.startsWith('ALTER TABLE')) {
          walletKeyCovered.push(await coversWalletKey());
        }

        return result;
      },
    }) as unknown as QueryRunner;

  async function coversWalletKey(): Promise<boolean> {
    const rows: { Column_name: string; Seq_in_index: number }[] = await testApp.dataSource.query(
      `SHOW INDEX FROM \`${table}\``,
    );

    return rows.some((row) => Number(row.Seq_in_index) === 1 && row.Column_name === 'wallet_id');
  }

  async function indexes(): Promise<string[]> {
    const rows: { Key_name: string }[] = await testApp.dataSource.query(`SHOW INDEX FROM \`${table}\``);

    return [...new Set(rows.map((row) => row.Key_name))].filter((name) => name !== 'PRIMARY').sort();
  }

  async function createTable(...keys: string[]) {
    await testApp.dataSource.query(
      `CREATE TABLE \`${table}\` (
        id varchar(36) NOT NULL,
        wallet_id int NOT NULL,
        category_id int NOT NULL,
        transaction_type enum('income','expense') NOT NULL,
        amount decimal(10,2) NOT NULL,
        timestamp timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        PRIMARY KEY (id),
        ${keys.map((key) => `${key},`).join('\n')}
        CONSTRAINT \`FK_${table}_wallet\` FOREIGN KEY (wallet_id) REFERENCES wallets (id) ON DELETE CASCADE
      ) ENGINE=InnoDB`,
    );
  }

  const oldKey = `KEY \`${OLD_INDEX}\` (wallet_id, timestamp)`;
  const newKey = `KEY \`${NEW_INDEX}\` (wallet_id, timestamp, id, category_id, transaction_type, amount)`;

  const keys: Record<string, string> = { [OLD_INDEX]: oldKey, [NEW_INDEX]: newKey };

  beforeAll(async () => {
    testApp = await createTestApp();
  });

  beforeEach(() => {
    walletKeyCovered = [];
  });

  afterEach(async () => {
    await testApp.dataSource.query(`DROP TABLE IF EXISTS \`${table}\``);
    expect(walletKeyCovered).not.toContain(false);
  });

  afterAll(async () => {
    await testApp.app.close();
  });

  describe('up', () => {
    it('replaces the old index', async () => {
      await createTable(oldKey);

      await migration.up(runner());

      expect(await indexes()).toEqual([NEW_INDEX]);
    });

    it('finishes when run again after it stopped between its steps', async () => {
      await createTable(oldKey);
      await expect(migration.up(runner(/DROP INDEX/))).rejects.toThrow('deploy interrupted');
      expect(await indexes()).toEqual([OLD_INDEX, NEW_INDEX].sort());

      await migration.up(runner());

      expect(await indexes()).toEqual([NEW_INDEX]);
    });

    it('passes when run again after it finished but was not recorded', async () => {
      await createTable(oldKey);
      await migration.up(runner());

      await migration.up(runner());

      expect(await indexes()).toEqual([NEW_INDEX]);
    });
  });

  describe('down', () => {
    it('restores the old index', async () => {
      await createTable(newKey);

      await migration.down(runner());

      expect(await indexes()).toEqual([OLD_INDEX]);
    });

    it('finishes when run again after it stopped between its steps', async () => {
      await createTable(newKey);
      await expect(migration.down(runner(/DROP INDEX/))).rejects.toThrow('deploy interrupted');
      expect(await indexes()).toEqual([OLD_INDEX, NEW_INDEX].sort());

      await migration.down(runner());

      expect(await indexes()).toEqual([OLD_INDEX]);
    });

    it('passes when run again after it finished but its record was not removed', async () => {
      await createTable(newKey);
      await migration.down(runner());

      await migration.down(runner());

      expect(await indexes()).toEqual([OLD_INDEX]);
    });
  });

  // the states a stopped deploy can leave, in either direction
  describe.each([
    { state: 'before up', present: [OLD_INDEX] },
    { state: 'between the steps', present: [OLD_INDEX, NEW_INDEX] },
    { state: 'after up', present: [NEW_INDEX] },
  ])('from the schema $state', ({ present }) => {
    it('up leaves only the new index', async () => {
      await createTable(...present.map((name) => keys[name]));

      await migration.up(runner());

      expect(await indexes()).toEqual([NEW_INDEX]);
    });

    it('down leaves only the old index', async () => {
      await createTable(...present.map((name) => keys[name]));

      await migration.down(runner());

      expect(await indexes()).toEqual([OLD_INDEX]);
    });
  });

  describe('an index of the expected name but another definition', () => {
    it.each([
      { case: 'other columns', definition: '(wallet_id, timestamp)' },
      { case: 'another order', definition: '(wallet_id, timestamp, category_id, id, transaction_type, amount)' },
      { case: 'a prefix', definition: '(wallet_id, timestamp, id(8), category_id, transaction_type, amount)' },
      { case: 'unique', definition: 'UNIQUE (wallet_id, timestamp, id, category_id, transaction_type, amount)' },
    ])('stops up with $case and keeps the old index', async ({ definition }) => {
      await createTable(oldKey, definition.replace('(', `KEY \`${NEW_INDEX}\` (`));

      await expect(migration.up(runner())).rejects.toThrow(`Index ${NEW_INDEX} on transactions is ${definition},`);

      expect(await indexes()).toEqual([OLD_INDEX, NEW_INDEX].sort());
    });

    it('stops down and keeps the new index', async () => {
      await createTable(newKey, `KEY \`${OLD_INDEX}\` (timestamp, wallet_id)`);

      await expect(migration.down(runner())).rejects.toThrow(
        `Index ${OLD_INDEX} on transactions is (timestamp, wallet_id), expected (wallet_id, timestamp)`,
      );

      expect(await indexes()).toEqual([OLD_INDEX, NEW_INDEX].sort());
    });
  });
});
