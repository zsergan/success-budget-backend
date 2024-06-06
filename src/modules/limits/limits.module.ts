import { MiddlewareConsumer, Module, NestModule, RequestMethod } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { LimitsController } from './limits.controller';
import { LimitsService } from './limits.service';
import { TransactionsService } from '../transactions/transactions.service';
import { Transaction } from '../../entities/transaction.entity';
import { Limit } from '../../entities/limit.entity';
import { AuthMiddleware } from '../../shared/middlewares/auth.middleware';

@Module({
  imports: [TypeOrmModule.forFeature([Limit, Transaction])],
  controllers: [LimitsController],
  providers: [LimitsService, TransactionsService],
})
export class LimitsModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer
      .apply(AuthMiddleware)
      .forRoutes(
        { path: 'limits', method: RequestMethod.POST },
        { path: 'limits', method: RequestMethod.GET },
        { path: 'limits/:limitId', method: RequestMethod.PUT },
      );
  }
}
