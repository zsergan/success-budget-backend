import { MiddlewareConsumer, Module, NestModule, RequestMethod } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { WalletsController } from './wallets.controller';
import { WalletsService } from './wallets.service';
import { TransactionsService } from '../transactions/transactions.service';
import { Wallet } from '../../entities/wallet.entity';
import { Transaction } from '../../entities/transaction.entity';
import { AuthMiddleware } from '../../shared/middlewares/auth.middleware';

@Module({
  imports: [TypeOrmModule.forFeature([Wallet, Transaction])],
  controllers: [WalletsController],
  providers: [WalletsService, TransactionsService],
})
export class WalletsModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer
      .apply(AuthMiddleware)
      .forRoutes(
        { path: 'wallets', method: RequestMethod.POST },
        { path: 'wallets', method: RequestMethod.GET },
        { path: 'wallets/:walletId', method: RequestMethod.DELETE },
      );
  }
}
