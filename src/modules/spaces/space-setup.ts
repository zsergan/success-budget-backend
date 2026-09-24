import type { EntityManager } from 'typeorm';

import { Space } from '@entities/space.entity';
import { SpaceMember } from '@entities/space-member.entity';
import { Category } from '@entities/category.entity';
import { SpaceRole, SpaceType } from '@shared/enums';
import { DEFAULT_CATEGORIES, INITIAL_BALANCE_CATEGORY } from '@shared/constants';

export interface NewSpace {
  name: string;
  type: SpaceType;
  currency_id: number;
}

export async function createSpaceWithOwner(
  manager: Pick<EntityManager, 'getRepository'>,
  newSpace: NewSpace,
  ownerId: number,
): Promise<Space> {
  const space = await manager.getRepository(Space).save(
    manager.getRepository(Space).create({
      name: newSpace.name,
      type: newSpace.type,
      currency_id: newSpace.currency_id,
    }),
  );

  await manager.getRepository(SpaceMember).save(
    manager.getRepository(SpaceMember).create({
      space_id: space.id,
      user_id: ownerId,
      role: SpaceRole.OWNER,
    }),
  );

  return space;
}

export async function createDefaultCategories(
  manager: Pick<EntityManager, 'getRepository'>,
  spaceId: number,
): Promise<void> {
  const categories = [...DEFAULT_CATEGORIES, INITIAL_BALANCE_CATEGORY].map((category) => ({
    ...category,
    space_id: spaceId,
  }));
  await manager.getRepository(Category).save(categories);
}
