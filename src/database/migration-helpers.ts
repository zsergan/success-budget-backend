import type { QueryRunner } from 'typeorm';

export async function dropForeignKeyOn(queryRunner: QueryRunner, tableName: string, columnName: string): Promise<void> {
  const table = await queryRunner.getTable(tableName);

  if (!table) {
    throw new Error(`Table "${tableName}" not found`);
  }

  const foreignKey = table.foreignKeys.find((fk) => fk.columnNames.includes(columnName));

  if (!foreignKey) {
    throw new Error(`Foreign key on "${tableName}.${columnName}" not found`);
  }

  await queryRunner.dropForeignKey(table, foreignKey);
}
