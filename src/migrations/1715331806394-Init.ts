import type { MigrationInterface } from 'typeorm';
import { QueryRunner, Table, TableForeignKey } from 'typeorm';

export class Init1715331806394 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    // create users table
    await queryRunner.createTable(
      new Table({
        name: 'users',
        columns: [
          {
            name: 'id',
            type: 'int',
            isPrimary: true,
            isGenerated: true,
            generationStrategy: 'increment',
          },
          {
            name: 'email',
            type: 'varchar',
            length: '255',
            isNullable: false,
          },
          {
            name: 'name',
            type: 'varchar',
            length: '255',
            isNullable: false,
          },
          {
            name: 'password',
            type: 'varchar',
            length: '255',
            isNullable: false,
          },
          {
            name: 'base_currency_id',
            type: 'int',
            isNullable: false,
          },
        ],
      }),
      true,
    );

    // create currencies table
    await queryRunner.createTable(
      new Table({
        name: 'currencies',
        columns: [
          {
            name: 'id',
            type: 'int',
            isPrimary: true,
            isGenerated: true,
            generationStrategy: 'increment',
          },
          {
            name: 'code',
            type: 'varchar',
            length: '5',
            isNullable: false,
          },
          {
            name: 'name',
            type: 'varchar',
            length: '255',
            isNullable: false,
          },
        ],
      }),
      true,
    );

    // insert default currencies
    await queryRunner.query(`
      INSERT INTO currencies (code, name) VALUES
      ('USD', 'United States Dollar'),
      ('EUR', 'Euro'),
      ('JPY', 'Japanese Yen'),
      ('GBP', 'British Pound Sterling'),
      ('AUD', 'Australian Dollar'),
      ('CAD', 'Canadian Dollar'),
      ('CHF', 'Swiss Franc'),
      ('CNY', 'Chinese Yuan'),
      ('SEK', 'Swedish Krona'),
      ('NZD', 'New Zealand Dollar'),
      ('AMD', 'Armenian Dram'),
      ('RUB', 'Russian Ruble');
    `);

    // create foreign key for base_currency_id in users table
    await queryRunner.createForeignKey(
      'users',
      new TableForeignKey({
        columnNames: ['base_currency_id'],
        referencedColumnNames: ['id'],
        referencedTableName: 'currencies',
        onDelete: 'CASCADE',
      }),
    );

    // create holdings table
    await queryRunner.createTable(
      new Table({
        name: 'holdings',
        columns: [
          {
            name: 'id',
            type: 'int',
            isPrimary: true,
            isGenerated: true,
            generationStrategy: 'increment',
          },
          {
            name: 'user_id',
            type: 'int',
            isNullable: false,
          },
          {
            name: 'name',
            type: 'varchar',
            length: '255',
            isNullable: false,
          },
          {
            name: 'balance',
            type: 'decimal',
            precision: 10,
            scale: 2,
            isNullable: false,
          },
          {
            name: 'currency_id',
            type: 'int',
            isNullable: false,
          },
        ],
      }),
      true,
    );

    // create foreign key for user_id in holdings table
    await queryRunner.createForeignKey(
      'holdings',
      new TableForeignKey({
        columnNames: ['user_id'],
        referencedColumnNames: ['id'],
        referencedTableName: 'users',
        onDelete: 'CASCADE',
      }),
    );

    // create foreign key for currency_id in holdings table
    await queryRunner.createForeignKey(
      'holdings',
      new TableForeignKey({
        columnNames: ['currency_id'],
        referencedColumnNames: ['id'],
        referencedTableName: 'currencies',
        onDelete: 'CASCADE',
      }),
    );

    // create categories table
    await queryRunner.createTable(
      new Table({
        name: 'categories',
        columns: [
          {
            name: 'id',
            type: 'int',
            isPrimary: true,
            isGenerated: true,
            generationStrategy: 'increment',
          },
          {
            name: 'name',
            type: 'varchar',
            length: '255',
            isNullable: false,
          },
          {
            name: 'is_income',
            type: 'tinyint',
            length: '1',
            isNullable: false,
          },
        ],
      }),
      true,
    );

    // insert default categories
    await queryRunner.query(`
      INSERT INTO categories (name, is_income) VALUES
      ('Salary', 1),
      ('Gift', 1),
      ('Housing', 0),
      ('Transportation', 0),
      ('Groceries', 0),
      ('Restaurants', 0),
      ('Car', 0),
      ('Fuel', 0),
      ('Clothing', 0),
      ('Health', 0),
      ('Entertainment', 0),
      ('Education', 0),
      ('Rent', 0),
      ('Travel', 0),
      ('Pets', 0),
      ('Electronics', 0),
      ('Utilities', 0);
    `);

    // create transactions table
    await queryRunner.createTable(
      new Table({
        name: 'transactions',
        columns: [
          {
            name: 'id',
            type: 'varchar',
            length: '36',
            isPrimary: true,
            generationStrategy: 'uuid',
          },
          {
            name: 'holding_id',
            type: 'int',
            isNullable: false,
          },
          {
            name: 'category_id',
            type: 'int',
            isNullable: false,
          },
          {
            name: 'transaction_type',
            type: 'enum',
            enum: ['income', 'expense'],
            isNullable: false,
          },
          {
            name: 'amount',
            type: 'decimal',
            precision: 10,
            scale: 2,
            isNullable: false,
          },
          {
            name: 'timestamp',
            type: 'timestamp',
            default: 'CURRENT_TIMESTAMP',
            isNullable: false,
          },
          {
            name: 'description',
            type: 'text',
            isNullable: true,
          },
        ],
      }),
      true,
    );

    // create foreign key for holding_id in transactions table
    await queryRunner.createForeignKey(
      'transactions',
      new TableForeignKey({
        columnNames: ['holding_id'],
        referencedColumnNames: ['id'],
        referencedTableName: 'holdings',
        onDelete: 'CASCADE',
      }),
    );

    // create foreign key for category_id in transactions table
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

  public async down(queryRunner: QueryRunner): Promise<void> {
    const usersTable = await queryRunner.getTable('users');
    const foreignKey = usersTable.foreignKeys.find((fk) => fk.columnNames.indexOf('base_currency_id') !== -1);
    await queryRunner.dropForeignKey('users', foreignKey);

    const holdingsTable = await queryRunner.getTable('holdings');
    const userForeignKey = holdingsTable.foreignKeys.find((fk) => fk.columnNames.indexOf('user_id') !== -1);
    await queryRunner.dropForeignKey('holdings', userForeignKey);
    const currencyForeignKey = holdingsTable.foreignKeys.find((fk) => fk.columnNames.indexOf('currency_id') !== -1);
    await queryRunner.dropForeignKey('holdings', currencyForeignKey);

    const transactionsTable = await queryRunner.getTable('transactions');
    const holdingForeignKey = transactionsTable.foreignKeys.find((fk) => fk.columnNames.indexOf('holding_id') !== -1);
    await queryRunner.dropForeignKey('transactions', holdingForeignKey);
    const categoryForeignKey = transactionsTable.foreignKeys.find((fk) => fk.columnNames.indexOf('category_id') !== -1);
    await queryRunner.dropForeignKey('transactions', categoryForeignKey);

    await queryRunner.dropTable('users');
    await queryRunner.dropTable('currencies');
    await queryRunner.dropTable('holdings');
    await queryRunner.dropTable('categories');
    await queryRunner.dropTable('transactions');
  }
}
