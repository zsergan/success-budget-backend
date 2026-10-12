import type { MigrationInterface, QueryRunner } from 'typeorm';
import { TableForeignKey } from 'typeorm';

import { dropForeignKeyOn } from '../database/migration-helpers';

/**
 * Currency and Category are shared/reference data, not per-user data owned
 * by a single account - deleting either one should never be able to
 * silently wipe out other users' accounts (via base_currency_id) or
 * transaction history (via category_id). Switches the five FKs pointing
 * at currencies/categories from CASCADE to RESTRICT; FKs pointing at
 * users/wallets (genuinely owned child data) are left as CASCADE.
 */
export class RestrictCurrencyCategoryCascade1788311197732 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await dropForeignKeyOn(queryRunner, 'users', 'base_currency_id');
    await queryRunner.createForeignKey(
      'users',
      new TableForeignKey({
        columnNames: ['base_currency_id'],
        referencedColumnNames: ['id'],
        referencedTableName: 'currencies',
        onDelete: 'RESTRICT',
      }),
    );

    await dropForeignKeyOn(queryRunner, 'wallets', 'currency_id');
    await queryRunner.createForeignKey(
      'wallets',
      new TableForeignKey({
        columnNames: ['currency_id'],
        referencedColumnNames: ['id'],
        referencedTableName: 'currencies',
        onDelete: 'RESTRICT',
      }),
    );

    await dropForeignKeyOn(queryRunner, 'transactions', 'currency_id');
    await queryRunner.createForeignKey(
      'transactions',
      new TableForeignKey({
        columnNames: ['currency_id'],
        referencedColumnNames: ['id'],
        referencedTableName: 'currencies',
        onDelete: 'RESTRICT',
      }),
    );

    await dropForeignKeyOn(queryRunner, 'transactions', 'category_id');
    await queryRunner.createForeignKey(
      'transactions',
      new TableForeignKey({
        columnNames: ['category_id'],
        referencedColumnNames: ['id'],
        referencedTableName: 'categories',
        onDelete: 'RESTRICT',
      }),
    );

    await dropForeignKeyOn(queryRunner, 'limits', 'category_id');
    await queryRunner.createForeignKey(
      'limits',
      new TableForeignKey({
        columnNames: ['category_id'],
        referencedColumnNames: ['id'],
        referencedTableName: 'categories',
        onDelete: 'RESTRICT',
      }),
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await dropForeignKeyOn(queryRunner, 'limits', 'category_id');
    await queryRunner.createForeignKey(
      'limits',
      new TableForeignKey({
        columnNames: ['category_id'],
        referencedColumnNames: ['id'],
        referencedTableName: 'categories',
        onDelete: 'CASCADE',
      }),
    );

    await dropForeignKeyOn(queryRunner, 'transactions', 'category_id');
    await queryRunner.createForeignKey(
      'transactions',
      new TableForeignKey({
        columnNames: ['category_id'],
        referencedColumnNames: ['id'],
        referencedTableName: 'categories',
        onDelete: 'CASCADE',
      }),
    );

    await dropForeignKeyOn(queryRunner, 'transactions', 'currency_id');
    await queryRunner.createForeignKey(
      'transactions',
      new TableForeignKey({
        columnNames: ['currency_id'],
        referencedColumnNames: ['id'],
        referencedTableName: 'currencies',
        onDelete: 'CASCADE',
      }),
    );

    await dropForeignKeyOn(queryRunner, 'wallets', 'currency_id');
    await queryRunner.createForeignKey(
      'wallets',
      new TableForeignKey({
        columnNames: ['currency_id'],
        referencedColumnNames: ['id'],
        referencedTableName: 'currencies',
        onDelete: 'CASCADE',
      }),
    );

    await dropForeignKeyOn(queryRunner, 'users', 'base_currency_id');
    await queryRunner.createForeignKey(
      'users',
      new TableForeignKey({
        columnNames: ['base_currency_id'],
        referencedColumnNames: ['id'],
        referencedTableName: 'currencies',
        onDelete: 'CASCADE',
      }),
    );
  }
}
