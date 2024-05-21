import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { ormConfig } from './config/ormconfig';
import { UsersModule } from './modules/users/users.module';
import { CategoriesModule } from './modules/categories/categories.module';
import { WalletsModule } from './modules/wallets/wallets.module';
import { TransactionsModule } from './modules/transactions/transactions.module';

@Module({
  imports: [TypeOrmModule.forRoot(ormConfig), UsersModule, CategoriesModule, WalletsModule, TransactionsModule],
  controllers: [],
  providers: [],
})
export class AppModule {}
