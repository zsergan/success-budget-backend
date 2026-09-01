import { MigrationInterface, QueryRunner, TableColumn } from 'typeorm';

export class AddAttemptsToConfirmationCodesTable1788221864635 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.addColumn(
      'confirmation_codes',
      new TableColumn({
        name: 'attempts',
        type: 'int',
        default: 0,
        isNullable: false,
      }),
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropColumn('confirmation_codes', 'attempts');
  }
}
