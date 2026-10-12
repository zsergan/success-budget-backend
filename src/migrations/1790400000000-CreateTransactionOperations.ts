import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The client operation id of every transaction create, kept as long as the
 * space and after the transaction is deleted, so a client can find out what
 * became of a create long after its Idempotency-Key expired.
 */
export class CreateTransactionOperations1790400000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE \`transaction_operations\` (
        \`id\` bigint unsigned NOT NULL AUTO_INCREMENT,
        \`space_id\` int NOT NULL,
        \`operation_id\` char(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        \`transaction_id\` varchar(36) NOT NULL,
        \`created_at\` timestamp(3) NOT NULL,
        \`deleted_at\` timestamp(3) NULL,
        PRIMARY KEY (\`id\`),
        UNIQUE INDEX \`UQ_transaction_operations_space_operation\` (\`space_id\`, \`operation_id\`),
        UNIQUE INDEX \`UQ_transaction_operations_transaction\` (\`transaction_id\`),
        CONSTRAINT \`FK_transaction_operations_space\` FOREIGN KEY (\`space_id\`) REFERENCES \`spaces\` (\`id\`) ON DELETE CASCADE
      ) ENGINE=InnoDB
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE `transaction_operations`');
  }
}
