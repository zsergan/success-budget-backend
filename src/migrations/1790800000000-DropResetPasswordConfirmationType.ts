import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Password resets use password_reset_challenges; confirmation_codes only
 * confirm registration emails. No code ever wrote a reset_password row, and
 * one could not be redeemed, so any found is deleted rather than kept.
 */
export class DropResetPasswordConfirmationType1790800000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query("DELETE FROM `confirmation_codes` WHERE `confirmation_type` = 'reset_password'");
    await queryRunner.query("ALTER TABLE `confirmation_codes` MODIFY `confirmation_type` enum ('email') NOT NULL");
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      "ALTER TABLE `confirmation_codes` MODIFY `confirmation_type` enum ('email', 'reset_password') NOT NULL",
    );
  }
}
