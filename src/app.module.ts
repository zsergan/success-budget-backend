import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { ormConfig } from './config/ormconfig';
import { UsersModule } from './modules/users/users.module';
import { CategoriesModule } from './modules/categories/categories.module';
import { WalletsModule } from './modules/wallets/wallets.module';
import { TransactionsModule } from './modules/transactions/transactions.module';
import { CurrenciesModule } from './modules/currencies/currencies.module';
import { ConfirmationCodesModule } from './modules/confirmation-codes/confirmation-codes.module';

@Module({
  imports: [
    TypeOrmModule.forRoot(ormConfig),
    UsersModule,
    CategoriesModule,
    WalletsModule,
    TransactionsModule,
    CurrenciesModule,
    ConfirmationCodesModule,
  ],
  controllers: [],
  providers: [],
})
export class AppModule {}
