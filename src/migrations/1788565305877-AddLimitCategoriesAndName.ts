import { MigrationInterface, QueryRunner, Table, TableColumn, TableForeignKey } from 'typeorm';

/**
 * Limits Stage 4 redesign: a limit can now cover more than one category
 * (a named "group" limit), so the single nullable `category_id` column is
 * replaced with a `limit_categories` join table. A limit with zero rows in
 * it is a "monthly total" limit, one row is a single-category limit, two+
 * rows is a group limit - scope is derived from the row count, not stored.
 */
export class AddLimitCategoriesAndName1788565305877 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    // group limits need a user-editable name (e.g. "Fun"); single-category
    // and total limits don't use this column at all
    await queryRunner.addColumn(
      'limits',
      new TableColumn({
        name: 'name',
        type: 'varchar',
        length: '60',
        isNullable: true,
      }),
    );

    await queryRunner.createTable(
      new Table({
        name: 'limit_categories',
        columns: [
          {
            name: 'limit_id',
            type: 'int',
            isPrimary: true,
          },
          {
            name: 'category_id',
            type: 'int',
            isPrimary: true,
          },
        ],
      }),
    );

    await queryRunner.createForeignKey(
      'limit_categories',
      new TableForeignKey({
        columnNames: ['limit_id'],
        referencedColumnNames: ['id'],
        referencedTableName: 'limits',
        onDelete: 'CASCADE',
      }),
    );

    // matches the Currency/Category cascade policy (RESTRICT) already
    // applied to limits.category_id - see RestrictCurrencyCategoryCascade
    await queryRunner.createForeignKey(
      'limit_categories',
      new TableForeignKey({
        columnNames: ['category_id'],
        referencedColumnNames: ['id'],
        referencedTableName: 'categories',
        onDelete: 'RESTRICT',
      }),
    );

    await queryRunner.query(`
      INSERT INTO limit_categories (limit_id, category_id)
      SELECT id, category_id FROM limits WHERE category_id IS NOT NULL
    `);

    const limitsTable = await queryRunner.getTable('limits');
    const categoryForeignKey = limitsTable.foreignKeys.find((fk) => fk.columnNames.indexOf('category_id') !== -1);
    await queryRunner.dropForeignKey('limits', categoryForeignKey);
    await queryRunner.dropColumn('limits', 'category_id');
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.addColumn(
      'limits',
      new TableColumn({
        name: 'category_id',
        type: 'int',
        isNullable: true,
      }),
    );

    // best-effort: a group limit (2+ categories) can only carry one
    // category_id back, so this picks an arbitrary member - acceptable
    // for a rollback path, since group limits didn't exist before this
    // migration and shouldn't be created on a version that predates it
    await queryRunner.query(`
      UPDATE limits l
      INNER JOIN limit_categories lc ON lc.limit_id = l.id
      SET l.category_id = lc.category_id
    `);

    await queryRunner.createForeignKey(
      'limits',
      new TableForeignKey({
        columnNames: ['category_id'],
        referencedColumnNames: ['id'],
        referencedTableName: 'categories',
        onDelete: 'RESTRICT',
      }),
    );

    await queryRunner.dropTable('limit_categories');
    await queryRunner.dropColumn('limits', 'name');
  }
}
