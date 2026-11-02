import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { SpacesController } from './spaces.controller';
import { SpacesService } from './spaces.service';
import { SpaceMembersService } from './space-members.service';
import { SpaceInvitesService } from './space-invites.service';
import { SpaceInviteLinks } from './space-invite-links';
import { SpaceInviteDelivery } from './space-invite-delivery';
import { SpaceAccessModule } from '@modules/space-access/space-access.module';
import { UsersModule } from '@modules/users/users.module';
import { IdempotencyModule } from '@modules/idempotency/idempotency.module';
import { MailModule } from '@modules/mail/mail.module';
import { Space } from '@entities/space.entity';
import { SpaceMember } from '@entities/space-member.entity';
import { SpaceInvite } from '@entities/space-invite.entity';
import { SpaceInviteEmail } from '@entities/space-invite-email.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([Space, SpaceMember, SpaceInvite, SpaceInviteEmail]),
    SpaceAccessModule,
    UsersModule,
    IdempotencyModule,
    MailModule,
  ],
  controllers: [SpacesController],
  providers: [SpacesService, SpaceMembersService, SpaceInvitesService, SpaceInviteLinks, SpaceInviteDelivery],
  exports: [SpacesService],
})
export class SpacesModule {}
