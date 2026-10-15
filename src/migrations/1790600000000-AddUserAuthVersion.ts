import type { MigrationInterface, QueryRunner } from 'typeorm';
import { TableColumn } from 'typeorm';

/**
 * A counter bumped whenever every existing session of the user must end,
 * such as after a password reset. Access tokens carry the version they were
 * issued for. Existing users start at 1, as new users do.
 */
export class AddUserAuthVersion1790600000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.addColumn(
      'users',
      new TableColumn({ name: 'auth_version', type: 'int', unsigned: true, isNullable: false, default: 1 }),
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropColumn('users', 'auth_version');
  }
}
