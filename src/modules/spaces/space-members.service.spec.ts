import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { HttpException } from '@nestjs/common';
import { DataSource, Repository } from 'typeorm';

import { SpaceMembersService } from './space-members.service';
import { SpacesService } from './spaces.service';
import { SpaceAccessService } from '@modules/space-access/space-access.service';
import { SpaceMember } from '@entities/space-member.entity';
import { SpaceRole } from '@shared/enums';
import { ErrorMessages } from '@shared/error-messages';

describe('SpaceMembersService', () => {
  let service: SpaceMembersService;
  let spaceMemberRepository: jest.Mocked<Repository<SpaceMember>>;
  let spaceMemberRepositoryInTx: { update: jest.Mock; delete: jest.Mock };
  let dataSource: { transaction: jest.Mock };
  let spaceAccessService: jest.Mocked<SpaceAccessService>;
  let spacesService: jest.Mocked<SpacesService>;

  beforeEach(async () => {
    spaceMemberRepositoryInTx = { update: jest.fn(), delete: jest.fn() };
    const manager = {
      getRepository: jest.fn((entity) => {
        if (entity === SpaceMember) return spaceMemberRepositoryInTx;
        throw new Error(`Unexpected entity: ${entity}`);
      }),
    };
    dataSource = { transaction: jest.fn((callback) => callback(manager)) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SpaceMembersService,
        {
          provide: getRepositoryToken(SpaceMember),
          useValue: { find: jest.fn(), findOne: jest.fn(), delete: jest.fn() },
        },
        { provide: DataSource, useValue: dataSource },
        { provide: SpaceAccessService, useValue: { assertMembership: jest.fn() } },
        { provide: SpacesService, useValue: { remove: jest.fn() } },
      ],
    }).compile();

    service = module.get(SpaceMembersService);
    spaceMemberRepository = module.get(getRepositoryToken(SpaceMember));
    spaceAccessService = module.get(SpaceAccessService);
    spacesService = module.get(SpacesService);
  });

  describe('leaveOrRemove', () => {
    it('rejects an outsider before touching any membership', async () => {
      const forbidden = new HttpException(ErrorMessages.FORBIDDEN_SPACE, 403);
      spaceAccessService.assertMembership.mockRejectedValue(forbidden);

      await expect(service.leaveOrRemove(10, 1, 2)).rejects.toMatchObject(forbidden);
      expect(spaceAccessService.assertMembership).toHaveBeenCalledWith(10, 1);
      expect(spaceMemberRepository.findOne).not.toHaveBeenCalled();
      expect(spaceMemberRepository.delete).not.toHaveBeenCalled();
    });

    it('lets an owner remove another member', async () => {
      spaceAccessService.assertMembership.mockResolvedValue({ id: 1, role: SpaceRole.OWNER } as SpaceMember);
      spaceMemberRepository.findOne.mockResolvedValueOnce({ id: 2, role: SpaceRole.MEMBER } as SpaceMember);

      await service.leaveOrRemove(10, 1, 2);

      expect(spaceMemberRepository.delete).toHaveBeenCalledWith(2);
    });

    it('returns 404 when the member to remove is not in the space', async () => {
      spaceAccessService.assertMembership.mockResolvedValue({ id: 1, role: SpaceRole.OWNER } as SpaceMember);
      spaceMemberRepository.findOne.mockResolvedValueOnce(null);

      await expect(service.leaveOrRemove(10, 1, 2)).rejects.toMatchObject(
        new HttpException(ErrorMessages.NOT_FOUND, 404),
      );
      expect(spaceMemberRepository.delete).not.toHaveBeenCalled();
    });

    it('rejects a plain member trying to remove someone else', async () => {
      spaceAccessService.assertMembership.mockResolvedValue({ id: 1, role: SpaceRole.MEMBER } as SpaceMember);

      await expect(service.leaveOrRemove(10, 1, 2)).rejects.toMatchObject(
        new HttpException(ErrorMessages.FORBIDDEN_SPACE, 403),
      );
      expect(spaceMemberRepository.delete).not.toHaveBeenCalled();
    });

    it('lets a plain member leave on their own', async () => {
      spaceAccessService.assertMembership.mockResolvedValue({ id: 1, role: SpaceRole.MEMBER } as SpaceMember);

      await service.leaveOrRemove(10, 1, 1);

      expect(spaceMemberRepository.delete).toHaveBeenCalledWith(1);
      expect(dataSource.transaction).not.toHaveBeenCalled();
    });

    it('transfers ownership to the next member by created_at when the owner leaves', async () => {
      spaceAccessService.assertMembership.mockResolvedValue({ id: 1, role: SpaceRole.OWNER } as SpaceMember);
      spaceMemberRepository.findOne.mockResolvedValueOnce({ id: 5 } as SpaceMember);

      await service.leaveOrRemove(10, 1, 1);

      expect(dataSource.transaction).toHaveBeenCalled();
      expect(spaceMemberRepositoryInTx.delete).toHaveBeenCalledWith(1);
      expect(spaceMemberRepositoryInTx.update).toHaveBeenCalledWith(5, { role: SpaceRole.OWNER });
      expect(spacesService.remove).not.toHaveBeenCalled();
    });

    it('delegates to SpacesService.remove() when the owner is the sole member', async () => {
      spaceAccessService.assertMembership.mockResolvedValue({ id: 1, role: SpaceRole.OWNER } as SpaceMember);
      spaceMemberRepository.findOne.mockResolvedValueOnce(null);

      await service.leaveOrRemove(10, 1, 1);

      expect(spacesService.remove).toHaveBeenCalledWith(10, 1);
      expect(dataSource.transaction).not.toHaveBeenCalled();
    });

    it('propagates the "last remaining space" rejection from SpacesService.remove()', async () => {
      spaceAccessService.assertMembership.mockResolvedValue({ id: 1, role: SpaceRole.OWNER } as SpaceMember);
      spaceMemberRepository.findOne.mockResolvedValueOnce(null);
      spacesService.remove.mockRejectedValue(new HttpException(ErrorMessages.SPACE_LAST_REMAINING, 400));

      await expect(service.leaveOrRemove(10, 1, 1)).rejects.toMatchObject(
        new HttpException(ErrorMessages.SPACE_LAST_REMAINING, 400),
      );
    });
  });
});
