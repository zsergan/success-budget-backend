import type { MigrationInterface, QueryRunner } from 'typeorm';

import { dropForeignKeyOn } from '../database/migration-helpers';

/**
 * Email delivery state and link nonce of each invitation, and the account
 * that accepted it. Existing invitations become `not_sent` without a nonce:
 * nothing is emailed to them by the deploy, and they get a link with their
 * first email. Rows an older build inserts during the deploy end up the same.
 * One ALTER, so an interrupted run leaves either all of it or none.
 */
export class AddSpaceInviteDelivery1791000000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    const [{ count }]: { count: string | number }[] = await queryRunner.query(
      `SELECT COUNT(*) AS count FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = 'email_status'`,
      ['space_invites'],
    );

    if (Number(count) > 0) {
      return;
    }

    await queryRunner.query(`
      ALTER TABLE \`space_invites\`
        ADD COLUMN \`accepted_by_user_id\` int NULL AFTER \`accepted_at\`,
        ADD COLUMN \`token_nonce\` char(32) CHARACTER SET ascii COLLATE ascii_bin NULL,
        ADD COLUMN \`email_status\` enum('not_sent', 'queued', 'sending', 'sent', 'failed') NOT NULL DEFAULT 'not_sent',
        ADD COLUMN \`email_attempts\` tinyint unsigned NOT NULL DEFAULT 0,
        ADD COLUMN \`email_attempt_id\` int unsigned NOT NULL DEFAULT 0,
        ADD COLUMN \`email_next_attempt_at\` timestamp(3) NULL,
        ADD COLUMN \`email_lease_expires_at\` timestamp(3) NULL,
        ADD COLUMN \`email_last_sent_at\` timestamp(3) NULL,
        ADD INDEX \`IDX_space_invites_email_due\` (\`email_status\`, \`email_next_attempt_at\`),
        ADD CONSTRAINT \`FK_space_invites_accepted_by_user\` FOREIGN KEY (\`accepted_by_user_id\`)
          REFERENCES \`users\` (\`id\`) ON DELETE SET NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await dropForeignKeyOn(queryRunner, 'space_invites', 'accepted_by_user_id');
    await queryRunner.query(`
      ALTER TABLE \`space_invites\`
        DROP INDEX \`IDX_space_invites_email_due\`,
        DROP COLUMN \`accepted_by_user_id\`,
        DROP COLUMN \`token_nonce\`,
        DROP COLUMN \`email_status\`,
        DROP COLUMN \`email_attempts\`,
        DROP COLUMN \`email_attempt_id\`,
        DROP COLUMN \`email_next_attempt_at\`,
        DROP COLUMN \`email_lease_expires_at\`,
        DROP COLUMN \`email_last_sent_at\`
    `);
  }
}
