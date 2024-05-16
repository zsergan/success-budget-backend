import { MiddlewareConsumer, Module, NestModule, RequestMethod } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { TransactionsController } from './transactions.controller';
import { TransactionsService } from './transactions.service';
import { HoldingsService } from '../holdings/holdings.service';
import { Transaction } from '../../entities/transaction.entity';
import { Holding } from '../../entities/holding.entity';
import { AuthMiddleware } from '../../shared/middlewares/auth.middleware';

@Module({
  imports: [TypeOrmModule.forFeature([Transaction, Holding])],
  controllers: [TransactionsController],
  providers: [TransactionsService, HoldingsService],
})
export class TransactionsModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer
      .apply(AuthMiddleware)
      .forRoutes(
        { path: 'transactions', method: RequestMethod.POST },
        { path: 'transactions', method: RequestMethod.GET },
      );
  }
}
