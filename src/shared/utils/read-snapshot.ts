import type { DataSource, EntityManager } from 'typeorm';

// InnoDB takes a REPEATABLE READ snapshot at the first read, so the later
// reads of one response see no commits made in between. Plain reads, no locks.
export function readSnapshot<T>(dataSource: DataSource, read: (manager: EntityManager) => Promise<T>): Promise<T> {
  return dataSource.transaction('REPEATABLE READ', read);
}
