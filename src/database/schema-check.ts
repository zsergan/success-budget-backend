import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { DataSource } from 'typeorm';

// The newest migration this code needs. Kept equal to the newest file in
// src/migrations by schema-check.spec.ts.
export const REQUIRED_MIGRATION = 'CreateTransactionOperations1790400000000';

export interface SchemaState {
  // migrations of this build the database has not run yet
  pending: string[];
  // migrations the database ran that this build does not know: an older
  // build started after a newer one migrated
  unknown: string[];
  // REQUIRED_MIGRATION is not in this build
  requiredMissing: boolean;
}

export async function readSchemaState(dataSource: DataSource): Promise<SchemaState> {
  const built = dataSource.migrations.map((migration) => migration.name ?? migration.constructor.name);
  const table = dataSource.options.migrationsTableName ?? 'migrations';
  const queryRunner = dataSource.createQueryRunner();
  let executed: string[] = [];

  try {
    if (await queryRunner.hasTable(table)) {
      const rows: { name: string }[] = await queryRunner.query(`SELECT name FROM \`${table}\``);
      executed = rows.map((row) => row.name);
    }
  } finally {
    await queryRunner.release();
  }

  const ran = new Set(executed);
  const known = new Set(built);

  return {
    pending: built.filter((name) => !ran.has(name)),
    unknown: executed.filter((name) => !known.has(name)),
    requiredMissing: !known.has(REQUIRED_MIGRATION),
  };
}

// null when this build may serve traffic on the schema
export function schemaProblem({ pending, requiredMissing }: SchemaState): string | null {
  if (requiredMissing) {
    return `This build does not contain the migration ${REQUIRED_MIGRATION} its code needs`;
  }

  if (pending.length > 0) {
    return `The database schema is behind this build; run the migrations first. Pending: ${pending.join(', ')}`;
  }

  return null;
}

// Refuses to start the app on a schema it was not built for, so a deploy
// that skipped the migration step fails before serving a request.
@Injectable()
export class SchemaCheck implements OnApplicationBootstrap {
  private readonly logger = new Logger(SchemaCheck.name);

  constructor(private readonly dataSource: DataSource) {}

  async onApplicationBootstrap(): Promise<void> {
    const state = await readSchemaState(this.dataSource);
    const problem = schemaProblem(state);

    if (problem) {
      throw new Error(problem);
    }

    if (state.unknown.length > 0) {
      this.logger.warn(`The database ran migrations this build does not know: ${state.unknown.join(', ')}`);
    }
  }
}
