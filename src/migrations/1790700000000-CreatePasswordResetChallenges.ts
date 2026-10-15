import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The password reset state of one email address: the current code
 * challenge, the reset authorization it issued, and the hourly limits that
 * outlive single challenges. Rows exist for unknown addresses too (user_id
 * NULL), so the public behavior does not depend on whether an account
 * exists. Codes, tokens and addresses are stored only as hashes.
 */
export class CreatePasswordResetChallenges1790700000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE \`password_reset_challenges\` (
        \`id\` bigint unsigned NOT NULL AUTO_INCREMENT,
        \`email_hash\` char(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        \`user_id\` int NULL,
        \`code_hash\` char(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
        \`attempts\` tinyint unsigned NOT NULL DEFAULT 0,
        \`started_at\` timestamp(3) NOT NULL,
        \`expires_at\` timestamp(3) NOT NULL,
        \`last_requested_at\` timestamp(3) NOT NULL,
        \`verified_at\` timestamp(3) NULL,
        \`reset_token_hash\` char(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
        \`reset_token_expires_at\` timestamp(3) NULL,
        \`completed_at\` timestamp(3) NULL,
        \`send_attempt_id\` int unsigned NOT NULL DEFAULT 0,
        \`send_status\` enum('pending', 'sent', 'failed') NULL,
        \`last_sent_at\` timestamp(3) NULL,
        \`window_started_at\` timestamp(3) NOT NULL,
        \`window_requests\` smallint unsigned NOT NULL DEFAULT 0,
        \`window_failed_attempts\` smallint unsigned NOT NULL DEFAULT 0,
        PRIMARY KEY (\`id\`),
        UNIQUE INDEX \`UQ_password_reset_challenges_email_hash\` (\`email_hash\`),
        UNIQUE INDEX \`UQ_password_reset_challenges_reset_token_hash\` (\`reset_token_hash\`),
        CONSTRAINT \`FK_password_reset_challenges_user\` FOREIGN KEY (\`user_id\`) REFERENCES \`users\` (\`id\`) ON DELETE CASCADE
      ) ENGINE=InnoDB
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE `password_reset_challenges`');
  }
}
