import type { MigrationInterface, QueryRunner } from 'typeorm';
import { Table, TableForeignKey, TableIndex } from 'typeorm';

export class CreateSpacesTables1789412793658 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.createTable(
      new Table({
        name: 'spaces',
        columns: [
          { name: 'id', type: 'int', isPrimary: true, isGenerated: true, generationStrategy: 'increment' },
          { name: 'name', type: 'varchar', length: '255' },
          { name: 'type', type: 'enum', enum: ['personal', 'group'] },
          { name: 'currency_id', type: 'int' },
          { name: 'created_at', type: 'timestamp', default: 'CURRENT_TIMESTAMP' },
          { name: 'updated_at', type: 'timestamp', default: 'CURRENT_TIMESTAMP', onUpdate: 'CURRENT_TIMESTAMP' },
        ],
      }),
    );

    await queryRunner.createForeignKey(
      'spaces',
      new TableForeignKey({
        columnNames: ['currency_id'],
        referencedColumnNames: ['id'],
        referencedTableName: 'currencies',
        onDelete: 'RESTRICT',
      }),
    );

    await queryRunner.createTable(
      new Table({
        name: 'space_members',
        columns: [
          { name: 'id', type: 'int', isPrimary: true, isGenerated: true, generationStrategy: 'increment' },
          { name: 'space_id', type: 'int' },
          { name: 'user_id', type: 'int' },
          { name: 'role', type: 'enum', enum: ['owner', 'member'] },
          { name: 'created_at', type: 'timestamp', default: 'CURRENT_TIMESTAMP' },
        ],
      }),
    );

    await queryRunner.createForeignKey(
      'space_members',
      new TableForeignKey({
        columnNames: ['space_id'],
        referencedColumnNames: ['id'],
        referencedTableName: 'spaces',
        onDelete: 'CASCADE',
      }),
    );

    await queryRunner.createForeignKey(
      'space_members',
      new TableForeignKey({
        columnNames: ['user_id'],
        referencedColumnNames: ['id'],
        referencedTableName: 'users',
        onDelete: 'CASCADE',
      }),
    );

    // a user can only be a member of a given space once - membership rows
    // are looked up/upserted by this pair throughout SpaceMembersService
    await queryRunner.createIndex(
      'space_members',
      new TableIndex({
        name: 'IDX_space_members_space_id_user_id',
        columnNames: ['space_id', 'user_id'],
        isUnique: true,
      }),
    );

    await queryRunner.createTable(
      new Table({
        name: 'space_invites',
        columns: [
          { name: 'id', type: 'int', isPrimary: true, isGenerated: true, generationStrategy: 'increment' },
          { name: 'space_id', type: 'int' },
          { name: 'email', type: 'varchar', length: '255' },
          { name: 'code', type: 'varchar', length: '6' },
          { name: 'role', type: 'enum', enum: ['owner', 'member'], default: '"member"' },
          { name: 'expires_at', type: 'timestamp' },
          { name: 'accepted_at', type: 'timestamp', isNullable: true },
          { name: 'revoked_at', type: 'timestamp', isNullable: true },
          { name: 'created_at', type: 'timestamp', default: 'CURRENT_TIMESTAMP' },
        ],
      }),
    );

    await queryRunner.createForeignKey(
      'space_invites',
      new TableForeignKey({
        columnNames: ['space_id'],
        referencedColumnNames: ['id'],
        referencedTableName: 'spaces',
        onDelete: 'CASCADE',
      }),
    );

    // not unique: accepted/expired/revoked rows stay for history, so the
    // "one active invite per (space, email)" rule is enforced in
    // SpaceInvitesService, not here - this index just speeds up that check
    await queryRunner.createIndex(
      'space_invites',
      new TableIndex({ name: 'IDX_space_invites_space_id_email', columnNames: ['space_id', 'email'] }),
    );

    // backs SpaceInvitesService.accept()'s (email, code) lookup
    await queryRunner.createIndex(
      'space_invites',
      new TableIndex({ name: 'IDX_space_invites_email_code', columnNames: ['email', 'code'] }),
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropTable('space_invites');

    const spaceMembersTable = await queryRunner.getTable('space_members');
    const userForeignKey = spaceMembersTable.foreignKeys.find((fk) => fk.columnNames.indexOf('user_id') !== -1);
    await queryRunner.dropForeignKey('space_members', userForeignKey);
    const spaceForeignKey = spaceMembersTable.foreignKeys.find((fk) => fk.columnNames.indexOf('space_id') !== -1);
    await queryRunner.dropForeignKey('space_members', spaceForeignKey);
    await queryRunner.dropTable('space_members');

    const spacesTable = await queryRunner.getTable('spaces');
    const currencyForeignKey = spacesTable.foreignKeys.find((fk) => fk.columnNames.indexOf('currency_id') !== -1);
    await queryRunner.dropForeignKey('spaces', currencyForeignKey);
    await queryRunner.dropTable('spaces');
  }
}
