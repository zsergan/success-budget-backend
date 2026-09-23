import { forwardRef, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { WalletsController } from './wallets.controller';
import { WalletsService } from './wallets.service';
import { TransactionsModule } from '@modules/transactions/transactions.module';
import { SpacesModule } from '@modules/spaces/spaces.module';
import { TransactionQueriesModule } from '@modules/transaction-queries/transaction-queries.module';
import { SpaceAccessModule } from '@modules/space-access/space-access.module';
import { Wallet } from '@entities/wallet.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([Wallet]),
    forwardRef(() => TransactionsModule),
    SpacesModule,
    SpaceAccessModule,
    TransactionQueriesModule,
  ],
  controllers: [WalletsController],
  providers: [WalletsService],
  exports: [WalletsService],
})
export class WalletsModule {}
