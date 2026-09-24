import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Not, Repository } from 'typeorm';

import { SpaceMember } from '@entities/space-member.entity';
import { SpaceRole } from '@shared/enums';
import type { WithRelations } from '@shared/types';
import { withRelations } from '@shared/utils';
import { ErrorMessages } from '@shared/error-messages';
import { SpaceAccessService } from '@modules/space-access/space-access.service';
import { SpacesService } from './spaces.service';
import { SpaceInvitesService } from './space-invites.service';

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

    const memberViews: SpaceMemberView[] = members.map((member) => ({
      type: 'member',
      id: member.id,
      user_id: member.user_id,
      name: member.user.name,
      email: member.user.email,
      role: member.role,
      can_remove: isOwner && member.user_id !== userId,
    }));

    const inviteViews: SpaceMemberView[] = invites.map((invite) => ({
      type: 'invite',
      id: invite.id,
      user_id: null,
      name: null,
      email: invite.email,
      role: null,
      can_remove: isOwner,
    }));

    return [...memberViews, ...inviteViews];
  }

  async leaveOrRemove(spaceId: number, actingUserId: number, targetUserId: number): Promise<void> {
    const actingMember = await this.spaceAccessService.assertMembership(spaceId, actingUserId);

    if (targetUserId !== actingUserId) {
      if (actingMember.role !== SpaceRole.OWNER) {
        throw new HttpException(ErrorMessages.FORBIDDEN_SPACE, HttpStatus.FORBIDDEN);
      }

      const targetMember = await this.spaceMemberRepository.findOne({
        where: { space_id: spaceId, user_id: targetUserId },
      });

      if (!targetMember) {
        throw new HttpException(ErrorMessages.NOT_FOUND, HttpStatus.NOT_FOUND);
      }

      await this.spaceMemberRepository.delete(targetMember.id);
      return;
    }

    if (actingMember.role !== SpaceRole.OWNER) {
      await this.spaceMemberRepository.delete(actingMember.id);
      return;
    }

    const nextOwner = await this.spaceMemberRepository.findOne({
      where: { space_id: spaceId, user_id: Not(actingUserId) },
      order: { created_at: 'ASC' },
    });

    if (!nextOwner) {
      // sole remaining member of the space - leaving is equivalent to
      // deleting it (also carries the "not your last remaining space" guard)
      await this.spacesService.removeOwned(actingUserId, spaceId);
      return;
    }

    await this.dataSource.transaction(async (manager) => {
      await manager.getRepository(SpaceMember).delete(actingMember.id);
      await manager.getRepository(SpaceMember).update(nextOwner.id, { role: SpaceRole.OWNER });
    });
  }
}
