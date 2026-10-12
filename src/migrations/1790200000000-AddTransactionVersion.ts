import type { MigrationInterface, QueryRunner } from 'typeorm';
import { TableColumn } from 'typeorm';

/**
 * A counter bumped on every update of a transaction, so that an edit can
 * be refused when the record changed after the client read it. Existing
 * rows start at 1, as new rows do.
 */
export class AddTransactionVersion1790200000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.addColumn(
      'transactions',
      new TableColumn({ name: 'version', type: 'int', unsigned: true, isNullable: false, default: 1 }),
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropColumn('transactions', 'version');
  }
}
