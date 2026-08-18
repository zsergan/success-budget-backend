import { MigrationInterface, QueryRunner, Table, TableColumn, TableForeignKey } from 'typeorm';

export class CreateCheckCodesTable1717052838822 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    // add email_verified column to users table
    await queryRunner.addColumn(
      'users',
      new TableColumn({
        name: 'email_verified',
        type: 'tinyint',
        length: '1',
        default: 0,
        isNullable: false,
      }),
    );

    // set all email_verified fields to true
    await queryRunner.query(`UPDATE users SET email_verified = 1`);

    // create confirmation_codes table
    await queryRunner.createTable(
      new Table({
        name: 'confirmation_codes',
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
            name: 'confirmation_code',
            type: 'varchar',
            length: '6',
            isNullable: false,
          },
          {
            name: 'confirmation_type',
            type: 'enum',
            enum: ['email', 'reset_password'],
            isNullable: false,
          },
          {
            name: 'created_at',
            type: 'timestamp',
            default: 'CURRENT_TIMESTAMP',
            isNullable: false,
          },
          {
            name: 'expired_at',
            type: 'timestamp',
            isNullable: false,
          },
        ],
      }),
      true,
    );

    // add foreign key for user_id in confirmation_codes table
    await queryRunner.createForeignKey(
      'confirmation_codes',
      new TableForeignKey({
        columnNames: ['user_id'],
        referencedColumnNames: ['id'],
        referencedTableName: 'users',
        onDelete: 'CASCADE',
      }),
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // drop foreign key for user_id in confirmation_codes table
    const confirmationCodesTable = await queryRunner.getTable('confirmation_codes');
    const foreignKey = confirmationCodesTable.foreignKeys.find((fk) => fk.columnNames.indexOf('user_id') !== -1);
    await queryRunner.dropForeignKey('confirmation_codes', foreignKey);

    // drop confirmation_codes table
    await queryRunner.dropTable('confirmation_codes');

    // drop email_verified column from users table
    await queryRunner.dropColumn('users', 'email_verified');
  }
}
