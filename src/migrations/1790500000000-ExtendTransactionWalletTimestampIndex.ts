import type { MigrationInterface, QueryRunner } from 'typeorm';

const TABLE = 'transactions';
const OLD_INDEX = { name: 'IDX_transactions_wallet_id_timestamp', columns: ['wallet_id', 'timestamp'] };
const NEW_INDEX = {
  name: 'IDX_transactions_wallet_id_timestamp_id',
  columns: ['wallet_id', 'timestamp', 'id', 'category_id', 'transaction_type', 'amount'],
};

type IndexDefinition = typeof OLD_INDEX;

const quote = (name: string) => `\`${name}\``;

const describe = (columns: string[]) => `(${columns.join(', ')})`;

// The index as MySQL holds it, e.g. "UNIQUE (wallet_id, timestamp(4))", or
// null when there is none.
async function readIndex(queryRunner: QueryRunner, name: string): Promise<string | null> {
  const rows: { column_name: string; non_unique: number | string; sub_part: number | null }[] = await queryRunner.query(
    `SELECT column_name AS column_name, non_unique AS non_unique, sub_part AS sub_part
       FROM information_schema.statistics
       WHERE table_schema = DATABASE() AND table_name = ? AND index_name = ?
       ORDER BY seq_in_index`,
    [TABLE, name],
  );

  if (rows.length === 0) {
    return null;
  }

  const columns = describe(
    rows.map((row) => (row.sub_part === null ? row.column_name : `${row.column_name}(${row.sub_part})`)),
  );

  return Number(rows[0].non_unique) === 1 ? columns : `UNIQUE ${columns}`;
}

async function ensureIndex(queryRunner: QueryRunner, index: IndexDefinition): Promise<void> {
  const existing = await readIndex(queryRunner, index.name);
  const expected = describe(index.columns);

  if (existing === null) {
    await queryRunner.query(
      `ALTER TABLE ${quote(TABLE)} ADD INDEX ${quote(index.name)} ${describe(index.columns.map(quote))}, ` +
        'ALGORITHM=INPLACE, LOCK=NONE',
    );
  } else if (existing !== expected) {
    throw new Error(
      `Index ${index.name} on ${TABLE} is ${existing}, expected ${expected}; ` +
        'fix it by hand before running this migration again',
    );
  }
}

async function dropIndexIfExists(queryRunner: QueryRunner, index: IndexDefinition): Promise<void> {
  if ((await readIndex(queryRunner, index.name)) !== null) {
    await queryRunner.query(
      `ALTER TABLE ${quote(TABLE)} DROP INDEX ${quote(index.name)}, ALGORITHM=INPLACE, LOCK=NONE`,
    );
  }
}

/**
 * The transactions feed (docs/feed-performance.md) reads each wallet in
 * (timestamp, id) order and sums whole periods. The new index keeps that
 * order (id is spelled out, so InnoDB does not append it after the other
 * columns) and carries the columns the sums read, so period totals no
 * longer look up every row. It replaces the old index, whose prefix it
 * repeats, and also serves the wallet foreign key: it is created before the
 * old one is dropped, so the key always has an index. Both steps run online.
 *
 * Each ALTER TABLE commits on its own, so a run stopped after either step
 * leaves it applied; both directions check the schema first and finish the
 * remaining steps when run again.
 */
export class ExtendTransactionWalletTimestampIndex1790500000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await ensureIndex(queryRunner, NEW_INDEX);
    await dropIndexIfExists(queryRunner, OLD_INDEX);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await ensureIndex(queryRunner, OLD_INDEX);
    await dropIndexIfExists(queryRunner, NEW_INDEX);
  }
}
