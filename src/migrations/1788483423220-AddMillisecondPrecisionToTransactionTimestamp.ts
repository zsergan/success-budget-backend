import type { MigrationInterface, QueryRunner } from 'typeorm';
import { TableColumn } from 'typeorm';

/**
 * transactions.timestamp was a plain MySQL TIMESTAMP (second precision).
 * Two transactions created moments apart - the common case being a
 * client submitting two in quick succession - can land on the exact same
 * second, making "ORDER BY timestamp DESC" return either one
 * non-deterministically for ties. Widening to TIMESTAMP(3) (millisecond)
 * keeps the precision the application already sends via IsDateString
 * instead of silently truncating it on write.
 */
export class AddMillisecondPrecisionToTransactionTimestamp1788483423220 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.changeColumn(
      'transactions',
      'timestamp',
      new TableColumn({
        name: 'timestamp',
        type: 'timestamp',
        precision: 3,
        default: 'CURRENT_TIMESTAMP(3)',
        isNullable: false,
      }),
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.changeColumn(
      'transactions',
      'timestamp',
      new TableColumn({
        name: 'timestamp',
        type: 'timestamp',
        default: 'CURRENT_TIMESTAMP',
        isNullable: false,
      }),
    );
  }
}
