import type { MigrationInterface, QueryRunner } from 'typeorm';
import { TableColumn } from 'typeorm';

// Snapshot of shared/constants.ts's DEFAULT_CATEGORIES at the time this
// migration was written - migrations must not import mutable application
// source, so these are inlined deliberately.
const DEFAULT_CATEGORIES = [
  { name: 'Salary', transaction_type: 'income', icon: 'Salary', color: 'evergreen' },
  { name: 'Gifts', transaction_type: 'income', icon: 'Gifts', color: 'clay' },
  { name: 'Housing', transaction_type: 'expense', icon: 'Housing', color: 'slate' },
  { name: 'Transport', transaction_type: 'expense', icon: 'Transport', color: 'indigo' },
  { name: 'Grocery', transaction_type: 'expense', icon: 'Grocery', color: 'evergreen' },
  { name: 'Restaurant', transaction_type: 'expense', icon: 'Restaurant', color: 'clay' },
  { name: 'Car', transaction_type: 'expense', icon: 'Car', color: 'indigo' },
  { name: 'Clothes', transaction_type: 'expense', icon: 'Clothes', color: 'plum' },
  { name: 'Health', transaction_type: 'expense', icon: 'Health', color: 'clay' },
  { name: 'Entertainment', transaction_type: 'expense', icon: 'Entertainment', color: 'amber' },
  { name: 'Education', transaction_type: 'expense', icon: 'Education', color: 'slate' },
  { name: 'Travel', transaction_type: 'expense', icon: 'Travel', color: 'indigo' },
  { name: 'Pets', transaction_type: 'expense', icon: 'Pets', color: 'clay' },
  { name: 'Electronics', transaction_type: 'expense', icon: 'Electronics', color: 'slate' },
  { name: 'Utilities', transaction_type: 'expense', icon: 'Utilities', color: 'slate' },
] as const;

const INITIAL_BALANCE_CATEGORY = {
  name: 'Initial balance',
  transaction_type: 'income',
  icon: 'Savings',
  color: 'slate',
} as const;

export class AddCategoryIsSystemAndBackfillDefaults1789500000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.addColumn(
      'categories',
      new TableColumn({ name: 'is_system', type: 'tinyint', length: '1', isNullable: false, default: 0 }),
    );

    // Closes a pre-existing gap: SpacesService.create() never seeded
    // categories for any space (personal or group) created via POST
    // /spaces - only the register()/completeEmailVerification() path did.
    // Any space with zero categories today only got that way through
    // POST /spaces, so this is safe and exhaustive.
    const emptySpaces: Array<{ id: number }> = await queryRunner.query(`
      SELECT s.id AS id FROM spaces s
      LEFT JOIN categories c ON c.space_id = s.id
      WHERE c.id IS NULL
    `);

    for (const { id: spaceId } of emptySpaces) {
      for (const category of DEFAULT_CATEGORIES) {
        await queryRunner.query(
          `INSERT INTO categories (space_id, name, transaction_type, icon, color, is_system)
           VALUES (?, ?, ?, ?, ?, 0)`,
          [spaceId, category.name, category.transaction_type, category.icon, category.color],
        );
      }
    }

    // Every space - the ones just backfilled above, and every pre-existing
    // space that already had default categories but never got a system
    // one - ends up with exactly one "Initial balance" category.
    const allSpaces: Array<{ id: number }> = await queryRunner.query(`SELECT id FROM spaces`);

    for (const { id: spaceId } of allSpaces) {
      await queryRunner.query(
        `INSERT INTO categories (space_id, name, transaction_type, icon, color, is_system)
         SELECT ?, ?, ?, ?, ?, 1
         WHERE NOT EXISTS (SELECT 1 FROM categories WHERE space_id = ? AND is_system = 1)`,
        [
          spaceId,
          INITIAL_BALANCE_CATEGORY.name,
          INITIAL_BALANCE_CATEGORY.transaction_type,
          INITIAL_BALANCE_CATEGORY.icon,
          INITIAL_BALANCE_CATEGORY.color,
          spaceId,
        ],
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // best-effort, same precedent as the Stage 2 backfill migrations' down()
    // - only undoes the schema change, does not attempt to remove the
    // specific rows up() inserted.
    await queryRunner.dropColumn('categories', 'is_system');
  }
}
