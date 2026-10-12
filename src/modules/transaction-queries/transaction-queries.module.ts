import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { TransactionQueriesService } from './transaction-queries.service';
import { Transaction } from '@entities/transaction.entity';

@Module({
  imports: [TypeOrmModule.forFeature([Transaction])],
  providers: [TransactionQueriesService],
  exports: [TransactionQueriesService],
})
export class TransactionQueriesModule {}
