import type { MigrationInterface, QueryRunner } from 'typeorm';

const OLD_INDEX = 'IDX_transactions_wallet_id_timestamp';
const NEW_INDEX = 'IDX_transactions_wallet_id_timestamp_id';

/**
 * The transactions feed (docs/feed-performance.md) reads each wallet in
 * (timestamp, id) order and sums whole periods. The new index keeps that
 * order (id is spelled out, so InnoDB does not append it after the other
 * columns) and carries the columns the sums read, so period totals no
 * longer look up every row. It replaces the old index, whose prefix it
 * repeats, and also serves the wallet foreign key: it is created before the
 * old one is dropped, so the key always has an index. Both steps run online.
 */
export class ExtendTransactionWalletTimestampIndex1790500000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE \`transactions\` ADD INDEX \`${NEW_INDEX}\` ` +
        '(`wallet_id`, `timestamp`, `id`, `category_id`, `transaction_type`, `amount`), ALGORITHM=INPLACE, LOCK=NONE',
    );
    await queryRunner.query(`ALTER TABLE \`transactions\` DROP INDEX \`${OLD_INDEX}\`, ALGORITHM=INPLACE, LOCK=NONE`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE \`transactions\` ADD INDEX \`${OLD_INDEX}\` (\`wallet_id\`, \`timestamp\`), ALGORITHM=INPLACE, LOCK=NONE`,
    );
    await queryRunner.query(`ALTER TABLE \`transactions\` DROP INDEX \`${NEW_INDEX}\`, ALGORITHM=INPLACE, LOCK=NONE`);
  }
}
