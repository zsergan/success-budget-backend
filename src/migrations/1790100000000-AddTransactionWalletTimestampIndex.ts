import type { MigrationInterface, QueryRunner } from 'typeorm';
import { TableIndex } from 'typeorm';

const INDEX_NAME = 'IDX_transactions_wallet_id_timestamp';
// the index MySQL created implicitly for the wallet foreign key
const FOREIGN_KEY_INDEX_NAME = 'FK_0b171330be0cb621f8d73b87a9e';

// Read from information_schema: TypeORM's table metadata leaves out an index
// named after a foreign key.
const hasIndex = async (queryRunner: QueryRunner, name: string): Promise<boolean> => {
  const rows: unknown[] = await queryRunner.query(
    `SELECT 1 FROM information_schema.statistics
     WHERE table_schema = DATABASE() AND table_name = 'transactions' AND index_name = ?
     LIMIT 1`,
    [name],
  );

  return rows.length > 0;
};

/**
 * Period reads (statistics, history, wallet summaries) find a space's
 * wallets and then their transactions within a time range. With only the
 * foreign key index on wallet_id, MySQL read every transaction of a wallet
 * and filtered the timestamps afterwards; this index turns that into a range
 * scan. It also serves the wallet foreign key, which makes the single-column
 * index on wallet_id redundant; down() restores that index before dropping
 * this one, since the key needs an index at all times.
 */
export class AddTransactionWalletTimestampIndex1790100000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.createIndex(
      'transactions',
      new TableIndex({ name: INDEX_NAME, columnNames: ['wallet_id', 'timestamp'] }),
    );

    // MySQL drops it by itself only while it is implicit, i.e. not after a down()
    if (await hasIndex(queryRunner, FOREIGN_KEY_INDEX_NAME)) {
      await queryRunner.query(`DROP INDEX \`${FOREIGN_KEY_INDEX_NAME}\` ON \`transactions\``);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    if (!(await hasIndex(queryRunner, FOREIGN_KEY_INDEX_NAME))) {
      await queryRunner.query(`CREATE INDEX \`${FOREIGN_KEY_INDEX_NAME}\` ON \`transactions\` (\`wallet_id\`)`);
    }

    await queryRunner.dropIndex('transactions', INDEX_NAME);
  }
}
