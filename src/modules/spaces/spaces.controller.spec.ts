import { Test, TestingModule } from '@nestjs/testing';
import { HttpException } from '@nestjs/common';

import { SpacesController } from './spaces.controller';
import { SpacesService } from './spaces.service';
import { SpaceMembersService } from './space-members.service';
import { SpaceInvitesService } from './space-invites.service';
import { SpaceAccessService } from '@modules/space-access/space-access.service';
import { UsersService } from '@modules/users/users.service';
import { SpaceMember } from '@entities/space-member.entity';
import { SpaceInvite } from '@entities/space-invite.entity';
import { SpaceRole } from '@shared/enums';
import { ErrorMessages } from '@shared/error-messages';

describe('SpacesController', () => {
  let controller: SpacesController;
  let spacesService: jest.Mocked<SpacesService>;
  let spaceAccessService: jest.Mocked<SpaceAccessService>;
  let spaceMembersService: jest.Mocked<SpaceMembersService>;
  let spaceInvitesService: jest.Mocked<SpaceInvitesService>;
  let usersService: jest.Mocked<UsersService>;

  const req = { user: { id: 1 } } as any;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [SpacesController],
      providers: [
        {
          provide: SpacesService,
          useValue: { create: jest.fn(), getAllForUser: jest.fn(), getOne: jest.fn(), remove: jest.fn() },
        },
        { provide: SpaceAccessService, useValue: { assertMembership: jest.fn() } },
        {
          provide: SpaceMembersService,
          useValue: { getAll: jest.fn(), leaveOrRemove: jest.fn() },
        },
        {
          provide: SpaceInvitesService,
          useValue: { create: jest.fn(), getActive: jest.fn(), revoke: jest.fn(), accept: jest.fn() },
        },
        { provide: UsersService, useValue: { findById: jest.fn() } },
      ],
    }).compile();

    controller = module.get(SpacesController);
    spacesService = module.get(SpacesService);
    spaceAccessService = module.get(SpaceAccessService);
    spaceMembersService = module.get(SpaceMembersService);
    spaceInvitesService = module.get(SpaceInvitesService);
    usersService = module.get(UsersService);
  });

  describe('owner-only routes', () => {
    const forbidden = new HttpException(ErrorMessages.FORBIDDEN_SPACE, 403);

    it('rejects a plain member deleting a space', async () => {
      spaceAccessService.assertMembership.mockRejectedValue(forbidden);

      await expect(controller.remove(req, 10)).rejects.toMatchObject(forbidden);
      expect(spacesService.remove).not.toHaveBeenCalled();
    });

    it('rejects a plain member creating an invite', async () => {
      spaceAccessService.assertMembership.mockRejectedValue(forbidden);

      await expect(controller.createInvite(req, 10, { email: 'a@example.com' })).rejects.toMatchObject(forbidden);
      expect(spaceInvitesService.create).not.toHaveBeenCalled();
    });

    it('rejects a plain member revoking an invite', async () => {
      spaceAccessService.assertMembership.mockRejectedValue(forbidden);

      await expect(controller.revokeInvite(req, 10, 5)).rejects.toMatchObject(forbidden);
      expect(spaceInvitesService.revoke).not.toHaveBeenCalled();
    });
  });

  describe('getMembers', () => {
    it('composes members and pending invites, with can_remove true for an owner', async () => {
      // Membership ids (id) deliberately differ from user ids (user_id) --
      // a fixture where they coincide would hide a regression that
      // confuses the two.
      const ownerReq = { user: { id: 101 } } as any;

      spaceAccessService.assertMembership.mockResolvedValue({ role: SpaceRole.OWNER, user_id: 101 } as SpaceMember);
      spaceMembersService.getAll.mockResolvedValue([
        { id: 51, user_id: 101, role: SpaceRole.OWNER, user: { name: 'Me', email: 'me@example.com' } } as SpaceMember,
        {
          id: 52,
          user_id: 102,
          role: SpaceRole.MEMBER,
          user: { name: 'Them', email: 'them@example.com' },
        } as SpaceMember,
      ]);
      spaceInvitesService.getActive.mockResolvedValue([{ id: 3, email: 'pending@example.com' } as SpaceInvite]);

      const result = await controller.getMembers(ownerReq, 10);

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
      spaceMembersService.getAll.mockResolvedValue([
        { id: 1, user_id: 1, role: SpaceRole.OWNER, user: { name: 'Me', email: 'me@example.com' } } as SpaceMember,
      ]);
      spaceInvitesService.getActive.mockResolvedValue([]);

      const result = await controller.getMembers(req, 10);

      expect(result.every((entry) => entry.can_remove === false)).toBe(true);
    });
  });

  describe('removeMember', () => {
    it('delegates the membership check to leaveOrRemove', async () => {
      await expect(controller.removeMember(req, 10, 2)).resolves.toBe(true);

      expect(spaceMembersService.leaveOrRemove).toHaveBeenCalledWith(10, 1, 2);
      expect(spaceAccessService.assertMembership).not.toHaveBeenCalled();
    });
  });

  describe('acceptInvite', () => {
    it('resolves the caller email before accepting', async () => {
      usersService.findById.mockResolvedValue({ id: 1, email: 'me@example.com' } as any);
      spaceInvitesService.accept.mockResolvedValue({ id: 10 } as any);

      await controller.acceptInvite(req, { code: '123456' });

      expect(usersService.findById).toHaveBeenCalledWith(1);
      expect(spaceInvitesService.accept).toHaveBeenCalledWith(1, 'me@example.com', '123456');
    });
  });
});
