import {
  Body,
  ClassSerializerInterceptor,
  Controller,
  Get,
  HttpException,
  HttpStatus,
  ParseIntPipe,
  Post,
  Query,
  Request,
  UseInterceptors,
} from '@nestjs/common';

import { TransactionsService } from './transactions.service';
import { HoldingsService } from '../holdings/holdings.service';
import { CreateTransactionDto } from './dto/create-transaction.dto';
import type { AuthedRequest } from '../../shared/types';
import { getEndOfMonth, getStartOfMonth } from '../../shared/utils';
import { TransactionType } from '../../shared/enums';
import { ErrorMessages } from '../../shared/error-messages';

@Controller('transactions')
export class TransactionsController {
  constructor(
    private readonly transactionsService: TransactionsService,
    private readonly holdingsService: HoldingsService,
  ) {}

  @Post()
  async create(@Request() req: AuthedRequest, @Body() createTransactionDto: CreateTransactionDto) {
    const holding = await this.holdingsService.getOne(createTransactionDto.holding_id);

    if (holding.user_id !== req.user.id) {
      throw new HttpException(ErrorMessages.FORBIDDEN_HOLDING, HttpStatus.FORBIDDEN);
    }

    await this.holdingsService.update(holding.id, {
      balance:
        Number(holding.balance) +
        (createTransactionDto.transaction_type === TransactionType.INCOME
          ? Number(createTransactionDto.amount)
          : -Number(createTransactionDto.amount)),
      name: holding.name,
    });

    return this.transactionsService.create(createTransactionDto);
  }

  @UseInterceptors(ClassSerializerInterceptor)
  @Get()
  async getAll(@Request() req: AuthedRequest, @Query('holdingId', ParseIntPipe) holdingId: number) {
    const holding = await this.holdingsService.getOne(holdingId);

    if (holding.user_id !== req.user.id) {
      throw new HttpException(ErrorMessages.FORBIDDEN_HOLDING, HttpStatus.FORBIDDEN);
    }

    return this.transactionsService.getAll(holdingId, getStartOfMonth(new Date()), getEndOfMonth(new Date()));
  }
}
