import type { WithRelations } from '@shared/types';

export function withRelations<T extends object, K extends keyof T>(entity: T, ...relations: K[]): WithRelations<T, K> {
  for (const relation of relations) {
    if (entity[relation] == null) {
      throw new Error(`Relation "${String(relation)}" is not loaded`);
    }
  }

  return entity as WithRelations<T, K>;
}
