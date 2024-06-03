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

    // create wallets table
    await queryRunner.createTable(
      new Table({
        name: 'wallets',
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
            name: 'wallet_name',
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
            name: 'design',
            type: 'enum',
            enum: ['green', 'yellow', 'blue', 'red', 'pink'],
            isNullable: false,
            default: '"green"',
          },
          {
            name: 'currency_id',
            type: 'int',
            isNullable: false,
          },
          {
            name: 'is_deleted',
            type: 'tinyint',
            length: '1',
            isNullable: false,
            default: 0,
          },
          {
            name: 'deleted_at',
            type: 'timestamp',
            isNullable: true,
          },
        ],
      }),
      true,
    );

    // create foreign key for user_id in wallets table
    await queryRunner.createForeignKey(
      'wallets',
      new TableForeignKey({
        columnNames: ['user_id'],
        referencedColumnNames: ['id'],
        referencedTableName: 'users',
        onDelete: 'CASCADE',
      }),
    );

    // create foreign key for currency_id in wallets table
    await queryRunner.createForeignKey(
      'wallets',
      new TableForeignKey({
        columnNames: ['currency_id'],
        referencedColumnNames: ['id'],
        referencedTableName: 'currencies',
        onDelete: 'CASCADE',
      }),
    );

    // create user categories table
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
            name: 'user_id',
            type: 'int',
            isNullable: false,
          },
          {
            name: 'name',
            type: 'varchar',
            length: '20',
            isNullable: false,
          },
          {
            name: 'transaction_type',
            type: 'enum',
            enum: ['income', 'expense'],
            isNullable: false,
          },
          {
            name: 'icon',
            type: 'varchar',
            length: '255',
            isNullable: false,
            default: "'store'",
          },
          {
            name: 'color',
            type: 'varchar',
            length: '7',
            isNullable: false,
            default: "'#222831'",
          },
          {
            name: 'is_active',
            type: 'tinyint',
            length: '1',
            isNullable: false,
            default: 1,
          },
        ],
      }),
      true,
    );

    // create foreign key for user_id in user_categories table
    await queryRunner.createForeignKey(
      'categories',
      new TableForeignKey({
        columnNames: ['user_id'],
        referencedColumnNames: ['id'],
        referencedTableName: 'users',
        onDelete: 'CASCADE',
      }),
    );

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
            name: 'wallet_id',
            type: 'int',
            isNullable: false,
          },
          {
            name: 'category_id',
            type: 'int',
            isNullable: false,
          },
          {
            name: 'currency_id',
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

    // create foreign key for wallet_id in transactions table
    await queryRunner.createForeignKey(
      'transactions',
      new TableForeignKey({
        columnNames: ['wallet_id'],
        referencedColumnNames: ['id'],
        referencedTableName: 'wallets',
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
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // drop foreign keys from transactions table
    const transactionsTable = await queryRunner.getTable('transactions');
    const foreignKeyCurrency = transactionsTable.foreignKeys.find((fk) => fk.columnNames.indexOf('currency_id') !== -1);
    await queryRunner.dropForeignKey('transactions', foreignKeyCurrency);

    const foreignKeyCategory = transactionsTable.foreignKeys.find((fk) => fk.columnNames.indexOf('category_id') !== -1);
    await queryRunner.dropForeignKey('transactions', foreignKeyCategory);

    const foreignKeyWallet = transactionsTable.foreignKeys.find((fk) => fk.columnNames.indexOf('wallet_id') !== -1);
    await queryRunner.dropForeignKey('transactions', foreignKeyWallet);

    // drop transactions table
    await queryRunner.dropTable('transactions');

    // drop foreign key for user_id in user_categories table
    const categoriesTable = await queryRunner.getTable('categories');
    const foreignKeyUser = categoriesTable.foreignKeys.find((fk) => fk.columnNames.indexOf('user_id') !== -1);
    await queryRunner.dropForeignKey('categories', foreignKeyUser);

    // drop user categories table
    await queryRunner.dropTable('categories');

    // drop foreign keys for wallets table
    const walletsTable = await queryRunner.getTable('wallets');
    const foreignKeyCurrencyWallet = walletsTable.foreignKeys.find(
      (fk) => fk.columnNames.indexOf('currency_id') !== -1,
    );
    await queryRunner.dropForeignKey('wallets', foreignKeyCurrencyWallet);

    const foreignKeyUserWallet = walletsTable.foreignKeys.find((fk) => fk.columnNames.indexOf('user_id') !== -1);
    await queryRunner.dropForeignKey('wallets', foreignKeyUserWallet);

    // drop wallets table
    await queryRunner.dropTable('wallets');

    // drop foreign key for base_currency_id in users table
    const usersTable = await queryRunner.getTable('users');
    const foreignKeyBaseCurrency = usersTable.foreignKeys.find(
      (fk) => fk.columnNames.indexOf('base_currency_id') !== -1,
    );
    await queryRunner.dropForeignKey('users', foreignKeyBaseCurrency);

    // drop currencies table
    await queryRunner.dropTable('currencies');

    // drop users table
    await queryRunner.dropTable('users');
  }
}
