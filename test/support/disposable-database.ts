import type { DataSource } from 'typeorm';

const DISPOSABLE_NAME = /^migration_e2e_[a-z0-9_]+$/;

const HOW_TO_RUN =
  'Run it with `npm run test:e2e:migrations`, which provisions a disposable MySQL; it never runs against the database in .env.';

// The database scripts/test-migration-e2e.sh created for this run; checked
// before the app boots, so a spec that changes the schema fails before any write.
export function disposableDatabaseName(): string {
  const name = process.env.MIGRATION_E2E_DATABASE;

  if (!name || !DISPOSABLE_NAME.test(name)) {
    throw new Error(`MIGRATION_E2E_DATABASE does not name a disposable database. ${HOW_TO_RUN}`);
  }

  if (process.env.DB_DATABASE !== name) {
    throw new Error(`DB_DATABASE is "${process.env.DB_DATABASE}", not the disposable "${name}". ${HOW_TO_RUN}`);
  }

  return name;
}

export async function assertDisposableDatabase(dataSource: DataSource, name: string): Promise<void> {
  const [{ current }]: { current: string | null }[] = await dataSource.query('SELECT DATABASE() AS current');

  if (current !== name) {
    throw new Error(`Connected to "${current}", not the disposable "${name}". ${HOW_TO_RUN}`);
  }
}
