import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { LimitsController } from './limits.controller';
import { LimitsService } from './limits.service';
import { TransactionsModule } from '@modules/transactions/transactions.module';
import { CategoriesModule } from '@modules/categories/categories.module';
import { SpacesModule } from '@modules/spaces/spaces.module';
import { Limit } from '@entities/limit.entity';

@Module({
  imports: [TypeOrmModule.forFeature([Limit]), TransactionsModule, CategoriesModule, SpacesModule],
  controllers: [LimitsController],
  providers: [LimitsService],
})
export class LimitsModule {}
