import { forwardRef, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { WalletsController } from './wallets.controller';
import { WalletsService } from './wallets.service';
import { TransactionsModule } from '@modules/transactions/transactions.module';
import { Wallet } from '@entities/wallet.entity';

@Module({
  imports: [TypeOrmModule.forFeature([Wallet]), forwardRef(() => TransactionsModule)],
  controllers: [WalletsController],
  providers: [WalletsService],
  exports: [WalletsService],
})
export class WalletsModule {}
