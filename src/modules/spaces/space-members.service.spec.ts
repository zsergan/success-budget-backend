import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { HttpException } from '@nestjs/common';
import { DataSource, Repository } from 'typeorm';

import { SpaceMembersService } from './space-members.service';
import { SpacesService } from './spaces.service';
import { SpaceInvitesService } from './space-invites.service';
import { SpaceInviteDelivery } from './space-invite-delivery';
import { SpaceAccessService } from '@modules/space-access/space-access.service';
import { SpaceMember } from '@entities/space-member.entity';
import { SpaceInviteEmailStatus, SpaceRole } from '@shared/enums';
import { ErrorMessages } from '@shared/error-messages';
import { buildSpaceInvite, buildSpaceMember, buildUser } from '@testing';

describe('SpaceMembersService', () => {
  let service: SpaceMembersService;
  let spaceMemberRepository: jest.Mocked<Repository<SpaceMember>>;
  let spaceMemberRepositoryInTx: { update: jest.Mock; delete: jest.Mock };
  let dataSource: { transaction: jest.Mock };
  let spaceAccessService: jest.Mocked<SpaceAccessService>;
  let spacesService: jest.Mocked<SpacesService>;
  let spaceInvitesService: jest.Mocked<SpaceInvitesService>;

  const delivery = { describe: jest.fn() };

  beforeEach(async () => {
    delivery.describe.mockImplementation(
      async (invites: { id: number }[]) =>
        new Map(
          invites.map((invite) => [
            invite.id,
            { email_status: SpaceInviteEmailStatus.FAILED, resend_after_seconds: 0 },
          ]),
        ),
    );
    spaceMemberRepositoryInTx = { update: jest.fn(), delete: jest.fn() };
    const manager = {
      getRepository: jest.fn((entity) => {
        if (entity === SpaceMember) return spaceMemberRepositoryInTx;
        throw new Error(`Unexpected entity: ${entity}`);
      }),
    };
    dataSource = {
      transaction: jest.fn((...args: unknown[]) => (args[args.length - 1] as (m: unknown) => unknown)(manager)),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SpaceMembersService,
        {
          provide: getRepositoryToken(SpaceMember),
          useValue: { find: jest.fn() },
        },
        { provide: DataSource, useValue: dataSource },
        { provide: SpaceAccessService, useValue: { assertMembership: jest.fn(), lockMembers: jest.fn() } },
        { provide: SpacesService, useValue: { removeOwned: jest.fn() } },
        { provide: SpaceInvitesService, useValue: { getActive: jest.fn() } },
        { provide: SpaceInviteDelivery, useValue: delivery },
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
      spaceAccessService.assertMembership.mockResolvedValue(buildSpaceMember({ role: SpaceRole.OWNER, user_id: 101 }));
      spaceMemberRepository.find.mockResolvedValue([
        buildSpaceMember({
          id: 51,
          user_id: 101,
          role: SpaceRole.OWNER,
          user: buildUser({ name: 'Me', email: 'me@example.com' }),
        }),
        buildSpaceMember({
          id: 52,
          user_id: 102,
          role: SpaceRole.MEMBER,
          user: buildUser({ name: 'Them', email: 'them@example.com' }),
        }),
      ]);
      spaceInvitesService.getActive.mockResolvedValue([buildSpaceInvite({ id: 3, email: 'pending@example.com' })]);

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
          email_status: null,
          can_resend: false,
          resend_after_seconds: null,
        },
        {
          type: 'member',
          id: 52,
          user_id: 102,
          name: 'Them',
          email: 'them@example.com',
          role: SpaceRole.MEMBER,
          can_remove: true,
          email_status: null,
          can_resend: false,
          resend_after_seconds: null,
        },
        {
          type: 'invite',
          id: 3,
          user_id: null,
          name: null,
          email: 'pending@example.com',
          role: null,
          can_remove: true,
          email_status: SpaceInviteEmailStatus.FAILED,
          can_resend: true,
          resend_after_seconds: 0,
        },
      ]);
    });

    it('sets can_remove false everywhere for a plain member caller', async () => {
      spaceAccessService.assertMembership.mockResolvedValue(buildSpaceMember({ role: SpaceRole.MEMBER, user_id: 2 }));
      spaceMemberRepository.find.mockResolvedValue([
        buildSpaceMember({
          id: 1,
          user_id: 1,
          role: SpaceRole.OWNER,
          user: buildUser({ name: 'Me', email: 'me@example.com' }),
        }),
      ]);
      spaceInvitesService.getActive.mockResolvedValue([buildSpaceInvite({ id: 3, email: 'pending@example.com' })]);

      const result = await service.getMembersWithInvites(2, 10);

      expect(result).toHaveLength(2);
      expect(result.every((entry) => entry.can_remove === false)).toBe(true);
      expect(result[1]).toMatchObject({ email_status: SpaceInviteEmailStatus.FAILED, can_resend: false });
    });

    it('offers resend to the owner only when no attempt runs and the cooldown is over', async () => {
      spaceAccessService.assertMembership.mockResolvedValue(buildSpaceMember({ role: SpaceRole.OWNER, user_id: 1 }));
      spaceMemberRepository.find.mockResolvedValue([]);
      spaceInvitesService.getActive.mockResolvedValue([3, 4, 5].map((id) => buildSpaceInvite({ id })));
      delivery.describe.mockResolvedValue(
        new Map([
          [3, { email_status: SpaceInviteEmailStatus.SENDING, resend_after_seconds: 0 }],
          [4, { email_status: SpaceInviteEmailStatus.SENT, resend_after_seconds: 42 }],
          [5, { email_status: SpaceInviteEmailStatus.SENT, resend_after_seconds: 0 }],
        ]),
      );

      const result = await service.getMembersWithInvites(1, 10);

      expect(result.map(({ can_resend, resend_after_seconds }) => [can_resend, resend_after_seconds])).toEqual([
        [false, 0],
        [false, 42],
        [true, 0],
      ]);
    });
  });

  describe('leaveOrRemove', () => {
    const at = (minute: number) => new Date(Date.UTC(2026, 10, 1, 10, minute));
    const owner = buildSpaceMember({ id: 1, user_id: 1, space_id: 10, role: SpaceRole.OWNER, created_at: at(0) });
    const plain = (id: number, userId: number, minute: number) =>
      buildSpaceMember({ id, user_id: userId, space_id: 10, role: SpaceRole.MEMBER, created_at: at(minute) });
    const lockedAs = (actor: SpaceMember, others: SpaceMember[] = [], actorSpaces = 2) => {
      spaceAccessService.assertMembership.mockResolvedValue(actor);
      spaceAccessService.lockMembers.mockResolvedValue({ actor, members: [actor, ...others], actorSpaces });
    };

    it('rejects an outsider before taking any lock', async () => {
      const forbidden = new HttpException(ErrorMessages.FORBIDDEN_SPACE, 403);
      spaceAccessService.assertMembership.mockRejectedValue(forbidden);

      await expect(service.leaveOrRemove(10, 1, 2)).rejects.toMatchObject(forbidden);
      expect(spaceAccessService.assertMembership).toHaveBeenCalledWith(10, 1);
      expect(dataSource.transaction).not.toHaveBeenCalled();
      expect(spaceAccessService.lockMembers).not.toHaveBeenCalled();
    });

    it('decides under the member and space locks, in one write transaction', async () => {
      lockedAs(owner, [plain(2, 2, 1)]);

      await service.leaveOrRemove(10, 1, 2);

      expect(dataSource.transaction).toHaveBeenCalledTimes(1);
      expect(dataSource.transaction).toHaveBeenCalledWith('READ COMMITTED', expect.any(Function));
      expect(spaceAccessService.lockMembers).toHaveBeenCalledWith(10, 1, expect.anything());
    });

    it('lets an owner remove another member', async () => {
      lockedAs(owner, [plain(2, 2, 1)]);

      await service.leaveOrRemove(10, 1, 2);

      expect(spaceMemberRepositoryInTx.delete).toHaveBeenCalledWith(2);
      expect(spaceMemberRepositoryInTx.update).not.toHaveBeenCalled();
    });

    it('returns 404 when the member to remove is not in the space', async () => {
      lockedAs(owner, [plain(2, 2, 1)]);

      await expect(service.leaveOrRemove(10, 1, 3)).rejects.toMatchObject(
        new HttpException(ErrorMessages.NOT_FOUND, 404),
      );
      expect(spaceMemberRepositoryInTx.delete).not.toHaveBeenCalled();
    });

    it('rejects a plain member trying to remove someone else', async () => {
      lockedAs(plain(2, 2, 1), [owner]);

      await expect(service.leaveOrRemove(10, 2, 1)).rejects.toMatchObject(
        new HttpException(ErrorMessages.FORBIDDEN_SPACE, 403),
      );
      expect(spaceMemberRepositoryInTx.delete).not.toHaveBeenCalled();
    });

    it('checks the role under the locks, not the one read before them', async () => {
      spaceAccessService.assertMembership.mockResolvedValue(owner);
      spaceAccessService.lockMembers.mockResolvedValue({
        actor: { ...owner, role: SpaceRole.MEMBER },
        members: [{ ...owner, role: SpaceRole.MEMBER }, plain(2, 2, 1)],
        actorSpaces: 2,
      });

      await expect(service.leaveOrRemove(10, 1, 2)).rejects.toMatchObject(
        new HttpException(ErrorMessages.FORBIDDEN_SPACE, 403),
      );
      expect(spaceMemberRepositoryInTx.delete).not.toHaveBeenCalled();
    });

    it('lets a plain member leave on their own', async () => {
      lockedAs(plain(2, 2, 1), [owner]);

      await service.leaveOrRemove(10, 2, 2);

      expect(spaceMemberRepositoryInTx.delete).toHaveBeenCalledWith(2);
      expect(spaceMemberRepositoryInTx.update).not.toHaveBeenCalled();
    });

    it('transfers ownership to the earliest member, then the lowest id, when the owner leaves', async () => {
      lockedAs(owner, [plain(7, 7, 5), plain(6, 6, 9), plain(5, 5, 9), plain(4, 4, 5)]);

      await service.leaveOrRemove(10, 1, 1);

      expect(spaceMemberRepositoryInTx.delete).toHaveBeenCalledWith(1);
      expect(spaceMemberRepositoryInTx.update).toHaveBeenCalledTimes(1);
      expect(spaceMemberRepositoryInTx.update).toHaveBeenCalledWith(4, { role: SpaceRole.OWNER });
      expect(spacesService.removeOwned).not.toHaveBeenCalled();
    });

    it('deletes the space in the same transaction when the owner is the sole member under the locks', async () => {
      lockedAs(owner);

      await service.leaveOrRemove(10, 1, 1);

      expect(spacesService.removeOwned).toHaveBeenCalledWith(expect.anything(), {
        actor: owner,
        members: [owner],
        actorSpaces: 2,
      });
      expect(dataSource.transaction).toHaveBeenCalledTimes(1);
      expect(spaceMemberRepositoryInTx.delete).not.toHaveBeenCalled();
      expect(spaceMemberRepositoryInTx.update).not.toHaveBeenCalled();
    });

    it('propagates the "last remaining space" rejection from SpacesService.removeOwned()', async () => {
      lockedAs(owner, [], 1);
      spacesService.removeOwned.mockRejectedValue(new HttpException(ErrorMessages.SPACE_LAST_REMAINING, 400));

      await expect(service.leaveOrRemove(10, 1, 1)).rejects.toMatchObject(
        new HttpException(ErrorMessages.SPACE_LAST_REMAINING, 400),
      );
    });
  });
});
