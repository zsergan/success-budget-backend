import type { MigrationInterface, QueryRunner } from 'typeorm';
import { TableColumn, TableForeignKey } from 'typeorm';

export class DropWalletAndTransactionCurrencyAndStoredBalance1789600000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    const walletsTable = await queryRunner.getTable('wallets');
    const walletCurrencyFk = walletsTable.foreignKeys.find((fk) => fk.columnNames.indexOf('currency_id') !== -1);
    await queryRunner.dropForeignKey('wallets', walletCurrencyFk);
    await queryRunner.dropColumn('wallets', 'currency_id');
    await queryRunner.dropColumn('wallets', 'balance');

    const transactionsTable = await queryRunner.getTable('transactions');
    const transactionCurrencyFk = transactionsTable.foreignKeys.find(
      (fk) => fk.columnNames.indexOf('currency_id') !== -1,
    );
    await queryRunner.dropForeignKey('transactions', transactionCurrencyFk);
    await queryRunner.dropColumn('transactions', 'currency_id');
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // best-effort - re-adds the columns and repopulates from the space's
    // current single currency (the only value that's still meaningfully
    // true post-Stage-3, not each row's original value)
    await queryRunner.addColumn(
      'transactions',
      new TableColumn({ name: 'currency_id', type: 'int', isNullable: true }),
    );
    await queryRunner.query(`
      UPDATE transactions t
      INNER JOIN wallets w ON w.id = t.wallet_id
      INNER JOIN spaces s ON s.id = w.space_id
      SET t.currency_id = s.currency_id
    `);
    await queryRunner.changeColumn(
      'transactions',
      'currency_id',
      new TableColumn({ name: 'currency_id', type: 'int' }),
    );
    await queryRunner.createForeignKey(
      'transactions',
      new TableForeignKey({
        columnNames: ['currency_id'],
        referencedColumnNames: ['id'],
        referencedTableName: 'currencies',
        onDelete: 'RESTRICT',
      }),
    );

    await queryRunner.addColumn(
      'wallets',
      new TableColumn({ name: 'balance', type: 'decimal', precision: 10, scale: 2, isNullable: true }),
    );
    await queryRunner.query(`
      UPDATE wallets w
      LEFT JOIN (
        SELECT wallet_id, SUM(CASE WHEN transaction_type = 'income' THEN amount ELSE -amount END) AS balance
        FROM transactions GROUP BY wallet_id
      ) t ON t.wallet_id = w.id
      SET w.balance = COALESCE(t.balance, 0)
    `);
    await queryRunner.changeColumn(
      'wallets',
      'balance',
      new TableColumn({ name: 'balance', type: 'decimal', precision: 10, scale: 2 }),
    );

    await queryRunner.addColumn('wallets', new TableColumn({ name: 'currency_id', type: 'int', isNullable: true }));
    await queryRunner.query(
      `UPDATE wallets w INNER JOIN spaces s ON s.id = w.space_id SET w.currency_id = s.currency_id`,
    );
    await queryRunner.changeColumn('wallets', 'currency_id', new TableColumn({ name: 'currency_id', type: 'int' }));
    await queryRunner.createForeignKey(
      'wallets',
      new TableForeignKey({
        columnNames: ['currency_id'],
        referencedColumnNames: ['id'],
        referencedTableName: 'currencies',
        onDelete: 'RESTRICT',
      }),
    );
  }
}
