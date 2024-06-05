import { MigrationInterface, QueryRunner, TableColumn } from 'typeorm';

export class AddSortFieldToCategoriesTable1717574411843 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    // add sort column to categories table
    await queryRunner.addColumn(
      'categories',
      new TableColumn({
        name: 'sort',
        type: 'int',
        default: 0,
        isNullable: false,
      }),
    );

    // set 0 to all sort fields
    await queryRunner.query(`UPDATE categories SET sort = 0`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // drop sort column from categories table
    await queryRunner.dropColumn('categories', 'sort');
  }
}
