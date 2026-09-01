import { MigrationInterface, QueryRunner, TableColumn } from 'typeorm';

const TABLES = ['users', 'wallets', 'categories', 'limits'];

export class AddAuditColumns1788271546105 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const table of TABLES) {
      await queryRunner.addColumns(table, [
        new TableColumn({
          name: 'created_at',
          type: 'timestamp',
          default: 'CURRENT_TIMESTAMP',
        }),
        new TableColumn({
          name: 'updated_at',
          type: 'timestamp',
          default: 'CURRENT_TIMESTAMP',
          onUpdate: 'CURRENT_TIMESTAMP',
        }),
      ]);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const table of TABLES) {
      await queryRunner.dropColumns(table, ['created_at', 'updated_at']);
    }
  }
}
