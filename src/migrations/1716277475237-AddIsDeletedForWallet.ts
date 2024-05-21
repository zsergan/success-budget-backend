import { MigrationInterface, QueryRunner, TableColumn } from 'typeorm';

export class AddIsDeletedForWallet1716277475237 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    // Add isDeleted column
    await queryRunner.addColumn(
      'wallets',
      new TableColumn({
        name: 'is_deleted',
        type: 'tinyint',
        length: '1',
        isNullable: false,
        default: 0,
      }),
    );

    // Set all is_deleted fields to false
    await queryRunner.query(`UPDATE wallets SET is_deleted = 0`);

    // Add deleted_at column
    await queryRunner.addColumn(
      'wallets',
      new TableColumn({
        name: 'deleted_at',
        type: 'timestamp',
        isNullable: true,
      }),
    );

    // Rename name to wallet_name
    await queryRunner.renameColumn('wallets', 'name', 'wallet_name');
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.renameColumn('wallets', 'wallet_name', 'name');
    await queryRunner.dropColumn('wallets', 'deleted_at');
    await queryRunner.dropColumn('wallets', 'is_deleted');
  }
}
