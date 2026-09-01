import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PassportModule } from '@nestjs/passport';
import { ThrottlerModule } from '@nestjs/throttler';

import { ormConfig } from './config/ormconfig';
import { UsersModule } from './modules/users/users.module';
import { CategoriesModule } from './modules/categories/categories.module';
import { WalletsModule } from './modules/wallets/wallets.module';
import { TransactionsModule } from './modules/transactions/transactions.module';
import { CurrenciesModule } from './modules/currencies/currencies.module';
import { ConfirmationCodesModule } from './modules/confirmation-codes/confirmation-codes.module';
import { LimitsModule } from './modules/limits/limits.module';
import { JwtStrategy } from './shared/strategies/jwt.strategy';
import { JwtAuthGuard } from './shared/guards/jwt-auth.guard';

@Module({
  imports: [
    TypeOrmModule.forRoot(ormConfig),
    PassportModule,
    ThrottlerModule.forRoot([{ ttl: 60000, limit: 5 }]),
    UsersModule,
    CategoriesModule,
    WalletsModule,
    TransactionsModule,
    CurrenciesModule,
    ConfirmationCodesModule,
    LimitsModule,
  ],
  controllers: [],
  providers: [JwtStrategy, { provide: APP_GUARD, useClass: JwtAuthGuard }],
})
export class AppModule {}
