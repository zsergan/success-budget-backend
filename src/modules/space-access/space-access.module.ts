import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { SpaceAccessService } from './space-access.service';
import { SpaceMember } from '@entities/space-member.entity';

@Module({
  imports: [TypeOrmModule.forFeature([SpaceMember])],
  providers: [SpaceAccessService],
  exports: [SpaceAccessService],
})
export class SpaceAccessModule {}
