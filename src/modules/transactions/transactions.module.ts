import { Module } from '@nestjs/common';

import { TransactionsController } from './transactions.controller';
import { TransactionsService } from './transactions.service';
import { WalletsModule } from '@modules/wallets/wallets.module';
import { CategoriesModule } from '@modules/categories/categories.module';
import { TransactionQueriesModule } from '@modules/transaction-queries/transaction-queries.module';
import { SpaceAccessModule } from '@modules/space-access/space-access.module';
import { IdempotencyModule } from '@modules/idempotency/idempotency.module';

@Module({
  imports: [WalletsModule, CategoriesModule, SpaceAccessModule, TransactionQueriesModule, IdempotencyModule],
  controllers: [TransactionsController],
  providers: [TransactionsService],
})
export class TransactionsModule {}
