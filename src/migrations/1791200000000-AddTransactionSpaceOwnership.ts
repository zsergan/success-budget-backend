import type { MigrationInterface, QueryRunner } from 'typeorm';

const REPORTED_IDS = 20;

const INDEXES: Record<string, string> = {
  IDX_transactions_space_timestamp_id:
    '(`space_id`, `timestamp`, `id`, `category_id`, `transaction_type`, `amount`, `assignment_kind`, `assigned_user_id`)',
  IDX_transactions_space_assignment:
    '(`space_id`, `assignment_kind`, `assigned_user_id`, `timestamp`, `id`, `category_id`, `transaction_type`, `amount`)',
  IDX_transactions_author_user: '(`author_user_id`)',
  IDX_transactions_assigned_user: '(`assigned_user_id`)',
};

const FOREIGN_KEYS: Record<string, string> = {
  FK_transactions_space: 'FOREIGN KEY (`space_id`) REFERENCES `spaces` (`id`) ON DELETE CASCADE',
  FK_transactions_author_user: 'FOREIGN KEY (`author_user_id`) REFERENCES `users` (`id`) ON DELETE SET NULL',
  FK_transactions_assigned_user: 'FOREIGN KEY (`assigned_user_id`) REFERENCES `users` (`id`) ON DELETE SET NULL',
};

/**
 * Makes every transaction belong to its space directly, with an author and
 * an assignment (docs/transactions-v2-contract.md#migrating-existing-history).
 * Existing records, those of deleted wallets included, take the space of
 * their wallet, the whole-space assignment and, as an imported author, the
 * space's earliest current membership (created_at, then id): no creator of
 * a space is stored, and the owner role moves between members.
 *
 * MySQL commits each ALTER TABLE on its own, so every step checks what an
 * interrupted run already did. Nothing is changed while a record's wallet or
 * a wallet's space is missing, or while a space with records has no member.
 * The previous app must not write during the run: its inserts lack the new
 * columns, and the last step refuses to finish while such rows exist.
 */
