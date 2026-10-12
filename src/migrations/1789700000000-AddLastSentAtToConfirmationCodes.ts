import { MigrationInterface, QueryRunner, TableColumn } from 'typeorm';

export class AddLastSentAtToConfirmationCodes1789700000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.addColumn(
      'confirmation_codes',
      new TableColumn({
        name: 'last_sent_at',
        type: 'timestamp',
        isNullable: true,
      }),
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropColumn('confirmation_codes', 'last_sent_at');
  }
}
