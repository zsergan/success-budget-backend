import { Module } from '@nestjs/common';

import { TransactionsController } from './transactions.controller';
import { TransactionsV2Controller } from './transactions-v2.controller';
import { TransactionsService } from './transactions.service';
import { SpaceTransactionsService } from './space-transactions.service';
import { TransactionWrites } from './transaction-writes';
import { TransactionFeedReader } from './transaction-feed-reader';
import { WalletsModule } from '@modules/wallets/wallets.module';
import { CategoriesModule } from '@modules/categories/categories.module';
import { TransactionQueriesModule } from '@modules/transaction-queries/transaction-queries.module';
import { SpaceAccessModule } from '@modules/space-access/space-access.module';
import { IdempotencyModule } from '@modules/idempotency/idempotency.module';

@Module({
  imports: [WalletsModule, CategoriesModule, SpaceAccessModule, TransactionQueriesModule, IdempotencyModule],
  controllers: [TransactionsController, TransactionsV2Controller],
  providers: [TransactionsService, SpaceTransactionsService, TransactionWrites, TransactionFeedReader],
})
export class TransactionsModule {}
