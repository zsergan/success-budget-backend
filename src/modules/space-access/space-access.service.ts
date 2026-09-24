import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';

import { Space } from '@entities/space.entity';
import { SpaceMember } from '@entities/space-member.entity';
import { SpaceRole } from '@shared/enums';
import { ErrorMessages } from '@shared/error-messages';

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
      throw new HttpException(ErrorMessages.FORBIDDEN_SPACE, HttpStatus.FORBIDDEN);
    }

    return member;
  }

  // Space-scoped invariants (one monthly total limit, one limit per category)
  // are guarded by locking the space row, because the rows being checked may
  // not exist yet. Must be the first statement of the transaction: InnoDB
  // takes its snapshot at the first plain read, so reads after the lock see
  // what the previous holder committed.
  async lockSpace(spaceId: number, manager: EntityManager): Promise<void> {
    await manager
      .createQueryBuilder(Space, 'space')
      .setLock('pessimistic_write')
      .where('space.id = :spaceId', { spaceId })
      .getOne();
  }
}
