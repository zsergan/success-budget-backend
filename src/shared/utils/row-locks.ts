import type { EntityManager, EntityTarget, ObjectLiteral } from 'typeorm';

// Rows are locked in ascending id order, so two writes locking the same rows
// never wait on each other crosswise.
export async function lockRows<T extends ObjectLiteral>(
  manager: EntityManager,
  entity: EntityTarget<T>,
  ids: Array<number | string>,
  mode: 'exclusive' | 'shared',
): Promise<T[]> {
  if (ids.length === 0) {
    return [];
  }

  return manager
    .createQueryBuilder(entity, 'row')
    .setLock(mode === 'exclusive' ? 'pessimistic_write' : 'pessimistic_read')
    .whereInIds([...new Set(ids)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)))
    .orderBy('row.id', 'ASC')
    .getMany();
}
