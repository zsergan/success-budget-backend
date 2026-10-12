import type { MigrationInterface, QueryRunner } from 'typeorm';
import { TableColumn, TableForeignKey } from 'typeorm';

import { dropForeignKeyOn } from '../database/migration-helpers';

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
      await dropForeignKeyOn(queryRunner, table, 'space_id');
      await queryRunner.dropColumn(table, 'space_id');
    }
  }
}
