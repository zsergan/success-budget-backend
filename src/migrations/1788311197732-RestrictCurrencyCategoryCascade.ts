import type { MigrationInterface, QueryRunner } from 'typeorm';
import { TableForeignKey } from 'typeorm';

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
    const usersTable = await queryRunner.getTable('users');
    const baseCurrencyForeignKey = usersTable.foreignKeys.find(
      (fk) => fk.columnNames.indexOf('base_currency_id') !== -1,
    );
    await queryRunner.dropForeignKey('users', baseCurrencyForeignKey);
    await queryRunner.createForeignKey(
      'users',
      new TableForeignKey({
        columnNames: ['base_currency_id'],
        referencedColumnNames: ['id'],
        referencedTableName: 'currencies',
        onDelete: 'RESTRICT',
      }),
    );

    const walletsTable = await queryRunner.getTable('wallets');
    const walletCurrencyForeignKey = walletsTable.foreignKeys.find(
      (fk) => fk.columnNames.indexOf('currency_id') !== -1,
    );
    await queryRunner.dropForeignKey('wallets', walletCurrencyForeignKey);
    await queryRunner.createForeignKey(
      'wallets',
      new TableForeignKey({
        columnNames: ['currency_id'],
        referencedColumnNames: ['id'],
        referencedTableName: 'currencies',
        onDelete: 'RESTRICT',
      }),
    );

    const transactionsTable = await queryRunner.getTable('transactions');
    const transactionCurrencyForeignKey = transactionsTable.foreignKeys.find(
      (fk) => fk.columnNames.indexOf('currency_id') !== -1,
    );
    await queryRunner.dropForeignKey('transactions', transactionCurrencyForeignKey);
    await queryRunner.createForeignKey(
      'transactions',
      new TableForeignKey({
        columnNames: ['currency_id'],
        referencedColumnNames: ['id'],
        referencedTableName: 'currencies',
        onDelete: 'RESTRICT',
      }),
    );

    const transactionCategoryForeignKey = transactionsTable.foreignKeys.find(
      (fk) => fk.columnNames.indexOf('category_id') !== -1,
    );
    await queryRunner.dropForeignKey('transactions', transactionCategoryForeignKey);
    await queryRunner.createForeignKey(
      'transactions',
      new TableForeignKey({
        columnNames: ['category_id'],
        referencedColumnNames: ['id'],
        referencedTableName: 'categories',
        onDelete: 'RESTRICT',
      }),
    );

    const limitsTable = await queryRunner.getTable('limits');
    const limitCategoryForeignKey = limitsTable.foreignKeys.find((fk) => fk.columnNames.indexOf('category_id') !== -1);
    await queryRunner.dropForeignKey('limits', limitCategoryForeignKey);
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
    const limitsTable = await queryRunner.getTable('limits');
    const limitCategoryForeignKey = limitsTable.foreignKeys.find((fk) => fk.columnNames.indexOf('category_id') !== -1);
    await queryRunner.dropForeignKey('limits', limitCategoryForeignKey);
    await queryRunner.createForeignKey(
      'limits',
      new TableForeignKey({
        columnNames: ['category_id'],
        referencedColumnNames: ['id'],
        referencedTableName: 'categories',
        onDelete: 'CASCADE',
      }),
    );

    const transactionsTable = await queryRunner.getTable('transactions');
    const transactionCategoryForeignKey = transactionsTable.foreignKeys.find(
      (fk) => fk.columnNames.indexOf('category_id') !== -1,
    );
    await queryRunner.dropForeignKey('transactions', transactionCategoryForeignKey);
    await queryRunner.createForeignKey(
      'transactions',
      new TableForeignKey({
        columnNames: ['category_id'],
        referencedColumnNames: ['id'],
        referencedTableName: 'categories',
        onDelete: 'CASCADE',
      }),
    );

    const transactionCurrencyForeignKey = transactionsTable.foreignKeys.find(
      (fk) => fk.columnNames.indexOf('currency_id') !== -1,
    );
    await queryRunner.dropForeignKey('transactions', transactionCurrencyForeignKey);
    await queryRunner.createForeignKey(
      'transactions',
      new TableForeignKey({
        columnNames: ['currency_id'],
        referencedColumnNames: ['id'],
        referencedTableName: 'currencies',
        onDelete: 'CASCADE',
      }),
    );

    const walletsTable = await queryRunner.getTable('wallets');
    const walletCurrencyForeignKey = walletsTable.foreignKeys.find(
      (fk) => fk.columnNames.indexOf('currency_id') !== -1,
    );
    await queryRunner.dropForeignKey('wallets', walletCurrencyForeignKey);
    await queryRunner.createForeignKey(
      'wallets',
      new TableForeignKey({
        columnNames: ['currency_id'],
        referencedColumnNames: ['id'],
        referencedTableName: 'currencies',
        onDelete: 'CASCADE',
      }),
    );

    const usersTable = await queryRunner.getTable('users');
    const baseCurrencyForeignKey = usersTable.foreignKeys.find(
      (fk) => fk.columnNames.indexOf('base_currency_id') !== -1,
    );
    await queryRunner.dropForeignKey('users', baseCurrencyForeignKey);
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
