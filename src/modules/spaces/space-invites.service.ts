import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, MoreThan, IsNull, Repository } from 'typeorm';

import { Space } from '@entities/space.entity';
import { SpaceInvite } from '@entities/space-invite.entity';
import { SpaceMember } from '@entities/space-member.entity';
import { SpaceRole, SpaceType } from '@shared/enums';
import { SPACE_LIMITS, SPACE_INVITE_TTL_MS } from '@shared/constants';
import { ErrorMessages } from '@shared/error-messages';
import { assertFound, generateRandomNumberString, withRelations } from '@shared/utils';
import { SpaceAccessService } from '@modules/space-access/space-access.service';
import { UsersService } from '@modules/users/users.service';
import { SpacesService, type SpaceWithCurrency } from './spaces.service';

export interface CreatedSpaceInvite {
  id: number;
  email: string;
  expires_at: Date;
  code: string;
}

@Injectable()
export class SpaceInvitesService {
  constructor(
    @InjectRepository(SpaceInvite)
    private readonly spaceInviteRepository: Repository<SpaceInvite>,
    @InjectRepository(SpaceMember)
    private readonly spaceMemberRepository: Repository<SpaceMember>,
    private readonly dataSource: DataSource,
    private readonly spaceAccessService: SpaceAccessService,
    private readonly spacesService: SpacesService,
    private readonly usersService: UsersService,
  ) {}

  async create(userId: number, spaceId: number, email: string): Promise<CreatedSpaceInvite> {
    await this.spaceAccessService.assertMembership(spaceId, userId, SpaceRole.OWNER);
    const space = await this.spacesService.getOne(spaceId);
    assertFound(space);

    if (space.type === SpaceType.PERSONAL) {
      throw new HttpException(ErrorMessages.SPACE_PERSONAL_NO_INVITES, HttpStatus.BAD_REQUEST);
    }

    const activeCount = await this.getActive(space.id).then((invites) => invites.length);

    if (activeCount >= SPACE_LIMITS.MAX_PENDING_INVITES_PER_SPACE) {
      throw new HttpException(ErrorMessages.SPACE_INVITE_LIMIT_REACHED, HttpStatus.BAD_REQUEST);
    }

    const invite = this.spaceInviteRepository.create({
      space_id: space.id,
      email,
      code: generateRandomNumberString(),
      role: SpaceRole.MEMBER,
      expires_at: new Date(Date.now() + SPACE_INVITE_TTL_MS),
    });

    const saved = await this.spaceInviteRepository.save(invite);

    // the only response that ever exposes the raw code - every other view
    // (GET :id/members) only shows pending invites by email, never the code
    return { id: saved.id, email: saved.email, expires_at: saved.expires_at, code: saved.code };
  }

  async getActive(spaceId: number): Promise<SpaceInvite[]> {
    return this.spaceInviteRepository.find({
      where: { space_id: spaceId, accepted_at: IsNull(), revoked_at: IsNull(), expires_at: MoreThan(new Date()) },
      order: { created_at: 'ASC' },
    });
  }

  async revoke(userId: number, spaceId: number, inviteId: number): Promise<void> {
    await this.spaceAccessService.assertMembership(spaceId, userId, SpaceRole.OWNER);

    const invite = await this.spaceInviteRepository.findOne({
      where: { id: inviteId, space_id: spaceId, accepted_at: IsNull(), revoked_at: IsNull() },
    });

    if (!invite) {
      throw new HttpException(ErrorMessages.NOT_FOUND, HttpStatus.NOT_FOUND);
    }

    await this.spaceInviteRepository.update(invite.id, { revoked_at: new Date() });
  }

  async accept(userId: number, code: string): Promise<SpaceWithCurrency> {
    const user = await this.usersService.findById(userId);
    assertFound(user);

    const invite = await this.spaceInviteRepository.findOne({
      where: {
        email: user.email,
        code,
        accepted_at: IsNull(),
        revoked_at: IsNull(),
        expires_at: MoreThan(new Date()),
      },
    });

    if (!invite) {
      throw new HttpException(ErrorMessages.NOT_FOUND, HttpStatus.NOT_FOUND);
    }

    const memberCount = await this.spaceMemberRepository.count({ where: { space_id: invite.space_id } });

    if (memberCount >= SPACE_LIMITS.MAX_MEMBERS_PER_SPACE) {
      throw new HttpException(ErrorMessages.SPACE_MEMBER_LIMIT_REACHED, HttpStatus.BAD_REQUEST);
    }

    return this.dataSource.transaction(async (manager) => {
      await manager.getRepository(SpaceMember).save(
        manager.getRepository(SpaceMember).create({
          space_id: invite.space_id,
          user_id: userId,
          role: invite.role,
        }),
      );
      await manager.getRepository(SpaceInvite).update(invite.id, { accepted_at: new Date() });

      const space = await manager
        .getRepository(Space)
        .findOne({ where: { id: invite.space_id }, relations: { currency: true } });

      assertFound(space);

      return withRelations(space, 'currency');
    });
  }
}
