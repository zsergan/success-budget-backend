import type { MigrationInterface, QueryRunner } from 'typeorm';
import { TableColumn } from 'typeorm';

/**
 * Distinguishes a send *attempt* from a *confirmed* delivery, so a failed
 * SMTP send can no longer masquerade as a successful resend (see
 * ConfirmationCodesService.reserveSend()). Existing rows are backfilled
 * from their current last_sent_at: a row that was already marked sent
 * keeps that as its last attempt too; everything else starts as pending
 * so the next request is free to retry immediately.
 */
export class AddSendStatusToConfirmationCodes1789800000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.addColumn(
      'confirmation_codes',
      new TableColumn({
        name: 'last_attempted_at',
        type: 'timestamp',
        isNullable: true,
      }),
    );
    await queryRunner.addColumn(
      'confirmation_codes',
      new TableColumn({
        name: 'send_status',
        type: 'enum',
        enum: ['pending', 'sent', 'failed'],
        isNullable: false,
        default: '"pending"',
      }),
    );

    await queryRunner.query(
      `UPDATE confirmation_codes SET last_attempted_at = last_sent_at WHERE last_sent_at IS NOT NULL`,
    );
    await queryRunner.query(`UPDATE confirmation_codes SET send_status = 'sent' WHERE last_sent_at IS NOT NULL`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropColumn('confirmation_codes', 'send_status');
    await queryRunner.dropColumn('confirmation_codes', 'last_attempted_at');
  }
}
