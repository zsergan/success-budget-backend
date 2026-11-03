import { Module } from '@nestjs/common';

import { InvitePage } from './invite-page';
import { InvitePageController } from './invite-page.controller';

@Module({
  controllers: [InvitePageController],
  providers: [InvitePage],
})
export class InvitePageModule {}
