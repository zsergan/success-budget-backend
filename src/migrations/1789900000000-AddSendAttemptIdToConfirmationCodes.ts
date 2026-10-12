import type { MigrationInterface, QueryRunner } from 'typeorm';
import { TableColumn } from 'typeorm';

/**
 * Lets markSent()/markFailed() tell a stale send attempt apart from the
 * current one, closing a race where a slow attempt's outcome could
 * overwrite a faster, later attempt's already-settled status (see
 * ConfirmationCodesService.reserveSend()). Existing rows start at 0, same
 * as any row that has never had reserveSend() bump it yet.
 */
export class AddSendAttemptIdToConfirmationCodes1789900000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.addColumn(
      'confirmation_codes',
      new TableColumn({
        name: 'send_attempt_id',
        type: 'int',
        isNullable: false,
        default: 0,
      }),
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropColumn('confirmation_codes', 'send_attempt_id');
  }
}
