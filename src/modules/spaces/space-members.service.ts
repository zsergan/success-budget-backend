import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Not, Repository } from 'typeorm';

import { SpaceMember } from '@entities/space-member.entity';
import { SpaceRole } from '@shared/enums';
import { ErrorMessages } from '@shared/error-messages';
import { SpaceAccessService } from '@modules/space-access/space-access.service';
import { SpacesService } from './spaces.service';

@Injectable()
export class SpaceMembersService {
  constructor(
    @InjectRepository(SpaceMember)
    private readonly spaceMemberRepository: Repository<SpaceMember>,
    private readonly dataSource: DataSource,
    private readonly spaceAccessService: SpaceAccessService,
    private readonly spacesService: SpacesService,
  ) {}

  async getAll(spaceId: number): Promise<SpaceMember[]> {
    return this.spaceMemberRepository.find({
      where: { space_id: spaceId },
      relations: { user: true },
      order: { created_at: 'ASC' },
    });
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
      await this.spacesService.remove(spaceId, actingUserId);
      return;
    }

    await this.dataSource.transaction(async (manager) => {
      await manager.getRepository(SpaceMember).delete(actingMember.id);
      await manager.getRepository(SpaceMember).update(nextOwner.id, { role: SpaceRole.OWNER });
    });
  }
}
