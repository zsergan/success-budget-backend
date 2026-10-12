import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { WalletsController } from './wallets.controller';
import { WalletsService } from './wallets.service';
import { SpacesModule } from '@modules/spaces/spaces.module';
import { TransactionQueriesModule } from '@modules/transaction-queries/transaction-queries.module';
import { SpaceAccessModule } from '@modules/space-access/space-access.module';
import { Wallet } from '@entities/wallet.entity';

@Module({
  imports: [TypeOrmModule.forFeature([Wallet]), SpacesModule, SpaceAccessModule, TransactionQueriesModule],
  controllers: [WalletsController],
  providers: [WalletsService],
  exports: [WalletsService],
})
export class WalletsModule {}
