import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Stored results of writes sent with an Idempotency-Key, so a repeated
 * request returns the original result instead of applying the write again.
 * Keys compare byte for byte (ascii_bin), not case-insensitively.
 */
export class CreateIdempotencyKeys1790300000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE \`idempotency_keys\` (
        \`id\` bigint unsigned NOT NULL AUTO_INCREMENT,
        \`user_id\` int NOT NULL,
        \`space_id\` int NOT NULL,
        \`operation\` varchar(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        \`idempotency_key\` varchar(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        \`request_hash\` char(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        \`response_body\` json NULL,
        \`created_at\` timestamp(3) NOT NULL,
        \`expires_at\` timestamp(3) NOT NULL,
        PRIMARY KEY (\`id\`),
        UNIQUE INDEX \`UQ_idempotency_keys_scope\` (\`user_id\`, \`space_id\`, \`operation\`, \`idempotency_key\`),
        INDEX \`IDX_idempotency_keys_expires_at\` (\`expires_at\`)
      ) ENGINE=InnoDB
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE `idempotency_keys`');
  }
}
