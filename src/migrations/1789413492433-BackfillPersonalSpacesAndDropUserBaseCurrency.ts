import type { MigrationInterface, QueryRunner } from 'typeorm';
import { TableColumn, TableForeignKey } from 'typeorm';

/**
 * Every existing user gets a personal Space + owner SpaceMember backfilled
 * from their current base_currency_id, before that column is dropped - see
 * .private/spaces-implementation-plan.md, Stage 1. Users registered after
 * the previous commit already have one (created in UsersService.register()),
 * so this only actually inserts rows for pre-existing accounts.
 */
export class BackfillPersonalSpacesAndDropUserBaseCurrency1789413492433 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    const users = (await queryRunner.query(`SELECT id, base_currency_id, created_at FROM users`)) as {
      id: number;
      base_currency_id: number;
      created_at: Date;
    }[];

    for (const user of users) {
      const insertResult = (await queryRunner.query(
        `INSERT INTO spaces (name, type, currency_id, created_at, updated_at) VALUES ('Personal', 'personal', ?, ?, ?)`,
        [user.base_currency_id, user.created_at, user.created_at],
      )) as { insertId: number };

      await queryRunner.query(`INSERT INTO space_members (space_id, user_id, role, created_at) VALUES (?, ?, ?, ?)`, [
        insertResult.insertId,
        user.id,
        'owner',
        user.created_at,
      ]);
    }

    const usersTable = await queryRunner.getTable('users');
    const baseCurrencyForeignKey = usersTable.foreignKeys.find(
      (fk) => fk.columnNames.indexOf('base_currency_id') !== -1,
    );
    await queryRunner.dropForeignKey('users', baseCurrencyForeignKey);
    await queryRunner.dropColumn('users', 'base_currency_id');
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.addColumn('users', new TableColumn({ name: 'base_currency_id', type: 'int', isNullable: true }));

    // best-effort, same precedent as AddSharedColorEnumAndCategoryArchive's
    // down() - doesn't attempt to remove the backfilled spaces/space_members
    // rows, just restores a plausible value for the dropped column
    await queryRunner.query(`
      UPDATE users u
      INNER JOIN space_members sm ON sm.user_id = u.id AND sm.role = 'owner'
      INNER JOIN spaces s ON s.id = sm.space_id AND s.type = 'personal'
      SET u.base_currency_id = s.currency_id
    `);

    await queryRunner.changeColumn(
      'users',
      'base_currency_id',
      new TableColumn({ name: 'base_currency_id', type: 'int', isNullable: false }),
    );

    await queryRunner.createForeignKey(
      'users',
      new TableForeignKey({
        columnNames: ['base_currency_id'],
        referencedColumnNames: ['id'],
        referencedTableName: 'currencies',
        onDelete: 'RESTRICT',
      }),
    );
  }
}
