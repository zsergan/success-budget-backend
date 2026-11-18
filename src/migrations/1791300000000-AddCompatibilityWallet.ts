import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Release A only: marks the wallet of a space that holds its v2 records, so
 * that v1 clients read them as wallet records. At most one active wallet per
 * space carries the mark; it is cleared when that wallet is deleted.
 */
export class AddCompatibilityWallet1791300000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    const rows: unknown[] = await queryRunner.query(
      `SELECT 1 FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'wallets' AND COLUMN_NAME = 'compat_space_id'`,
    );

    if (rows.length === 0) {
      await queryRunner.query(
        'ALTER TABLE `wallets` ADD `compat_space_id` int NULL, ADD UNIQUE INDEX `UQ_wallets_compat_space` (`compat_space_id`)',
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'ALTER TABLE `wallets` DROP INDEX `UQ_wallets_compat_space`, DROP COLUMN `compat_space_id`',
    );
  }
}
