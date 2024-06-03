import { MigrationInterface, QueryRunner, Table, TableColumn, TableForeignKey } from 'typeorm';

export class CrateUserCategoriesTable1717162595718 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    // Delete all data from categories table
    await queryRunner.query(`DELETE FROM categories`);

    // Reset auto increment to 1 for categories table
    await queryRunner.query(`ALTER TABLE categories AUTO_INCREMENT = 1`);

    // Add 'icon' column to categories table
    await queryRunner.addColumn(
      'categories',
      new TableColumn({
        name: 'icon',
        type: 'varchar',
        length: '255',
        isNullable: false,
        default: "'store'",
      }),
    );

    // insert default categories
    await queryRunner.query(`
      INSERT INTO categories (name, transaction_type, icon) VALUES
      ('Salary', 'income', 'paid'),
      ('Gift', 'income', 'card-giftcard'),
      ('Housing', 'expense', 'home'),
      ('Transportation', 'expense', 'directions-bus'),
      ('Groceries', 'expense', 'shopping-basket'),
      ('Restaurants', 'expense', 'fastfood'),
      ('Car', 'expense', 'directions-car'),
      ('Clothing', 'expense', 'checkroom'),
      ('Health', 'expense', 'healing'),
      ('Entertainment', 'expense', 'sports-esports'),
      ('Education', 'expense', 'school'),
      ('Rent', 'expense', 'money'),
      ('Travel', 'expense', 'flight'),
      ('Pets', 'expense', 'pets'),
      ('Electronics', 'expense', 'cable'),
      ('Utilities', 'expense', 'water-drop');
    `);

    // create user categories table
    await queryRunner.createTable(
      new Table({
        name: 'user_categories',
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
      'user_categories',
      new TableForeignKey({
        columnNames: ['user_id'],
        referencedColumnNames: ['id'],
        referencedTableName: 'users',
        onDelete: 'CASCADE',
      }),
    );

    // Copy all categories from categories table to user_categories table for each user
    await queryRunner.query(`
    INSERT INTO user_categories (user_id, name, transaction_type, icon, color)
    SELECT users.id, categories.name, categories.transaction_type, categories.icon, '#222831'
    FROM users
    CROSS JOIN categories
  `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // drop foreign key for user_id in user_categories table
    const userCategoriesTable = await queryRunner.getTable('user_categories');
    const foreignKey = userCategoriesTable.foreignKeys.find((fk) => fk.columnNames.indexOf('user_id') !== -1);
    await queryRunner.dropForeignKey('user_categories', foreignKey);

    // Drop user_categories table
    await queryRunner.dropTable('user_categories');

    // Drop 'icon' column from categories table
    await queryRunner.dropColumn('categories', 'icon');

    // Reset auto increment to 1 for categories table
    await queryRunner.query(`ALTER TABLE categories AUTO_INCREMENT = 1`);

    // Delete all data from categories table
    await queryRunner.query(`DELETE FROM categories`);

    // insert default categories
    await queryRunner.query(`
      INSERT INTO categories (name, transaction_type) VALUES
      ('Salary', 'income'),
      ('Gift', 'income'),
      ('Housing', 'expense'),
      ('Transportation', 'expense'),
      ('Groceries', 'expense'),
      ('Restaurants', 'expense'),
      ('Car', 'expense'),
      ('Clothing', 'expense'),
      ('Health', 'expense'),
      ('Entertainment', 'expense'),
      ('Education', 'expense'),
      ('Rent', 'expense'),
      ('Travel', 'expense'),
      ('Pets', 'expense'),
      ('Electronics', 'expense'),
      ('Utilities', 'expense');
    `);
  }
}
