import { MigrationInterface, QueryRunner, TableColumn } from 'typeorm';

export class CategoryModify1715675780289 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    // Add the new column with a default value
    await queryRunner.addColumn(
      'categories',
      new TableColumn({
        name: 'transaction_type',
        type: 'enum',
        enum: ['income', 'expense'],
        isNullable: false,
      }),
    );

    // Update the new column based on the old column
    await queryRunner.query(`
            UPDATE categories
            SET transaction_type = CASE WHEN is_income = 1 THEN 'income' ELSE 'expense' END
        `);

    // Drop the old column
    await queryRunner.dropColumn('categories', 'is_income');
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Add the old column with a default value
    await queryRunner.addColumn(
      'categories',
      new TableColumn({
        name: 'is_income',
        type: 'tinyint',
        length: '1',
        isNullable: false,
      }),
    );

    // Update the old column based on the new column
    await queryRunner.query(`
            UPDATE categories
            SET is_income = CASE WHEN transaction_type = 'income' THEN 1 ELSE 0 END
        `);

    // Drop the new column
    await queryRunner.dropColumn('categories', 'transaction_type');
  }
}
