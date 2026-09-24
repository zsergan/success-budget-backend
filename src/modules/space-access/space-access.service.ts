import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { SpaceMember } from '@entities/space-member.entity';
import { SpaceRole } from '@shared/enums';
import { ErrorMessages } from '@shared/error-messages';

@Injectable()
export class SpaceAccessService {
  constructor(
    @InjectRepository(SpaceMember)
    private readonly spaceMemberRepository: Repository<SpaceMember>,
  ) {}

  async assertMembership(spaceId: number, userId: number, minRole?: SpaceRole): Promise<SpaceMember> {
    const member = await this.spaceMemberRepository.findOne({ where: { space_id: spaceId, user_id: userId } });

    if (!member || (minRole === SpaceRole.OWNER && member.role !== SpaceRole.OWNER)) {
      throw new HttpException(ErrorMessages.FORBIDDEN_SPACE, HttpStatus.FORBIDDEN);
    }

    return member;
  }
}
