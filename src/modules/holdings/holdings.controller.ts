import { Body, Controller, Get, Post, Query, Request } from '@nestjs/common';

import { HoldingsService } from './holdings.service';
import type { CreateHoldingDto } from './dto/create-holding.dto';
import type { AuthedRequest } from '../../shared/types';
import { getEndOfMonth, getStartOfMonth } from '../../shared/utils';
import { TransactionsService } from '../transactions/transactions.service';
import { TransactionType } from '../../shared/enums';
import { Holding } from '../../entities/holding.entity';

@Controller('holdings')
export class HoldingsController {
  constructor(
    private readonly holdingsService: HoldingsService,
    private readonly transactionsService: TransactionsService,
  ) {}

  @Post()
  async create(@Request() req: AuthedRequest, @Body() createHoldingDto: CreateHoldingDto) {
    return this.holdingsService.create(req.user.id, createHoldingDto);
  }

  @Get()
  async getAll(
    @Request() req: AuthedRequest,
    @Query('from') from: Date = getStartOfMonth(new Date()),
    @Query('to') to: Date = getEndOfMonth(new Date()),
  ): Promise<{ holding: Holding; totalSpend: number; totalIncome: number }[]> {
    const holdings = await this.holdingsService.getAll(req.user.id);
    const transactions = await Promise.all(
      holdings.map((holding) => this.transactionsService.getAll(holding.id, from, to)),
    );

    return holdings.map((holding, index) => {
      const { totalSpend, totalIncome } = transactions[index].reduce(
        (acc, transaction) => {
          if (transaction.transaction_type === TransactionType.INCOME) {
            acc.totalIncome += Number(transaction.amount);
          } else {
            acc.totalSpend += Number(transaction.amount);
          }

          return acc;
        },
        {
          totalSpend: 0,
          totalIncome: 0,
        },
      );

      return {
        holding: { ...holding },
        totalSpend,
        totalIncome,
      };
    });
  }
}
