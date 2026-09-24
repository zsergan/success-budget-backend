import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { HttpException } from '@nestjs/common';
import { DataSource, Repository } from 'typeorm';

import { SpaceMembersService } from './space-members.service';
import { SpacesService } from './spaces.service';
import { SpaceInvitesService } from './space-invites.service';
import { SpaceAccessService } from '@modules/space-access/space-access.service';
import { SpaceMember } from '@entities/space-member.entity';
import { SpaceInvite } from '@entities/space-invite.entity';
import { SpaceRole } from '@shared/enums';
import { ErrorMessages } from '@shared/error-messages';

describe('SpaceMembersService', () => {
  let service: SpaceMembersService;
  let spaceMemberRepository: jest.Mocked<Repository<SpaceMember>>;
  let spaceMemberRepositoryInTx: { update: jest.Mock; delete: jest.Mock };
  let dataSource: { transaction: jest.Mock };
  let spaceAccessService: jest.Mocked<SpaceAccessService>;
  let spacesService: jest.Mocked<SpacesService>;
  let spaceInvitesService: jest.Mocked<SpaceInvitesService>;

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
        { provide: SpacesService, useValue: { removeOwned: jest.fn() } },
        { provide: SpaceInvitesService, useValue: { getActive: jest.fn() } },
      ],
    }).compile();

    service = module.get(SpaceMembersService);
    spaceMemberRepository = module.get(getRepositoryToken(SpaceMember));
    spaceAccessService = module.get(SpaceAccessService);
    spacesService = module.get(SpacesService);
    spaceInvitesService = module.get(SpaceInvitesService);
  });

  describe('getMembersWithInvites', () => {
    it('rejects an outsider before loading members or invites', async () => {
      const forbidden = new HttpException(ErrorMessages.FORBIDDEN_SPACE, 403);
      spaceAccessService.assertMembership.mockRejectedValue(forbidden);

      await expect(service.getMembersWithInvites(1, 10)).rejects.toMatchObject(forbidden);
      expect(spaceMemberRepository.find).not.toHaveBeenCalled();
      expect(spaceInvitesService.getActive).not.toHaveBeenCalled();
    });

    it('composes members and pending invites, with can_remove true for an owner', async () => {
      // Membership ids (id) deliberately differ from user ids (user_id) --
      // a fixture where they coincide would hide a regression that
      // confuses the two.
      spaceAccessService.assertMembership.mockResolvedValue({ role: SpaceRole.OWNER, user_id: 101 } as SpaceMember);
      spaceMemberRepository.find.mockResolvedValue([
        { id: 51, user_id: 101, role: SpaceRole.OWNER, user: { name: 'Me', email: 'me@example.com' } } as SpaceMember,
        {
          id: 52,
          user_id: 102,
          role: SpaceRole.MEMBER,
          user: { name: 'Them', email: 'them@example.com' },
        } as SpaceMember,
      ]);
      spaceInvitesService.getActive.mockResolvedValue([{ id: 3, email: 'pending@example.com' } as SpaceInvite]);

      const result = await service.getMembersWithInvites(101, 10);

      expect(spaceAccessService.assertMembership).toHaveBeenCalledTimes(1);
      expect(spaceAccessService.assertMembership).toHaveBeenCalledWith(10, 101);
      expect(spaceInvitesService.getActive).toHaveBeenCalledWith(10);
      expect(result).toEqual([
        {
          type: 'member',
          id: 51,
          user_id: 101,
          name: 'Me',
          email: 'me@example.com',
          role: SpaceRole.OWNER,
          can_remove: false,
        },
        {
          type: 'member',
          id: 52,
          user_id: 102,
          name: 'Them',
          email: 'them@example.com',
          role: SpaceRole.MEMBER,
          can_remove: true,
        },
        {
          type: 'invite',
          id: 3,
          user_id: null,
          name: null,
          email: 'pending@example.com',
          role: null,
          can_remove: true,
        },
      ]);
    });

    it('sets can_remove false everywhere for a plain member caller', async () => {
      spaceAccessService.assertMembership.mockResolvedValue({ role: SpaceRole.MEMBER, user_id: 2 } as SpaceMember);
      spaceMemberRepository.find.mockResolvedValue([
        { id: 1, user_id: 1, role: SpaceRole.OWNER, user: { name: 'Me', email: 'me@example.com' } } as SpaceMember,
      ]);
      spaceInvitesService.getActive.mockResolvedValue([{ id: 3, email: 'pending@example.com' } as SpaceInvite]);

      const result = await service.getMembersWithInvites(2, 10);

      expect(result).toHaveLength(2);
      expect(result.every((entry) => entry.can_remove === false)).toBe(true);
    });
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
      expect(spacesService.removeOwned).not.toHaveBeenCalled();
    });

    it('delegates to SpacesService.removeOwned() without re-checking membership when the owner is the sole member', async () => {
      spaceAccessService.assertMembership.mockResolvedValue({ id: 1, role: SpaceRole.OWNER } as SpaceMember);
      spaceMemberRepository.findOne.mockResolvedValueOnce(null);

      await service.leaveOrRemove(10, 1, 1);

      expect(spacesService.removeOwned).toHaveBeenCalledWith(1, 10);
      expect(spaceAccessService.assertMembership).toHaveBeenCalledTimes(1);
      expect(dataSource.transaction).not.toHaveBeenCalled();
    });

    it('propagates the "last remaining space" rejection from SpacesService.removeOwned()', async () => {
      spaceAccessService.assertMembership.mockResolvedValue({ id: 1, role: SpaceRole.OWNER } as SpaceMember);
      spaceMemberRepository.findOne.mockResolvedValueOnce(null);
      spacesService.removeOwned.mockRejectedValue(new HttpException(ErrorMessages.SPACE_LAST_REMAINING, 400));

      await expect(service.leaveOrRemove(10, 1, 1)).rejects.toMatchObject(
        new HttpException(ErrorMessages.SPACE_LAST_REMAINING, 400),
      );
    });
  });
});