export class AddTransactionSpaceOwnership1791200000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    const migrated = await this.hasColumn(queryRunner, 'space_id');

    await this.preflight(queryRunner, migrated);

    if (!migrated) {
      await queryRunner.query(`
        ALTER TABLE \`transactions\`
          ADD \`space_id\` int NULL,
          ADD \`author_user_id\` int NULL,
          ADD \`author_source\` enum('recorded', 'imported') NULL,
          ADD \`assignment_kind\` enum('member', 'space', 'unassigned') NULL,
          ADD \`assigned_user_id\` int NULL
      `);
    }

    await queryRunner.query(`
      UPDATE \`transactions\` t
      INNER JOIN \`wallets\` w ON w.\`id\` = t.\`wallet_id\`
      INNER JOIN (
        SELECT ranked.\`space_id\`, ranked.\`user_id\`
        FROM (
          SELECT m.\`space_id\`, m.\`user_id\`,
                 ROW_NUMBER() OVER (PARTITION BY m.\`space_id\` ORDER BY m.\`created_at\`, m.\`id\`) AS \`position\`
          FROM \`space_members\` m
        ) ranked
        WHERE ranked.\`position\` = 1
      ) first_member ON first_member.\`space_id\` = w.\`space_id\`
      SET t.\`space_id\` = w.\`space_id\`,
          t.\`author_user_id\` = first_member.\`user_id\`,
          t.\`author_source\` = 'imported',
          t.\`assignment_kind\` = 'space',
          t.\`assigned_user_id\` = NULL
      WHERE t.\`space_id\` IS NULL
    `);

    const [{ incomplete }]: { incomplete: string | number }[] = await queryRunner.query(`
      SELECT COUNT(*) AS incomplete FROM \`transactions\`
      WHERE \`space_id\` IS NULL OR \`author_source\` IS NULL OR \`assignment_kind\` IS NULL
    `);

    if (Number(incomplete) > 0) {
      throw new Error(
        `${incomplete} transactions were written without an owner while this migration ran. ` +
          'Stop the previous app version (see the write pause in docs/deployment.md) and run the migrations again.',
      );
    }

    if (await this.isNullable(queryRunner, 'space_id')) {
      await queryRunner.query(`
        ALTER TABLE \`transactions\`
          MODIFY \`space_id\` int NOT NULL,
          MODIFY \`author_source\` enum('recorded', 'imported') NOT NULL,
          MODIFY \`assignment_kind\` enum('member', 'space', 'unassigned') NOT NULL
      `);
    }

    const indexes = await this.indexNames(queryRunner);
    const missingIndexes = Object.entries(INDEXES).filter(([name]) => !indexes.has(name));

    if (missingIndexes.length) {
      await queryRunner.query(
        `ALTER TABLE \`transactions\` ${missingIndexes.map(([name, columns]) => `ADD INDEX \`${name}\` ${columns}`).join(', ')}`,
      );
    }

    const foreignKeys = await this.foreignKeyNames(queryRunner);
    const missingForeignKeys = Object.entries(FOREIGN_KEYS).filter(([name]) => !foreignKeys.has(name));

    if (missingForeignKeys.length) {
      await queryRunner.query(
        `ALTER TABLE \`transactions\` ${missingForeignKeys
          .map(([name, definition]) => `ADD CONSTRAINT \`${name}\` ${definition}`)
          .join(', ')}`,
      );
    }
  }

  // Loses every author and assignment, and the space of records whose wallet
  // is gone; only for a database no v2 client has written to.
  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const name of Object.keys(FOREIGN_KEYS)) {
      await queryRunner.query(`ALTER TABLE \`transactions\` DROP FOREIGN KEY \`${name}\``);
    }

    for (const name of Object.keys(INDEXES)) {
      await queryRunner.query(`ALTER TABLE \`transactions\` DROP INDEX \`${name}\``);
    }

    await queryRunner.query(`
      ALTER TABLE \`transactions\`
        DROP COLUMN \`assigned_user_id\`,
        DROP COLUMN \`assignment_kind\`,
        DROP COLUMN \`author_source\`,
        DROP COLUMN \`author_user_id\`,
        DROP COLUMN \`space_id\`
    `);
  }

  // Only the records still without a space are checked: the others were
  // moved by an earlier, interrupted run.
  private async preflight(queryRunner: QueryRunner, migrated: boolean): Promise<void> {
    const pending = migrated ? 'AND t.`space_id` IS NULL' : '';
    const problems: string[] = [];

    const orphans: { id: string }[] = await queryRunner.query(`
      SELECT t.\`id\` FROM \`transactions\` t
      LEFT JOIN \`wallets\` w ON w.\`id\` = t.\`wallet_id\`
      WHERE w.\`id\` IS NULL ${pending}
      ORDER BY t.\`id\`
    `);

    if (orphans.length) {
      problems.push(`transactions whose wallet is missing: ${listIds(orphans.map((row) => row.id))}`);
    }

    const walletsWithoutSpace: { id: number }[] = await queryRunner.query(`
      SELECT DISTINCT w.\`id\` FROM \`transactions\` t
      INNER JOIN \`wallets\` w ON w.\`id\` = t.\`wallet_id\`
      LEFT JOIN \`spaces\` s ON s.\`id\` = w.\`space_id\`
      WHERE s.\`id\` IS NULL ${pending}
      ORDER BY w.\`id\`
    `);

    if (walletsWithoutSpace.length) {
      problems.push(
        `wallets with transactions whose space is missing: ${listIds(walletsWithoutSpace.map((row) => row.id))}`,
      );
    }

    const memberless: { space_id: number; transactions: string | number }[] = await queryRunner.query(`
      SELECT w.\`space_id\`, COUNT(*) AS transactions FROM \`transactions\` t
      INNER JOIN \`wallets\` w ON w.\`id\` = t.\`wallet_id\`
      INNER JOIN \`spaces\` s ON s.\`id\` = w.\`space_id\`
      WHERE NOT EXISTS (SELECT 1 FROM \`space_members\` m WHERE m.\`space_id\` = w.\`space_id\`) ${pending}
      GROUP BY w.\`space_id\`
      ORDER BY w.\`space_id\`
    `);

    if (memberless.length) {
      problems.push(
        `spaces with transactions but no member: ${listIds(
          memberless.map((row) => `${row.space_id} (${row.transactions} transactions)`),
        )}`,
      );
    }

    if (problems.length) {
      throw new Error(
        `Cannot move transactions to their spaces; no record was changed by this run. Resolve, then run the ` +
          `migrations again: ${problems.join('; ')}. See docs/deployment.md#rolling-out-space-owned-transactions.`,
      );
    }
  }

  private async hasColumn(queryRunner: QueryRunner, column: string): Promise<boolean> {
    const rows: unknown[] = await queryRunner.query(
      `SELECT 1 FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'transactions' AND COLUMN_NAME = ?`,
      [column],
    );

    return rows.length > 0;
  }

  private async isNullable(queryRunner: QueryRunner, column: string): Promise<boolean> {
    const [row]: { IS_NULLABLE: string }[] = await queryRunner.query(
      `SELECT IS_NULLABLE FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'transactions' AND COLUMN_NAME = ?`,
      [column],
    );

    return row.IS_NULLABLE === 'YES';
  }

  private async indexNames(queryRunner: QueryRunner): Promise<Set<string>> {
    const rows: { INDEX_NAME: string }[] = await queryRunner.query(
      `SELECT DISTINCT INDEX_NAME FROM information_schema.STATISTICS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'transactions'`,
    );

    return new Set(rows.map((row) => row.INDEX_NAME));
  }

  private async foreignKeyNames(queryRunner: QueryRunner): Promise<Set<string>> {
    const rows: { CONSTRAINT_NAME: string }[] = await queryRunner.query(
      `SELECT CONSTRAINT_NAME FROM information_schema.TABLE_CONSTRAINTS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'transactions' AND CONSTRAINT_TYPE = 'FOREIGN KEY'`,
    );

    return new Set(rows.map((row) => row.CONSTRAINT_NAME));
  }
}

function listIds(ids: Array<string | number>): string {
  const shown = ids.slice(0, REPORTED_IDS).join(', ');

  return ids.length > REPORTED_IDS ? `${shown} and ${ids.length - REPORTED_IDS} more` : shown;
}
