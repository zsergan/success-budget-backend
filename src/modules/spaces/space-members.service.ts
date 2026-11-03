import { HttpStatus, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';

import { SpaceMember } from '@entities/space-member.entity';
import { SpaceInviteEmailStatus, SpaceRole } from '@shared/enums';
import type { WithRelations } from '@shared/types';
import { runWriteTransaction, withRelations } from '@shared/utils';
import { ApiException } from '@shared/api.exception';
import { SpaceAccessService } from '@modules/space-access/space-access.service';
import { SpacesService } from './spaces.service';
import { SpaceInvitesService } from './space-invites.service';
import { SpaceInviteDelivery } from './space-invite-delivery';

export interface SpaceMemberView {
  type: 'member' | 'invite';
  id: number;
  // The user id behind this row -- distinct from `id`, which for a member
  // row is the *membership* id. DELETE :id/members/:userId expects this
  // value, not `id`. null for invite rows, which are removed by invite id
  // (`id`) via DELETE :id/invites/:inviteId instead.
  user_id: number | null;
  name: string | null;
  email: string;
  role: SpaceRole | null;
  can_remove: boolean;
  // invitation rows only; null/false on member rows
  email_status: SpaceInviteEmailStatus | null;
  can_resend: boolean;
  resend_after_seconds: number | null;
}

@Injectable()
export class SpaceMembersService {
  constructor(
    @InjectRepository(SpaceMember)
    private readonly spaceMemberRepository: Repository<SpaceMember>,
    private readonly dataSource: DataSource,
    private readonly spaceAccessService: SpaceAccessService,
    private readonly spacesService: SpacesService,
    private readonly spaceInvitesService: SpaceInvitesService,
    private readonly delivery: SpaceInviteDelivery,
  ) {}

  async getAll(spaceId: number): Promise<WithRelations<SpaceMember, 'user'>[]> {
    const members = await this.spaceMemberRepository.find({
      where: { space_id: spaceId },
      relations: { user: true },
      order: { created_at: 'ASC' },
    });

    return members.map((member) => withRelations(member, 'user'));
  }

  async getMembersWithInvites(userId: number, spaceId: number): Promise<SpaceMemberView[]> {
    const caller = await this.spaceAccessService.assertMembership(spaceId, userId);
    const isOwner = caller.role === SpaceRole.OWNER;

    const [members, invites] = await Promise.all([this.getAll(spaceId), this.spaceInvitesService.getActive(spaceId)]);
    const deliveries = await this.delivery.describe(invites);

    const memberViews: SpaceMemberView[] = members.map((member) => ({
      type: 'member',
      id: member.id,
      user_id: member.user_id,
      name: member.user.name,
      email: member.user.email,
      role: member.role,
      can_remove: isOwner && member.user_id !== userId,
      email_status: null,
      can_resend: false,
      resend_after_seconds: null,
    }));

    const inviteViews: SpaceMemberView[] = invites.map((invite) => {
      const { email_status, resend_after_seconds } = deliveries.get(invite.id) as {
        email_status: SpaceInviteEmailStatus;
        resend_after_seconds: number;
      };

      return {
        type: 'invite',
        id: invite.id,
        user_id: null,
        name: null,
        email: invite.email,
        role: null,
        can_remove: isOwner,
        email_status,
        can_resend: isOwner && email_status !== SpaceInviteEmailStatus.SENDING && resend_after_seconds === 0,
        resend_after_seconds,
      };
    });

    return [...memberViews, ...inviteViews];
  }

  // Locks: lockMembers(), so the decision to transfer ownership or delete
  // the space is made on the membership that the write commits against.
  async leaveOrRemove(spaceId: number, actingUserId: number, targetUserId: number): Promise<void> {
    await this.spaceAccessService.assertMembership(spaceId, actingUserId);

    await runWriteTransaction(this.dataSource, async (manager) => {
      const locked = await this.spaceAccessService.lockMembers(spaceId, actingUserId, manager);
      const { actor, members } = locked;
      const repository = manager.getRepository(SpaceMember);

      if (targetUserId !== actingUserId) {
        if (actor.role !== SpaceRole.OWNER) {
          throw new ApiException('FORBIDDEN_SPACE', HttpStatus.FORBIDDEN);
        }

        const target = members.find((member) => member.user_id === targetUserId);

        if (!target) {
          throw new ApiException('NOT_FOUND', HttpStatus.NOT_FOUND);
        }

        await repository.delete(target.id);
        return;
      }

      if (actor.role !== SpaceRole.OWNER) {
        await repository.delete(actor.id);
        return;
      }

      const [successor] = members
        .filter((member) => member.id !== actor.id)
        .sort((a, b) => a.created_at.getTime() - b.created_at.getTime() || a.id - b.id);

      if (!successor) {
        await this.spacesService.removeOwned(manager, locked);
        return;
      }

      await repository.delete(actor.id);
      await repository.update(successor.id, { role: SpaceRole.OWNER });
    });
  }
}
