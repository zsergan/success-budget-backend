import { Module } from '@nestjs/common';

import { TransactionsV2Controller } from './transactions-v2.controller';
import { SpaceTransactionsService } from './space-transactions.service';
import { TransactionWrites } from './transaction-writes';
import { TransactionFeedReader } from './transaction-feed-reader';
import { CategoriesModule } from '@modules/categories/categories.module';
import { TransactionQueriesModule } from '@modules/transaction-queries/transaction-queries.module';
import { SpaceAccessModule } from '@modules/space-access/space-access.module';
import { IdempotencyModule } from '@modules/idempotency/idempotency.module';

@Module({
  imports: [CategoriesModule, SpaceAccessModule, TransactionQueriesModule, IdempotencyModule],
  controllers: [TransactionsV2Controller],
  providers: [SpaceTransactionsService, TransactionWrites, TransactionFeedReader],
})
export class TransactionsModule {}
