import type { EntityManager, EntityTarget, ObjectLiteral } from 'typeorm';

import { createDefaultCategories, createSpaceWithOwner } from './space-setup';
import { Space } from '@entities/space.entity';
import { SpaceMember } from '@entities/space-member.entity';
import { Category } from '@entities/category.entity';
import { SpaceRole, SpaceType } from '@shared/enums';
import { DEFAULT_CATEGORIES, INITIAL_BALANCE_CATEGORY } from '@shared/constants';

describe('space setup', () => {
  let spaceRepository: { create: jest.Mock; save: jest.Mock };
  let spaceMemberRepository: { create: jest.Mock; save: jest.Mock };
  let categoryRepository: { save: jest.Mock };
  let manager: Pick<EntityManager, 'getRepository'>;

  beforeEach(() => {
    spaceRepository = { create: jest.fn((entity) => entity), save: jest.fn(async (entity) => ({ ...entity, id: 10 })) };
    spaceMemberRepository = { create: jest.fn((entity) => entity), save: jest.fn() };
    categoryRepository = { save: jest.fn() };
    const getRepository = jest.fn().mockImplementation((entity: EntityTarget<ObjectLiteral>) => {
      if (entity === Space) return spaceRepository;
      if (entity === SpaceMember) return spaceMemberRepository;
      if (entity === Category) return categoryRepository;
      throw new Error(`Unexpected entity: ${String(entity)}`);
    });
    manager = { getRepository };
  });

  describe('createSpaceWithOwner', () => {
    it('saves the space, then its owner membership, through the given manager', async () => {
      const space = await createSpaceWithOwner(manager, { name: 'Family', type: SpaceType.GROUP, currency_id: 3 }, 7);

      expect(spaceRepository.save).toHaveBeenCalledWith({ name: 'Family', type: SpaceType.GROUP, currency_id: 3 });
      expect(spaceMemberRepository.save).toHaveBeenCalledWith({ space_id: 10, user_id: 7, role: SpaceRole.OWNER });
      expect(spaceRepository.save.mock.invocationCallOrder[0]).toBeLessThan(
        spaceMemberRepository.save.mock.invocationCallOrder[0],
      );
      expect(space).toMatchObject({ id: 10, name: 'Family' });
    });

    it('propagates a membership failure so the surrounding transaction rolls back', async () => {
      spaceMemberRepository.save.mockRejectedValue(new Error('db unavailable'));

      await expect(
        createSpaceWithOwner(manager, { name: 'Personal', type: SpaceType.PERSONAL, currency_id: 1 }, 7),
      ).rejects.toThrow('db unavailable');
    });
  });

  describe('createDefaultCategories', () => {
    it('saves the default categories plus the system initial-balance category in one call', async () => {
      await createDefaultCategories(manager, 10);

      expect(categoryRepository.save).toHaveBeenCalledTimes(1);
      const [saved] = categoryRepository.save.mock.calls[0];
      expect(saved).toHaveLength(DEFAULT_CATEGORIES.length + 1);
      expect(saved.every((category: Category) => category.space_id === 10)).toBe(true);
      expect(saved.filter((category: Category) => category.is_system === 1)).toEqual([
        { ...INITIAL_BALANCE_CATEGORY, space_id: 10 },
      ]);
    });
  });
});
