import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { HttpException } from '@nestjs/common';
import { EntityManager, Repository } from 'typeorm';

import { SpaceAccessService } from './space-access.service';
import { Space } from '@entities/space.entity';
import { SpaceMember } from '@entities/space-member.entity';
import { SpaceRole } from '@shared/enums';
import { ErrorMessages } from '@shared/error-messages';
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

  describe('lockSpace', () => {
    it('takes a write lock on the space row through the given entity manager', async () => {
      const queryBuilder = {
        setLock: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        getOne: jest.fn().mockResolvedValue(null),
      };
      const manager = { createQueryBuilder: jest.fn().mockReturnValue(queryBuilder) } as unknown as EntityManager;

      await service.lockSpace(10, manager);

      expect(manager.createQueryBuilder).toHaveBeenCalledWith(Space, 'space');
      expect(queryBuilder.setLock).toHaveBeenCalledWith('pessimistic_write');
      expect(queryBuilder.where).toHaveBeenCalledWith('space.id = :spaceId', { spaceId: 10 });
      expect(queryBuilder.getOne).toHaveBeenCalled();
    });
  });
});
