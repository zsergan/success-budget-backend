import { HttpStatus, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';

import { Space } from '@entities/space.entity';
import { SpaceMember } from '@entities/space-member.entity';
import { SpaceRole } from '@shared/enums';
import { ApiException } from '@shared/api.exception';

@Injectable()
export class SpaceAccessService {
  constructor(
    @InjectRepository(SpaceMember)
    private readonly spaceMemberRepository: Repository<SpaceMember>,
  ) {}

  async assertMembership(
    spaceId: number,
    userId: number,
    minRole?: SpaceRole,
    manager?: EntityManager,
  ): Promise<SpaceMember> {
    const repository = manager?.getRepository(SpaceMember) ?? this.spaceMemberRepository;
    const member = await repository.findOne({ where: { space_id: spaceId, user_id: userId } });

    if (!member || (minRole === SpaceRole.OWNER && member.role !== SpaceRole.OWNER)) {
      throw new ApiException('FORBIDDEN_SPACE', HttpStatus.FORBIDDEN);
    }

    return member;
  }

  // A shared lock on the acting member's row: the membership cannot be
  // removed until the write commits. Writes that take it lock the member row
  // first and the space row second, the order space removal locks them in.
  async lockMembership(spaceId: number, userId: number, manager: EntityManager): Promise<SpaceMember> {
    const member = await manager
      .createQueryBuilder(SpaceMember, 'member')
      .setLock('pessimistic_read')
      .where('member.space_id = :spaceId AND member.user_id = :userId', { spaceId, userId })
      .getOne();

    if (!member) {
      throw new ApiException('FORBIDDEN_SPACE', HttpStatus.FORBIDDEN);
    }

    return member;
  }

  // Space-scoped invariants (one monthly total limit, one limit per category,
  // archiving a category with history) are guarded by an exclusive lock on the
  // space row, because the rows being checked may not exist yet. Transaction
  // writes take it shared: they run side by side but wait for those. Under
  // REPEATABLE READ it must come before the first plain read: InnoDB takes its
  // snapshot there, so reads after the lock see what the previous holder
  // committed.
  async lockSpace(spaceId: number, manager: EntityManager, mode: 'exclusive' | 'shared' = 'exclusive'): Promise<void> {
    await manager
      .createQueryBuilder(Space, 'space')
      .setLock(mode === 'exclusive' ? 'pessimistic_write' : 'pessimistic_read')
      .where('space.id = :spaceId', { spaceId })
      .getOne();
  }
}
