import type { MigrationInterface, QueryRunner } from 'typeorm';

const PRESETS = ['slate', 'amber', 'evergreen', 'indigo', 'clay', 'plum'];
const REPORTED = 20;

/**
 * Release C (docs/type-contract.md#category-colors): a category color is a
 * preset token or a custom #RRGGBB, so the closed enum becomes a bounded
 * string. Every stored preset stays exactly as it is; one statement, so an
 * interrupted run leaves the enum or the string, never a mix.
 */
export class AllowCustomCategoryColors1791600000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    if ((await this.columnType(queryRunner)) !== 'varchar') {
      await queryRunner.query("ALTER TABLE `categories` MODIFY `color` varchar(16) NOT NULL DEFAULT 'slate'");
    }
  }

  // Refuses while a category has a custom color: the enum cannot hold it.
  public async down(queryRunner: QueryRunner): Promise<void> {
    if ((await this.columnType(queryRunner)) !== 'varchar') {
      return;
    }

    const custom: { id: number }[] = await queryRunner.query(
      'SELECT `id` FROM `categories` WHERE `color` NOT IN (?) ORDER BY `id`',
      [PRESETS],
    );

    if (custom.length) {
      const ids = custom.map((row) => row.id);
      const shown = ids.slice(0, REPORTED).join(', ');

      throw new Error(
        `Cannot revert; nothing was changed. Categories with a custom color: ` +
          `${ids.length > REPORTED ? `${shown} and ${ids.length - REPORTED} more` : shown}.`,
      );
    }

    await queryRunner.query(
      `ALTER TABLE \`categories\`
       MODIFY \`color\` enum(${PRESETS.map((color) => `'${color}'`).join(',')}) NOT NULL DEFAULT 'slate'`,
    );
  }

  private async columnType(queryRunner: QueryRunner): Promise<string> {
    const [column]: { DATA_TYPE: string }[] = await queryRunner.query(
      `SELECT DATA_TYPE FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'categories' AND COLUMN_NAME = 'color'`,
    );

    return column.DATA_TYPE.toLowerCase();
  }
}
