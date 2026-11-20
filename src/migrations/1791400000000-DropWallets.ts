import type { MigrationInterface, QueryRunner } from 'typeorm';

import { dropForeignKeyOn } from '../database/migration-helpers';

const REPORTED_IDS = 20;
const WALLET_INDEX = 'IDX_transactions_wallet_id_timestamp_id';
const COMPATIBILITY_WALLET_NAME = 'Shared transactions';

/**
 * Release B (docs/transactions-v2-contract.md#release-b): transactions keep
 * only their own space, so the wallet column of transactions, its index and
 * foreign key, and the wallets table go. Every record kept its wallet's space
 * in space_id since AddTransactionSpaceOwnership1791200000000; nothing is
 * dropped while a record disagrees with its wallet.
 *
 * MySQL commits each ALTER TABLE and DROP TABLE on its own, so every step
 * checks what an interrupted run already did. Release A cannot write on the
 * result (its inserts carry wallet_id): it runs in a write pause.
 */
export class DropWallets1791400000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    const hasWalletColumn = await this.hasColumn(queryRunner, 'transactions', 'wallet_id');
    const hasWallets = await this.hasTable(queryRunner, 'wallets');

    if (hasWalletColumn && hasWallets) {
      await this.preflight(queryRunner);
    }

    if (hasWalletColumn) {
      if (await this.hasForeignKeyOn(queryRunner, 'wallet_id')) {
        await dropForeignKeyOn(queryRunner, 'transactions', 'wallet_id');
      }

      if (await this.hasIndex(queryRunner, WALLET_INDEX)) {
        await queryRunner.query(`ALTER TABLE \`transactions\` DROP INDEX \`${WALLET_INDEX}\``);
      }

      await queryRunner.query('ALTER TABLE `transactions` DROP COLUMN `wallet_id`');
    }

    if (hasWallets) {
      await queryRunner.query('DROP TABLE `wallets`');
    }
  }

  // The schema of Release A with one wallet per space that has records,
  // holding all of them, marked as that space's compatibility wallet. The
  // wallets, names and per-wallet balances from before up() are not
  // restored: that takes the backup.
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE \`wallets\` (
        \`id\` int NOT NULL AUTO_INCREMENT,
        \`wallet_name\` varchar(255) NOT NULL,
        \`design\` enum('slate','amber','evergreen','indigo','clay','plum') NOT NULL DEFAULT 'slate',
        \`is_deleted\` tinyint(1) NOT NULL DEFAULT '0',
        \`deleted_at\` timestamp NULL DEFAULT NULL,
        \`created_at\` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
        \`updated_at\` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        \`space_id\` int NOT NULL,
        \`compat_space_id\` int DEFAULT NULL,
        PRIMARY KEY (\`id\`),
        UNIQUE KEY \`UQ_wallets_compat_space\` (\`compat_space_id\`),
        KEY \`FK_13e0029dcbf46f6e5b36657cfdc\` (\`space_id\`),
        CONSTRAINT \`FK_13e0029dcbf46f6e5b36657cfdc\` FOREIGN KEY (\`space_id\`) REFERENCES \`spaces\` (\`id\`) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
    `);
    await queryRunner.query(
      `INSERT INTO \`wallets\` (\`space_id\`, \`wallet_name\`, \`design\`, \`compat_space_id\`)
       SELECT DISTINCT \`space_id\`, ?, 'slate', \`space_id\` FROM \`transactions\` ORDER BY \`space_id\``,
      [COMPATIBILITY_WALLET_NAME],
    );
    await queryRunner.query('ALTER TABLE `transactions` ADD `wallet_id` int NULL AFTER `id`');
    await queryRunner.query(`
      UPDATE \`transactions\` t
      INNER JOIN \`wallets\` w ON w.\`compat_space_id\` = t.\`space_id\`
      SET t.\`wallet_id\` = w.\`id\`
    `);
    await queryRunner.query(`
      ALTER TABLE \`transactions\`
        MODIFY \`wallet_id\` int NOT NULL,
        ADD INDEX \`${WALLET_INDEX}\` (\`wallet_id\`, \`timestamp\`, \`id\`, \`category_id\`, \`transaction_type\`, \`amount\`),
        ADD CONSTRAINT \`FK_0b171330be0cb621f8d73b87a9e\` FOREIGN KEY (\`wallet_id\`) REFERENCES \`wallets\` (\`id\`) ON DELETE CASCADE
    `);
  }

  private async preflight(queryRunner: QueryRunner): Promise<void> {
    const misplaced: { id: string }[] = await queryRunner.query(`
      SELECT t.\`id\` FROM \`transactions\` t
      INNER JOIN \`wallets\` w ON w.\`id\` = t.\`wallet_id\`
      WHERE w.\`space_id\` <> t.\`space_id\`
      ORDER BY t.\`id\`
    `);

    if (misplaced.length) {
      const ids = misplaced.map((row) => row.id);
      const shown = ids.slice(0, REPORTED_IDS).join(', ');
      const listed = ids.length > REPORTED_IDS ? `${shown} and ${ids.length - REPORTED_IDS} more` : shown;

      throw new Error(
        `Cannot drop wallets; nothing was changed by this run. Transactions whose space_id differs from their ` +
          `wallet's space: ${listed}. See docs/deployment.md#rolling-out-the-removal-of-wallets.`,
      );
    }
  }

  private async hasTable(queryRunner: QueryRunner, table: string): Promise<boolean> {
    const rows: unknown[] = await queryRunner.query(
      'SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?',
      [table],
    );

    return rows.length > 0;
  }

  private async hasColumn(queryRunner: QueryRunner, table: string, column: string): Promise<boolean> {
    const rows: unknown[] = await queryRunner.query(
      `SELECT 1 FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
      [table, column],
    );

    return rows.length > 0;
  }

  private async hasIndex(queryRunner: QueryRunner, index: string): Promise<boolean> {
    const rows: unknown[] = await queryRunner.query(
      `SELECT 1 FROM information_schema.STATISTICS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'transactions' AND INDEX_NAME = ?`,
      [index],
    );

    return rows.length > 0;
  }

  private async hasForeignKeyOn(queryRunner: QueryRunner, column: string): Promise<boolean> {
    const rows: unknown[] = await queryRunner.query(
      `SELECT 1 FROM information_schema.KEY_COLUMN_USAGE
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'transactions' AND COLUMN_NAME = ?
         AND REFERENCED_TABLE_NAME IS NOT NULL`,
      [column],
    );

    return rows.length > 0;
  }
}
