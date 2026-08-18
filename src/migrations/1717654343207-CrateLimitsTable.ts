import { MigrationInterface, QueryRunner, Table, TableForeignKey } from 'typeorm';

export class CrateLimitsTable1717654343207 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    // create limits table
    await queryRunner.createTable(
      new Table({
        name: 'limits',
        columns: [
          {
            name: 'id',
            type: 'int',
            isPrimary: true,
            isGenerated: true,
            generationStrategy: 'increment',
          },
          {
            name: 'user_id',
            type: 'int',
            isNullable: false,
          },
          {
            name: 'category_id',
            type: 'int',
            isNullable: true,
          },
          {
            name: 'limit_type',
            type: 'enum',
            enum: ['category', 'others'],
            isNullable: false,
            default: '"category"',
          },
          {
            name: 'amount',
            type: 'decimal',
            precision: 10,
            scale: 2,
            isNullable: false,
          },
        ],
      }),
    );

    // create foreign key for user_id in limits table
    await queryRunner.createForeignKey(
      'limits',
      new TableForeignKey({
        columnNames: ['user_id'],
        referencedColumnNames: ['id'],
        referencedTableName: 'users',
        onDelete: 'CASCADE',
      }),
    );

    // create foreign key for category_id in limits table
    await queryRunner.createForeignKey(
      'limits',
      new TableForeignKey({
        columnNames: ['category_id'],
        referencedColumnNames: ['id'],
        referencedTableName: 'categories',
        onDelete: 'CASCADE',
      }),
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const table = await queryRunner.getTable('limits');

    // drop foreign key for user_id in limits table
    const userForeignKey = table.foreignKeys.find((fk) => fk.columnNames.indexOf('user_id') !== -1);
    await queryRunner.dropForeignKey('limits', userForeignKey);

    // drop foreign key for category_id in limits table
    const categoryForeignKey = table.foreignKeys.find((fk) => fk.columnNames.indexOf('category_id') !== -1);
    await queryRunner.dropForeignKey('limits', categoryForeignKey);

    // drop limits table
    await queryRunner.dropTable('limits');
  }
}
