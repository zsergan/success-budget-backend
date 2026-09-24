import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { HttpException } from '@nestjs/common';
import { Repository } from 'typeorm';

import { SpaceAccessService } from './space-access.service';
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
  });
});
