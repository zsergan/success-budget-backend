import type { MigrationInterface, QueryRunner } from 'typeorm';
import { TableColumn, TableForeignKey } from 'typeorm';

const TABLES = ['wallets', 'categories', 'limits'] as const;

export class AddSpaceIdToWalletsCategoriesLimits1789478240218 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const table of TABLES) {
      await queryRunner.addColumn(table, new TableColumn({ name: 'space_id', type: 'int', isNullable: true }));
      await queryRunner.createForeignKey(
        table,
        new TableForeignKey({
          columnNames: ['space_id'],
          referencedColumnNames: ['id'],
          referencedTableName: 'spaces',
          onDelete: 'CASCADE',
        }),
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const table of [...TABLES].reverse()) {
      const tableSchema = await queryRunner.getTable(table);
      const foreignKey = tableSchema.foreignKeys.find((fk) => fk.columnNames.indexOf('space_id') !== -1);
      await queryRunner.dropForeignKey(table, foreignKey);
      await queryRunner.dropColumn(table, 'space_id');
    }
  }
}
