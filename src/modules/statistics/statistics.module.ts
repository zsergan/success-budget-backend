import { Module } from '@nestjs/common';

import { StatisticsController } from './statistics.controller';
import { StatisticsService } from './statistics.service';
import { SpaceAccessModule } from '@modules/space-access/space-access.module';
import { SpacesModule } from '@modules/spaces/spaces.module';
import { TransactionQueriesModule } from '@modules/transaction-queries/transaction-queries.module';

@Module({
  imports: [SpaceAccessModule, SpacesModule, TransactionQueriesModule],
  controllers: [StatisticsController],
  providers: [StatisticsService],
})
export class StatisticsModule {}
