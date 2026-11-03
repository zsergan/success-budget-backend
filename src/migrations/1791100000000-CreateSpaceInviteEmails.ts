import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The invitation emails scheduled in the last 24 hours, for the resend
 * cooldown and the per-invitation, per-address, per-space and per-sender
 * limits. Rows are purged after the window; there are no foreign keys, so
 * deleting a space or an account does not reset the limits.
 */
export class CreateSpaceInviteEmails1791100000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS \`space_invite_emails\` (
        \`id\` bigint unsigned NOT NULL AUTO_INCREMENT,
        \`invite_id\` int NOT NULL,
        \`space_id\` int NOT NULL,
        \`email\` varchar(255) NOT NULL,
        \`sender_user_id\` int NOT NULL,
        \`scheduled_at\` timestamp(3) NOT NULL,
        PRIMARY KEY (\`id\`),
        INDEX \`IDX_space_invite_emails_invite\` (\`invite_id\`, \`scheduled_at\`),
        INDEX \`IDX_space_invite_emails_space\` (\`space_id\`, \`scheduled_at\`),
        INDEX \`IDX_space_invite_emails_email\` (\`email\`, \`scheduled_at\`),
        INDEX \`IDX_space_invite_emails_sender\` (\`sender_user_id\`, \`scheduled_at\`),
        INDEX \`IDX_space_invite_emails_scheduled_at\` (\`scheduled_at\`)
      ) ENGINE=InnoDB
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE `space_invite_emails`');
  }
}
