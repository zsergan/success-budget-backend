import type { DataSource, EntityManager } from 'typeorm';

import { isDeadlock } from './database-errors';

const MAX_ATTEMPTS = 3;

// READ COMMITTED: locking reads take record locks without gap locks, so
// locking a missing row or inserting a new unique key does not deadlock with
// concurrent inserts, and every read sees the latest commit. A deadlock rolls
// the whole transaction back, so the unit is simply run again.
export async function runWriteTransaction<T>(
  dataSource: DataSource,
  work: (manager: EntityManager) => Promise<T>,
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await dataSource.transaction('READ COMMITTED', work);
    } catch (error) {
      if (attempt >= MAX_ATTEMPTS || !isDeadlock(error)) {
        throw error;
      }
    }
  }
}
