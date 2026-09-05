import type { MigrationInterface, QueryRunner } from 'typeorm';
import { TableColumn } from 'typeorm';

/**
 * wallets.design and categories.color move onto one shared 6-value color
 * enum. No principled mapping from the old values to the new ones exists,
 * so every existing row is backfilled to 'slate'. wallets.design goes
 * through a temporary superset enum so existing rows stay valid while
 * they're backfilled, then narrows to the final 6 values.
 */
export class AddSharedColorEnumAndCategoryArchive1788600000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.changeColumn(
      'wallets',
      'design',
      new TableColumn({
        name: 'design',
        type: 'enum',
        enum: ['green', 'yellow', 'blue', 'red', 'pink', 'slate', 'amber', 'evergreen', 'indigo', 'clay', 'plum'],
        isNullable: false,
        default: '"slate"',
      }),
    );
    await queryRunner.query(`UPDATE wallets SET design = 'slate'`);
    await queryRunner.changeColumn(
      'wallets',
      'design',
      new TableColumn({
        name: 'design',
        type: 'enum',
        enum: ['slate', 'amber', 'evergreen', 'indigo', 'clay', 'plum'],
        isNullable: false,
        default: '"slate"',
      }),
    );

    await queryRunner.query(`UPDATE categories SET color = 'slate'`);
    await queryRunner.changeColumn(
      'categories',
      'color',
      new TableColumn({
        name: 'color',
        type: 'enum',
        enum: ['slate', 'amber', 'evergreen', 'indigo', 'clay', 'plum'],
        isNullable: false,
        default: '"slate"',
      }),
    );

    await queryRunner.addColumn(
      'categories',
      new TableColumn({
        name: 'archived_at',
        type: 'timestamp',
        isNullable: true,
      }),
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropColumn('categories', 'archived_at');

    await queryRunner.changeColumn(
      'categories',
      'color',
      new TableColumn({
        name: 'color',
        type: 'varchar',
        length: '7',
        isNullable: false,
        default: "'#222831'",
      }),
    );
    await queryRunner.query(`UPDATE categories SET color = '#222831'`);

    await queryRunner.changeColumn(
      'wallets',
      'design',
      new TableColumn({
        name: 'design',
        type: 'enum',
        enum: ['green', 'yellow', 'blue', 'red', 'pink', 'slate', 'amber', 'evergreen', 'indigo', 'clay', 'plum'],
        isNullable: false,
        default: '"green"',
      }),
    );
    await queryRunner.query(`UPDATE wallets SET design = 'green'`);
    await queryRunner.changeColumn(
      'wallets',
      'design',
      new TableColumn({
        name: 'design',
        type: 'enum',
        enum: ['green', 'yellow', 'blue', 'red', 'pink'],
        isNullable: false,
        default: '"green"',
      }),
    );
  }
}
