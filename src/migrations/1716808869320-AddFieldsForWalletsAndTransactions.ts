import { MigrationInterface, QueryRunner, TableColumn, TableForeignKey } from 'typeorm';

export class AddFieldsForWalletsAndTransactions1716808869320 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    // Add currency_id column to transactions table
    await queryRunner.addColumn(
      'transactions',
      new TableColumn({
        name: 'currency_id',
        type: 'int',
        isNullable: false,
      }),
    );

    // Set all currency_id fields to 1
    await queryRunner.query(`UPDATE transactions SET currency_id = 1`);

    // Add foreign key for currency_id in transactions table
    await queryRunner.createForeignKey(
      'transactions',
      new TableForeignKey({
        columnNames: ['currency_id'],
        referencedColumnNames: ['id'],
        referencedTableName: 'currencies',
        onDelete: 'CASCADE',
      }),
    );

    // Add design enum column to wallets table
    await queryRunner.addColumn(
      'wallets',
      new TableColumn({
        name: 'design',
        type: 'enum',
        enum: ['green', 'yellow', 'blue', 'red', 'pink'],
        isNullable: false,
      }),
    );

    // Set all design fields to green
    await queryRunner.query(`UPDATE wallets SET design = 'green'`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Drop foreign key for currency_id in transactions table
    const transactionsTable = await queryRunner.getTable('transactions');
    const foreignKey = transactionsTable.foreignKeys.find((fk) => fk.columnNames.indexOf('currency_id') !== -1);
    await queryRunner.dropForeignKey('transactions', foreignKey);

    // Drop currency_id column from transactions table
    await queryRunner.dropColumn('transactions', 'currency_id');

    // Drop design column from wallets table
    await queryRunner.dropColumn('wallets', 'design');
  }
}
