import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Must run while the migration file/class is still named
 * `CrateLimitsTable1717654343207` on disk (i.e. before that file's own
 * rename lands) - it corrects the row TypeORM already recorded for it under
 * that typo'd name, so the rename doesn't make TypeORM think the migration
 * was never applied and try to re-run it. On a database that has never run
 * `CrateLimitsTable1717654343207` (a fresh install, where the renamed
 * `CreateLimitsTable1717654343207` file already records itself under the
 * corrected name), this UPDATE simply matches zero rows.
 */
export class FixLimitsTableMigrationName1789410867011 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `UPDATE migrations SET name = 'CreateLimitsTable1717654343207' WHERE name = 'CrateLimitsTable1717654343207'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `UPDATE migrations SET name = 'CrateLimitsTable1717654343207' WHERE name = 'CreateLimitsTable1717654343207'`,
    );
  }
}
