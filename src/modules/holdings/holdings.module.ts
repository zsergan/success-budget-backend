import { MiddlewareConsumer, Module, NestModule, RequestMethod } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { HoldingsController } from './holdings.controller';
import { HoldingsService } from './holdings.service';
import { TransactionsService } from '../transactions/transactions.service';
import { Holding } from '../../entities/holding.entity';
import { Transaction } from '../../entities/transaction.entity';
import { AuthMiddleware } from '../../shared/middlewares/auth.middleware';

@Module({
  imports: [TypeOrmModule.forFeature([Holding, Transaction])],
  controllers: [HoldingsController],
  providers: [HoldingsService, TransactionsService],
})
export class HoldingsModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer
      .apply(AuthMiddleware)
      .forRoutes({ path: 'holdings', method: RequestMethod.POST }, { path: 'holdings', method: RequestMethod.GET });
  }
}
