import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { LimitsController } from './limits.controller';
import { LimitsService } from './limits.service';
import { TransactionsModule } from '@modules/transactions/transactions.module';
import { CategoriesModule } from '@modules/categories/categories.module';
import { TransactionQueriesModule } from '@modules/transaction-queries/transaction-queries.module';
import { SpaceAccessModule } from '@modules/space-access/space-access.module';
import { Limit } from '@entities/limit.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([Limit]),
    TransactionsModule,
    CategoriesModule,
    SpaceAccessModule,
    TransactionQueriesModule,
  ],
  controllers: [LimitsController],
  providers: [LimitsService],
})
export class LimitsModule {}
