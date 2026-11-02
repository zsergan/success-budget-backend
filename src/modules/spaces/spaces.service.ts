import { HttpStatus, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, In, Repository } from 'typeorm';

import { Space } from '@entities/space.entity';
import { SpaceMember } from '@entities/space-member.entity';
import { SpaceInvite } from '@entities/space-invite.entity';
import type { CreateSpaceDto } from './dto/create-space.dto';
import { SpaceRole, SpaceType } from '@shared/enums';
import { SPACE_LIMITS } from '@shared/constants';
import { ApiException } from '@shared/api.exception';
import { assertFound, runWriteTransaction, withRelations } from '@shared/utils';
import type { WithRelations } from '@shared/types';
import { SpaceAccessService } from '@modules/space-access/space-access.service';
import { IdempotencyService } from '@modules/idempotency/idempotency.service';
import { NO_SPACE_ID } from '@entities/idempotency-key.entity';
import { createDefaultCategories, createSpaceWithOwner } from './space-setup';
import { newInvite, normalizeInviteEmail } from './space-invite-state';

export type SpaceWithCurrency = WithRelations<Space, 'currency'>;

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
    private readonly idempotencyService: IdempotencyService,
  ) {}

  // One write transaction: the space, its owner, categories, invitations and
  // their queued emails commit together or not at all; nothing is sent from
  // inside it. With a key, a repeat returns the stored result and writes
  // nothing. The key is scoped to the user, as the space does not exist yet.
  async create(
    userId: number,
    dto: CreateSpaceDto,
    { idempotencyKey }: { idempotencyKey?: string } = {},
  ): Promise<SpaceWithCurrency> {
    const emails = [...new Set((dto.invites ?? []).map(normalizeInviteEmail))];

    if (dto.type === SpaceType.PERSONAL && emails.length) {
      throw new ApiException('SPACE_PERSONAL_NO_INVITES', HttpStatus.BAD_REQUEST);
    }

    if (emails.length > SPACE_LIMITS.MAX_PENDING_INVITES_PER_SPACE) {
      throw new ApiException('SPACE_INVITE_LIMIT_REACHED', HttpStatus.BAD_REQUEST);
    }

    return runWriteTransaction(this.dataSource, (manager) => {
      const work = async () => {
        const space = await createSpaceWithOwner(
          manager,
          { name: dto.name, type: dto.type, currency_id: dto.currency_id },
          userId,
        );
        await createDefaultCategories(manager, space.id);

        if (emails.length) {
          const now = new Date();
          await manager.getRepository(SpaceInvite).insert(emails.map((email) => newInvite(space.id, email, now)));
        }

        const created = await this.getOne(space.id, manager);
        assertFound(created);

        return created;
      };

      if (idempotencyKey === undefined) {
        return work();
      }

      return this.idempotencyService.run(
        manager,
        { userId, spaceId: NO_SPACE_ID, operation: 'spaces.create', key: idempotencyKey, payload: dto },
        work,
      );
    });
  }

  async getAllForUser(userId: number): Promise<SpaceListItem[]> {
    const memberships = await this.spaceMemberRepository.find({ where: { user_id: userId } });

    if (memberships.length === 0) {
      return [];
    }

    const spaceIds = memberships.map((membership) => membership.space_id);
    const spaces = (
      await this.spaceRepository.find({
        where: { id: In(spaceIds) },
        relations: { currency: true },
      })
    ).map((space) => withRelations(space, 'currency'));

    const counts = await this.spaceMemberRepository
      .createQueryBuilder('member')
      .select('member.space_id', 'space_id')
      .addSelect('COUNT(*)', 'count')
      .where('member.space_id IN (:...spaceIds)', { spaceIds })
      .groupBy('member.space_id')
      .getRawMany<{ space_id: number; count: string }>();
    const countBySpaceId = new Map(counts.map((row) => [Number(row.space_id), Number(row.count)]));
    const roleBySpaceId = new Map(memberships.map((membership) => [membership.space_id, membership.role]));

    return spaces.flatMap((space) => {
      const role = roleBySpaceId.get(space.id);

      if (role === undefined) {
        return [];
      }

      return {
        id: space.id,
        name: space.name,
        type: space.type,
        currency: { id: space.currency.id, code: space.currency.code, name: space.currency.name },
        role,
        member_count: countBySpaceId.get(space.id) ?? 0,
        created_at: space.created_at,
      };
    });
  }

  async getOne(spaceId: number, manager?: EntityManager): Promise<SpaceWithCurrency | null> {
    const repository = manager?.getRepository(Space) ?? this.spaceRepository;
    const space = await repository.findOne({ where: { id: spaceId }, relations: { currency: true } });

    return space && withRelations(space, 'currency');
  }

  async getForMember(userId: number, spaceId: number): Promise<SpaceWithCurrency> {
    await this.spaceAccessService.assertMembership(spaceId, userId);

    return this.getExisting(spaceId);
  }

  async remove(userId: number, spaceId: number): Promise<void> {
    await this.spaceAccessService.assertMembership(spaceId, userId, SpaceRole.OWNER);
    await this.removeOwned(userId, spaceId);
  }

  // the caller must already have verified that userId owns spaceId
  async removeOwned(userId: number, spaceId: number): Promise<void> {
    const spaceCount = await this.spaceMemberRepository.count({ where: { user_id: userId } });

    if (spaceCount <= 1) {
      throw new ApiException('SPACE_LAST_REMAINING', HttpStatus.BAD_REQUEST);
    }

    // members, then the space, whose deletion cascades to its invitations:
    // invitation acceptance locks the space before the invitation
    await this.dataSource.transaction(async (manager) => {
      await manager.getRepository(SpaceMember).delete({ space_id: spaceId });
      await manager.getRepository(Space).delete(spaceId);
    });
  }

  private async getExisting(spaceId: number): Promise<SpaceWithCurrency> {
    const space = await this.getOne(spaceId);
    assertFound(space);

    return space;
  }
}
