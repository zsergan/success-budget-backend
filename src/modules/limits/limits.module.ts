import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { LimitsController } from './limits.controller';
import { LimitsService } from './limits.service';
import { TransactionsService } from '../transactions/transactions.service';
import { Transaction } from '../../entities/transaction.entity';
import { Limit } from '../../entities/limit.entity';

@Module({
  imports: [TypeOrmModule.forFeature([Limit, Transaction])],
  controllers: [LimitsController],
  providers: [LimitsService, TransactionsService],
})
export class LimitsModule {}
