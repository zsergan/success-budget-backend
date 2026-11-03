import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { HttpException } from '@nestjs/common';
import { EntityManager, Repository } from 'typeorm';

import { SpaceAccessService } from './space-access.service';
import { Space } from '@entities/space.entity';
import { SpaceMember } from '@entities/space-member.entity';
import { SpaceRole } from '@shared/enums';
import { ErrorMessages } from '@shared/error-messages';
import { LockSetChanged } from '@shared/utils';
import { buildSpaceMember } from '@testing';

describe('SpaceAccessService', () => {
  let service: SpaceAccessService;
  let spaceMemberRepository: jest.Mocked<Repository<SpaceMember>>;

  const forbidden = new HttpException(ErrorMessages.FORBIDDEN_SPACE, 403);

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [SpaceAccessService, { provide: getRepositoryToken(SpaceMember), useValue: { findOne: jest.fn() } }],
    }).compile();

    service = module.get(SpaceAccessService);
    spaceMemberRepository = module.get(getRepositoryToken(SpaceMember));
  });

  describe('assertMembership', () => {
    it('returns the membership of a plain member', async () => {
      const member = buildSpaceMember({ role: SpaceRole.MEMBER });
      spaceMemberRepository.findOne.mockResolvedValue(member);

      await expect(service.assertMembership(10, 1)).resolves.toBe(member);
      expect(spaceMemberRepository.findOne).toHaveBeenCalledWith({ where: { space_id: 10, user_id: 1 } });
    });

    it('returns the membership of an owner without a required role', async () => {
      const member = buildSpaceMember({ role: SpaceRole.OWNER });
      spaceMemberRepository.findOne.mockResolvedValue(member);

      await expect(service.assertMembership(10, 1)).resolves.toBe(member);
    });

    it('passes for an owner when an owner is required', async () => {
      const member = buildSpaceMember({ role: SpaceRole.OWNER });
      spaceMemberRepository.findOne.mockResolvedValue(member);

      await expect(service.assertMembership(10, 1, SpaceRole.OWNER)).resolves.toBe(member);
    });

    it('rejects a plain member when an owner is required', async () => {
      spaceMemberRepository.findOne.mockResolvedValue(buildSpaceMember({ role: SpaceRole.MEMBER }));

      await expect(service.assertMembership(10, 1, SpaceRole.OWNER)).rejects.toMatchObject(forbidden);
    });

    it('rejects an outsider with no membership', async () => {
      spaceMemberRepository.findOne.mockResolvedValue(null);

      await expect(service.assertMembership(10, 1)).rejects.toMatchObject(forbidden);
    });

    it('rejects an outsider when an owner is required', async () => {
      spaceMemberRepository.findOne.mockResolvedValue(null);

      await expect(service.assertMembership(10, 1, SpaceRole.OWNER)).rejects.toMatchObject(forbidden);
    });

    it('reads the membership through the given entity manager', async () => {
      const member = buildSpaceMember({ role: SpaceRole.MEMBER });
      const managerRepository = { findOne: jest.fn().mockResolvedValue(member) };
      const manager = { getRepository: jest.fn().mockReturnValue(managerRepository) } as unknown as EntityManager;

      await expect(service.assertMembership(10, 1, undefined, manager)).resolves.toBe(member);
      expect(manager.getRepository).toHaveBeenCalledWith(SpaceMember);
      expect(managerRepository.findOne).toHaveBeenCalledWith({ where: { space_id: 10, user_id: 1 } });
      expect(spaceMemberRepository.findOne).not.toHaveBeenCalled();
    });
  });

  describe('lockMembership', () => {
    const managerWith = (member: SpaceMember | null) => {
      const queryBuilder = {
        setLock: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        getOne: jest.fn().mockResolvedValue(member),
      };
      const manager = { createQueryBuilder: jest.fn().mockReturnValue(queryBuilder) } as unknown as EntityManager;

      return { manager, queryBuilder };
    };

    it('takes a shared lock on the member row and returns it', async () => {
      const member = buildSpaceMember();
      const { manager, queryBuilder } = managerWith(member);

      await expect(service.lockMembership(10, 1, manager)).resolves.toBe(member);
      expect(manager.createQueryBuilder).toHaveBeenCalledWith(SpaceMember, 'member');
      expect(queryBuilder.setLock).toHaveBeenCalledWith('pessimistic_read');
      expect(queryBuilder.where).toHaveBeenCalledWith('member.space_id = :spaceId AND member.user_id = :userId', {
        spaceId: 10,
        userId: 1,
      });
    });

    it('rejects an outsider', async () => {
      const { manager } = managerWith(null);

      await expect(service.lockMembership(10, 1, manager)).rejects.toMatchObject(forbidden);
    });
  });

  describe('lockSpace', () => {
    const managerLocking = () => {
      const queryBuilder = {
        setLock: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        getOne: jest.fn().mockResolvedValue(null),
      };
      const manager = { createQueryBuilder: jest.fn().mockReturnValue(queryBuilder) } as unknown as EntityManager;

      return { manager, queryBuilder };
    };

    it('takes a write lock on the space row through the given entity manager', async () => {
      const { manager, queryBuilder } = managerLocking();

      await service.lockSpace(10, manager);

      expect(manager.createQueryBuilder).toHaveBeenCalledWith(Space, 'space');
      expect(queryBuilder.setLock).toHaveBeenCalledWith('pessimistic_write');
      expect(queryBuilder.where).toHaveBeenCalledWith('space.id = :spaceId', { spaceId: 10 });
      expect(queryBuilder.getOne).toHaveBeenCalled();
    });

    it('takes a shared lock when asked to', async () => {
      const { manager, queryBuilder } = managerLocking();

      await service.lockSpace(10, manager, 'shared');

      expect(queryBuilder.setLock).toHaveBeenCalledWith('pessimistic_read');
    });
  });

  describe('lockMembers', () => {
    const owner = buildSpaceMember({ id: 3, space_id: 10, user_id: 1, role: SpaceRole.OWNER });
    const member = buildSpaceMember({ id: 8, space_id: 10, user_id: 2, role: SpaceRole.MEMBER });
    const elsewhere = buildSpaceMember({ id: 5, space_id: 20, user_id: 1, role: SpaceRole.OWNER });

    const managerWith = (reads: number[][], locked: SpaceMember[]) => {
      const find = jest.fn();
      reads.forEach((ids) => find.mockResolvedValueOnce(ids.map((id) => ({ id }))));
      const queryBuilder = {
        setLock: jest.fn().mockReturnThis(),
        whereInIds: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue(locked),
      };
      const manager = {
        getRepository: jest.fn().mockReturnValue({ find }),
        createQueryBuilder: jest.fn().mockReturnValue(queryBuilder),
      } as unknown as EntityManager;

      return { manager, find, queryBuilder };
    };

    beforeEach(() => {
      jest.spyOn(service, 'lockSpace').mockResolvedValue();
    });

    it('locks the space’s and the actor’s member rows, then the space, and reads the set again', async () => {
      const { manager, find, queryBuilder } = managerWith(
        [
          [3, 5, 8],
          [3, 5, 8],
        ],
        [owner, elsewhere, member],
      );

      await expect(service.lockMembers(10, 1, manager)).resolves.toEqual({
        actor: owner,
        members: [owner, member],
        actorSpaces: 2,
      });
      expect(find).toHaveBeenCalledWith({
        select: { id: true },
        where: [{ space_id: 10 }, { user_id: 1 }],
        order: { id: 'ASC' },
      });
      expect(manager.createQueryBuilder).toHaveBeenCalledWith(SpaceMember, 'row');
      expect(queryBuilder.setLock).toHaveBeenCalledWith('pessimistic_write');
      expect(queryBuilder.whereInIds).toHaveBeenCalledWith([3, 5, 8]);
      expect(service.lockSpace).toHaveBeenCalledWith(10, manager);

      const [lockMembersOrder] = queryBuilder.getMany.mock.invocationCallOrder;
      const [lockSpaceOrder] = (service.lockSpace as jest.Mock).mock.invocationCallOrder;
      const [, rereadOrder] = find.mock.invocationCallOrder;
      expect(lockMembersOrder).toBeLessThan(lockSpaceOrder);
      expect(lockSpaceOrder).toBeLessThan(rereadOrder);
    });

    it('asks for a rerun when a member joined before the space lock', async () => {
      const { manager } = managerWith(
        [
          [3, 5],
          [3, 5, 8],
        ],
        [owner, elsewhere],
      );

      await expect(service.lockMembers(10, 1, manager)).rejects.toBeInstanceOf(LockSetChanged);
    });

    it('decides on the rows still there when one was removed before its lock', async () => {
      const { manager } = managerWith(
        [
          [3, 5, 8],
          [3, 5],
        ],
        [owner, elsewhere],
      );

      await expect(service.lockMembers(10, 1, manager)).resolves.toEqual({
        actor: owner,
        members: [owner],
        actorSpaces: 2,
      });
    });

    it('rejects an actor whose membership is gone', async () => {
      const { manager } = managerWith([[8], [8]], [member]);

      await expect(service.lockMembers(10, 1, manager)).rejects.toMatchObject(forbidden);
    });
  });
});
