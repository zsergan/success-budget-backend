import type { MigrationInterface, QueryRunner } from 'typeorm';
import { TableIndex } from 'typeorm';

const INDEX_NAME = 'UQ_users_email';

/**
 * One account per email. Registration used to check-then-insert, so two
 * concurrent sign-ups could create two users (and two personal spaces) for
 * the same address. Duplicates are compared with the column's collation
 * (case- and accent-insensitive), exactly as the index will compare them;
 * any found stop the migration instead of being merged or deleted here.
 */
export class AddUniqueUserEmail1790000000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    const duplicates: { user_ids: string; count: string }[] = await queryRunner.query(`
      SELECT GROUP_CONCAT(id ORDER BY id) AS user_ids, COUNT(*) AS count
      FROM users
      GROUP BY email
      HAVING COUNT(*) > 1
    `);

    if (duplicates.length) {
      const groups = duplicates.map((row) => `  - ${row.count} users: ids ${row.user_ids}`).join('\n');

      throw new Error(
        `Cannot add ${INDEX_NAME}: ${duplicates.length} email(s) belong to more than one user ` +
          `(emails compared case-insensitively):\n${groups}\n` +
          'Resolve each group by hand (keep one account, move or delete the others and their spaces), then rerun.',
      );
    }

    await queryRunner.createIndex(
      'users',
      new TableIndex({ name: INDEX_NAME, columnNames: ['email'], isUnique: true }),
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropIndex('users', INDEX_NAME);
  }
}
