import type { QueryRunner, Table, TableForeignKey } from 'typeorm';

import { AddSpaceInviteDelivery1791000000000 } from '../src/migrations/1791000000000-AddSpaceInviteDelivery';
import { type TestApp, createTestApp } from './support/app';

const ORIGINAL_COLUMNS = [
  'id',
  'space_id',
  'email',
  'code',
  'role',
  'expires_at',
  'accepted_at',
  'revoked_at',
  'created_at',
];

interface ProbeRow {
  id: number;
  email: string;
  code: string;
  accepted_at: Date | null;
  accepted_by_user_id: number | null;
  token_nonce: string | null;
  email_status: string;
  email_attempts: number;
  email_attempt_id: number;
  email_next_attempt_at: Date | null;
  email_lease_expires_at: Date | null;
  email_last_sent_at: Date | null;
}

// Runs on a copy of space_invites with its pre-migration schema, never on
// the real table. Foreign key names are global in MySQL, so the copy's are
// renamed too.
describe('AddSpaceInviteDelivery migration (e2e)', () => {
  let testApp: TestApp;
  let realRunner: QueryRunner;
  const migration = new AddSpaceInviteDelivery1791000000000();
  const table = `invite_migration_probe_${process.pid}`;
  const foreignKey = `FK_${table}_accepted_by`;
  const userEmail = `invite-migration-${process.pid}-${Date.now()}@example.com`;
  let userId: number;

  const rename = (sql: string) =>
    sql.replaceAll('`space_invites`', `\`${table}\``).replaceAll('FK_space_invites_accepted_by_user', foreignKey);

  // Answers like a query runner on the copy; `interruptAt` stops the run
  // before the first statement that matches it.
  const runner = (interruptAt?: RegExp) =>
    ({
      query: async (sql: string, parameters?: unknown[]) => {
        if (interruptAt?.test(sql)) {
          throw new Error('deploy interrupted');
        }

        return testApp.dataSource.query(
          rename(sql),
          parameters?.map((value) => (value === 'space_invites' ? table : value)),
        );
      },
      getTable: (name: string) => realRunner.getTable(name === 'space_invites' ? table : name),
      dropForeignKey: (target: Table, key: TableForeignKey) => realRunner.dropForeignKey(target, key),
    }) as unknown as QueryRunner;

  async function columns(): Promise<string[]> {
    const rows: { COLUMN_NAME: string }[] = await testApp.dataSource.query(
      `SELECT COLUMN_NAME FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION`,
      [table],
    );

    return rows.map((row) => row.COLUMN_NAME);
  }

  const rows = (): Promise<ProbeRow[]> => testApp.dataSource.query(`SELECT * FROM \`${table}\` ORDER BY id`);

  // what the build before this migration writes: none of the new columns
  async function insertLegacy(email: string, accepted = false, revoked = false) {
    await testApp.dataSource.query(
      `INSERT INTO \`${table}\` (space_id, email, code, role, expires_at, accepted_at, revoked_at)
       VALUES (1, ?, '042917', 'member', NOW() + INTERVAL 7 DAY, ?, ?)`,
      [email, accepted ? new Date() : null, revoked ? new Date() : null],
    );
  }

  beforeAll(async () => {
    testApp = await createTestApp();
    realRunner = testApp.dataSource.createQueryRunner();
    const result: { insertId: number } = await testApp.dataSource.query(
      `INSERT INTO users (email, name, password, email_verified) VALUES (?, 'Probe', 'x', 1)`,
      [userEmail],
    );
    userId = result.insertId;
  });

  beforeEach(async () => {
    await testApp.dataSource.query(`DROP TABLE IF EXISTS \`${table}\``);
    await testApp.dataSource.query(`
      CREATE TABLE \`${table}\` (
        id int NOT NULL AUTO_INCREMENT,
        space_id int NOT NULL,
        email varchar(255) NOT NULL,
        code varchar(6) NOT NULL,
        role enum('owner','member') NOT NULL DEFAULT 'member',
        expires_at timestamp NOT NULL,
        accepted_at timestamp NULL DEFAULT NULL,
        revoked_at timestamp NULL DEFAULT NULL,
        created_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        KEY IDX_space_invites_space_id_email (space_id, email),
        KEY IDX_space_invites_email_code (email, code)
      ) ENGINE=InnoDB
    `);
    await insertLegacy('pending@example.com');
    await insertLegacy('accepted@example.com', true);
    await insertLegacy('revoked@example.com', false, true);
  });

  afterAll(async () => {
    await testApp.dataSource.query(`DROP TABLE IF EXISTS \`${table}\``);
    await testApp.dataSource.query('DELETE FROM users WHERE id = ?', [userId]);
    await realRunner.release();
    await testApp.app.close();
  });

  it('marks every existing invitation not_sent, without a link or a scheduled email', async () => {
    await migration.up(runner());

    expect(await rows()).toEqual(
      ['pending', 'accepted', 'revoked'].map((name) =>
        expect.objectContaining({
          email: `${name}@example.com`,
          code: '042917',
          accepted_by_user_id: null,
          token_nonce: null,
          email_status: 'not_sent',
          email_attempts: 0,
          email_attempt_id: 0,
          email_next_attempt_at: null,
          email_lease_expires_at: null,
          email_last_sent_at: null,
        }),
      ),
    );
    expect((await rows())[1].accepted_at).toBeInstanceOf(Date);
  });

  it('adds the due index and a foreign key that clears the acceptor when the user is deleted', async () => {
    await migration.up(runner());

    const index: { Column_name: string }[] = await testApp.dataSource.query(
      `SHOW INDEX FROM \`${table}\` WHERE Key_name = 'IDX_space_invites_email_due'`,
    );
    expect(index.map((row) => row.Column_name)).toEqual(['email_status', 'email_next_attempt_at']);

    const [constraint]: { DELETE_RULE: string; REFERENCED_TABLE_NAME: string }[] = await testApp.dataSource.query(
      `SELECT DELETE_RULE, REFERENCED_TABLE_NAME FROM information_schema.REFERENTIAL_CONSTRAINTS
       WHERE CONSTRAINT_SCHEMA = DATABASE() AND CONSTRAINT_NAME = ?`,
      [foreignKey],
    );
    expect(constraint).toEqual({ DELETE_RULE: 'SET NULL', REFERENCED_TABLE_NAME: 'users' });

    const otherUser: { insertId: number } = await testApp.dataSource.query(
      `INSERT INTO users (email, name, password, email_verified) VALUES (?, 'Probe 2', 'x', 1)`,
      [`second-${userEmail}`],
    );
    await testApp.dataSource.query(`UPDATE \`${table}\` SET accepted_by_user_id = ? WHERE id = 2`, [
      otherUser.insertId,
    ]);
    await testApp.dataSource.query('DELETE FROM users WHERE id = ?', [otherUser.insertId]);

    expect((await rows())[1]).toMatchObject({ accepted_by_user_id: null, email: 'accepted@example.com' });
  });

  it('keeps inserts of the previous build working after it ran', async () => {
    await migration.up(runner());
    await insertLegacy('during-deploy@example.com');

    expect((await rows())[3]).toMatchObject({
      email: 'during-deploy@example.com',
      token_nonce: null,
      email_status: 'not_sent',
    });
  });

  it('can run again after an interrupted or unrecorded run', async () => {
    await expect(migration.up(runner(/ALTER TABLE/))).rejects.toThrow('deploy interrupted');
    expect(await columns()).toEqual(ORIGINAL_COLUMNS);

    await migration.up(runner());
    const migrated = await columns();
    await migration.up(runner());

    expect(await columns()).toEqual(migrated);
    expect(migrated).toEqual([
      'id',
      'space_id',
      'email',
      'code',
      'role',
      'expires_at',
      'accepted_at',
      'accepted_by_user_id',
      'revoked_at',
      'created_at',
      'token_nonce',
      'email_status',
      'email_attempts',
      'email_attempt_id',
      'email_next_attempt_at',
      'email_lease_expires_at',
      'email_last_sent_at',
    ]);
  });

  it('reverts to the original schema and keeps the invitations', async () => {
    await migration.up(runner());
    await testApp.dataSource.query(`UPDATE \`${table}\` SET accepted_by_user_id = ? WHERE id = 2`, [userId]);

    await migration.down(runner());

    expect(await columns()).toEqual(ORIGINAL_COLUMNS);
    expect((await rows()).map((row) => row.email)).toEqual([
      'pending@example.com',
      'accepted@example.com',
      'revoked@example.com',
    ]);
  });
});
