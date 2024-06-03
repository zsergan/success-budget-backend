import { MigrationInterface, QueryRunner, TableColumn, TableForeignKey } from 'typeorm';

export class CorrectTransactionToCategoryRelation1717171362376 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    // Add user_category_id column to transactions table
    await queryRunner.addColumn(
      'transactions',
      new TableColumn({
        name: 'user_category_id',
        type: 'int',
        isNullable: true,
      }),
    );

    // Restore data for user_category_id from category_id
    // This involves joining the categories and user_categories tables to create a mapping
    await queryRunner.query(`
        UPDATE transactions
        INNER JOIN categories ON transactions.category_id = categories.id
        INNER JOIN user_categories ON categories.name = user_categories.name AND categories.transaction_type = user_categories.transaction_type
        SET transactions.user_category_id = user_categories.id
    `);

    // Make the column non-nullable
    await queryRunner.changeColumn(
      'transactions',
      'user_category_id',
      new TableColumn({
        name: 'user_category_id',
        type: 'int',
        isNullable: false,
      }),
    );

    // Create foreign key for user_category_id in transactions table
    await queryRunner.createForeignKey(
      'transactions',
      new TableForeignKey({
        columnNames: ['user_category_id'],
        referencedColumnNames: ['id'],
        referencedTableName: 'user_categories',
        onDelete: 'CASCADE',
      }),
    );

    // Get the transactions table
    const transactionsTable = await queryRunner.getTable('transactions');

    // Find the old foreign key
    const oldForeignKey = transactionsTable.foreignKeys.find((fk) => fk.columnNames.indexOf('category_id') !== -1);

    // Drop the old foreign key
    await queryRunner.dropForeignKey('transactions', oldForeignKey);

    // Drop the old column
    await queryRunner.dropColumn('transactions', 'category_id');
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Add category_id column to transactions table
    await queryRunner.addColumn(
      'transactions',
      new TableColumn({
        name: 'category_id',
        type: 'int',
        isNullable: true,
      }),
    );

    // Restore data for category_id from user_category_id
    // This involves joining the categories and user_categories tables to create a mapping
    await queryRunner.query(`
        UPDATE transactions
        INNER JOIN user_categories ON transactions.user_category_id = user_categories.id
        INNER JOIN categories ON user_categories.name = categories.name AND user_categories.transaction_type = categories.transaction_type
        SET transactions.category_id = categories.id
    `);

    // Make the column non-nullable
    await queryRunner.changeColumn(
      'transactions',
      'category_id',
      new TableColumn({
        name: 'category_id',
        type: 'int',
        isNullable: false,
      }),
    );

    // Create foreign key for category_id in transactions table
    await queryRunner.createForeignKey(
      'transactions',
      new TableForeignKey({
        columnNames: ['category_id'],
        referencedColumnNames: ['id'],
        referencedTableName: 'categories',
        onDelete: 'CASCADE',
      }),
    );
  }
}
