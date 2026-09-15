import type { MigrationInterface, QueryRunner } from 'typeorm';
import { TableColumn, TableForeignKey } from 'typeorm';

const TABLES = ['wallets', 'categories', 'limits'] as const;

export class BackfillSpaceIdAndDropUserIdFromWalletsCategoriesLimits1789479151022 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const table of TABLES) {
      await queryRunner.query(`
        UPDATE ${table} t
        INNER JOIN (
          SELECT sm.user_id, MIN(s.id) AS space_id
          FROM space_members sm
          INNER JOIN spaces s ON s.id = sm.space_id AND s.type = 'personal' AND sm.role = 'owner'
          GROUP BY sm.user_id
        ) x ON x.user_id = t.user_id
        SET t.space_id = x.space_id
      `);

      await queryRunner.changeColumn(table, 'space_id', new TableColumn({ name: 'space_id', type: 'int' }));

      const tableSchema = await queryRunner.getTable(table);
      const foreignKey = tableSchema.foreignKeys.find((fk) => fk.columnNames.indexOf('user_id') !== -1);
      await queryRunner.dropForeignKey(table, foreignKey);
      await queryRunner.dropColumn(table, 'user_id');
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // best-effort, same precedent as BackfillPersonalSpacesAndDropUserBaseCurrency's
    // down() - doesn't attempt to recover which specific member owned a
    // resource before the drop, just restores a plausible value
    for (const table of [...TABLES].reverse()) {
      await queryRunner.addColumn(table, new TableColumn({ name: 'user_id', type: 'int', isNullable: true }));

      await queryRunner.query(`
        UPDATE ${table} t
        INNER JOIN space_members sm ON sm.space_id = t.space_id AND sm.role = 'owner'
        SET t.user_id = sm.user_id
      `);

      await queryRunner.changeColumn(table, 'user_id', new TableColumn({ name: 'user_id', type: 'int' }));
      await queryRunner.createForeignKey(
        table,
        new TableForeignKey({
          columnNames: ['user_id'],
          referencedColumnNames: ['id'],
          referencedTableName: 'users',
          onDelete: 'CASCADE',
        }),
      );

      // undo up()'s tightening - space_id goes back to how Migration A left it
      await queryRunner.changeColumn(
        table,
        'space_id',
        new TableColumn({ name: 'space_id', type: 'int', isNullable: true }),
      );
    }
  }
}
