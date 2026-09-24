import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, Repository } from 'typeorm';

import { Space } from '@entities/space.entity';
import { SpaceMember } from '@entities/space-member.entity';
import { SpaceInvite } from '@entities/space-invite.entity';
import type { CreateSpaceDto } from './dto/create-space.dto';
import { SpaceRole, SpaceType } from '@shared/enums';
import { SPACE_LIMITS, SPACE_INVITE_TTL_MS } from '@shared/constants';
import { ErrorMessages } from '@shared/error-messages';
import { generateRandomNumberString } from '@shared/utils';
import { SpaceAccessService } from '@modules/space-access/space-access.service';
import { createDefaultCategories, createSpaceWithOwner } from './space-setup';

export interface SpaceListItem {
  id: number;
  name: string;
  type: SpaceType;
  currency: { id: number; code: string; name: string };
  role: SpaceRole;
  member_count: number;
  created_at: Date;
}

@Injectable()
export class SpacesService {
  constructor(
    @InjectRepository(Space)
    private readonly spaceRepository: Repository<Space>,
    @InjectRepository(SpaceMember)
    private readonly spaceMemberRepository: Repository<SpaceMember>,
    private readonly dataSource: DataSource,
    private readonly spaceAccessService: SpaceAccessService,
  ) {}

  async create(userId: number, dto: CreateSpaceDto): Promise<Space> {
    const invites = dto.invites ?? [];

    if (dto.type === SpaceType.PERSONAL && invites.length) {
      throw new HttpException(ErrorMessages.SPACE_PERSONAL_NO_INVITES, HttpStatus.BAD_REQUEST);
    }

    if (invites.length > SPACE_LIMITS.MAX_PENDING_INVITES_PER_SPACE) {
      throw new HttpException(ErrorMessages.SPACE_INVITE_LIMIT_REACHED, HttpStatus.BAD_REQUEST);
    }

    const spaceId = await this.dataSource.transaction(async (manager) => {
      const space = await createSpaceWithOwner(
        manager,
        { name: dto.name, type: dto.type, currency_id: dto.currency_id },
        userId,
      );
      await createDefaultCategories(manager, space.id);

      if (invites.length) {
        const inviteRows = invites.map((email) =>
          manager.getRepository(SpaceInvite).create({
            space_id: space.id,
            email,
            code: generateRandomNumberString(),
            role: SpaceRole.MEMBER,
            expires_at: new Date(Date.now() + SPACE_INVITE_TTL_MS),
          }),
        );
        await manager.getRepository(SpaceInvite).save(inviteRows);
      }

      return space.id;
    });

    return this.getOne(spaceId);
  }

  async getAllForUser(userId: number): Promise<SpaceListItem[]> {
    const memberships = await this.spaceMemberRepository.find({ where: { user_id: userId } });

    if (memberships.length === 0) {
      return [];
    }

    const spaceIds = memberships.map((membership) => membership.space_id);
    const spaces = await this.spaceRepository.find({
      where: { id: In(spaceIds) },
      relations: { currency: true },
    });

    const counts = await this.spaceMemberRepository
      .createQueryBuilder('member')
      .select('member.space_id', 'space_id')
      .addSelect('COUNT(*)', 'count')
      .where('member.space_id IN (:...spaceIds)', { spaceIds })
      .groupBy('member.space_id')
      .getRawMany<{ space_id: number; count: string }>();
    const countBySpaceId = new Map(counts.map((row) => [Number(row.space_id), Number(row.count)]));
    const roleBySpaceId = new Map(memberships.map((membership) => [membership.space_id, membership.role]));

    return spaces.map((space) => ({
      id: space.id,
      name: space.name,
      type: space.type,
      currency: { id: space.currency.id, code: space.currency.code, name: space.currency.name },
      role: roleBySpaceId.get(space.id),
      member_count: countBySpaceId.get(space.id) ?? 0,
      created_at: space.created_at,
    }));
  }

  async getOne(spaceId: number): Promise<Space> {
    return this.spaceRepository.findOne({ where: { id: spaceId }, relations: { currency: true } });
  }

  async getForMember(userId: number, spaceId: number): Promise<Space> {
    await this.spaceAccessService.assertMembership(spaceId, userId);

    return this.getOne(spaceId);
  }

  async remove(userId: number, spaceId: number): Promise<void> {
    await this.spaceAccessService.assertMembership(spaceId, userId, SpaceRole.OWNER);
    await this.removeOwned(userId, spaceId);
  }

  // the caller must already have verified that userId owns spaceId
  async removeOwned(userId: number, spaceId: number): Promise<void> {
    const spaceCount = await this.spaceMemberRepository.count({ where: { user_id: userId } });

    if (spaceCount <= 1) {
      throw new HttpException(ErrorMessages.SPACE_LAST_REMAINING, HttpStatus.BAD_REQUEST);
    }

    await this.dataSource.transaction(async (manager) => {
      await manager.getRepository(SpaceInvite).delete({ space_id: spaceId });
      await manager.getRepository(SpaceMember).delete({ space_id: spaceId });
      await manager.getRepository(Space).delete(spaceId);
    });
  }
}
