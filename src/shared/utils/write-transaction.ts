import type { DataSource, EntityManager } from 'typeorm';

import { isDeadlock } from './database-errors';

const MAX_ATTEMPTS = 3;

// Thrown before any write when the set of rows a unit has to lock changed
// while it was locking them, so it runs again with the current set.
export class LockSetChanged extends Error {
  constructor() {
    super('The rows to lock changed while they were being locked');
  }
}

// READ COMMITTED: locking reads take record locks without gap locks, so
// locking a missing row or inserting a new unique key does not deadlock with
// concurrent inserts, and every read sees the latest commit. A deadlock or a
// LockSetChanged rolls the whole transaction back, so the unit is simply run
// again; each is retried a bounded number of times.
export async function runWriteTransaction<T>(
  dataSource: DataSource,
  work: (manager: EntityManager) => Promise<T>,
): Promise<T> {
  let deadlocks = 0;
  let lockSetChanges = 0;

  for (;;) {
    try {
      return await dataSource.transaction('READ COMMITTED', work);
    } catch (error) {
      const retry = isDeadlock(error)
        ? ++deadlocks < MAX_ATTEMPTS
        : error instanceof LockSetChanged && ++lockSetChanges < MAX_ATTEMPTS;

      if (!retry) {
        throw error;
      }
    }
  }
}
