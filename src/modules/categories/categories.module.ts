import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { Category } from '@entities/category.entity';
import { Transaction } from '@entities/transaction.entity';
import { Limit } from '@entities/limit.entity';
import { CategoriesController } from './categories.controller';
import { CategoriesService } from './categories.service';

@Module({
  // Transaction/Limit registered directly (not via their modules) to avoid a
  // forwardRef() cycle - both already import CategoriesModule.
  imports: [TypeOrmModule.forFeature([Category, Transaction, Limit])],
  controllers: [CategoriesController],
  providers: [CategoriesService],
  exports: [CategoriesService],
})
export class CategoriesModule {}
