import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { SpacesController } from './spaces.controller';
import { SpacesService } from './spaces.service';
import { SpaceMembersService } from './space-members.service';
import { SpaceInvitesService } from './space-invites.service';
import { UsersModule } from '@modules/users/users.module';
import { Space } from '@entities/space.entity';
import { SpaceMember } from '@entities/space-member.entity';
import { SpaceInvite } from '@entities/space-invite.entity';

@Module({
  imports: [TypeOrmModule.forFeature([Space, SpaceMember, SpaceInvite]), UsersModule],
  controllers: [SpacesController],
  providers: [SpacesService, SpaceMembersService, SpaceInvitesService],
  exports: [SpacesService, SpaceMembersService, SpaceInvitesService],
})
export class SpacesModule {}
