import { MigrationInterface, QueryRunner, TableColumn, TableForeignKey } from 'typeorm';

export class EditHoldingsTable1716210644561 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.renameTable('holdings', 'wallets');

    const transactionsTable = await queryRunner.getTable('transactions');
    const oldForeignKey = transactionsTable.foreignKeys.find((fk) => fk.columnNames.indexOf('holding_id') !== -1);
    await queryRunner.dropForeignKey('transactions', oldForeignKey);

    await queryRunner.changeColumn(
      'transactions',
      'holding_id',
      new TableColumn({
        name: 'wallet_id',
        type: 'int',
        isNullable: false,
      }),
    );

    const newForeignKey = new TableForeignKey({
      columnNames: ['wallet_id'],
      referencedColumnNames: ['id'],
      referencedTableName: 'wallets',
      onDelete: 'CASCADE',
    });

    await queryRunner.createForeignKey('transactions', newForeignKey);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const transactionsTable = await queryRunner.getTable('transactions');
    const newForeignKey = transactionsTable.foreignKeys.find((fk) => fk.columnNames.indexOf('wallet_id') !== -1);
    await queryRunner.dropForeignKey('transactions', newForeignKey);

    await queryRunner.changeColumn(
      'transactions',
      'wallet_id',
      new TableColumn({
        name: 'holding_id',
        type: 'int',
        isNullable: false,
      }),
    );

    const oldForeignKey = new TableForeignKey({
      columnNames: ['holding_id'],
      referencedColumnNames: ['id'],
      referencedTableName: 'holdings',
      onDelete: 'CASCADE',
    });

    await queryRunner.createForeignKey('transactions', oldForeignKey);

    await queryRunner.renameTable('wallets', 'holdings');
  }
}
