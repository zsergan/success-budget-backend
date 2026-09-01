import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { LimitsController } from './limits.controller';
import { LimitsService } from './limits.service';
import { TransactionsService } from '../transactions/transactions.service';
import { CategoriesService } from '../categories/categories.service';
import { Transaction } from '../../entities/transaction.entity';
import { Limit } from '../../entities/limit.entity';
import { Category } from '../../entities/category.entity';

@Module({
  imports: [TypeOrmModule.forFeature([Limit, Transaction, Category])],
  controllers: [LimitsController],
  providers: [LimitsService, TransactionsService, CategoriesService],
})
export class LimitsModule {}
