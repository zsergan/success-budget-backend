import {
  Body,
  ClassSerializerInterceptor,
  Controller,
  Get,
  HttpException,
  HttpStatus,
  Post,
  Request,
  UseInterceptors,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';

import { TransactionsService } from './transactions.service';
import { WalletsService } from '../wallets/wallets.service';
import { CreateTransactionDto } from './dto/create-transaction.dto';
import type { AuthedRequest } from '../../shared/types';
import { getEndOfMonth, getStartOfMonth } from '../../shared/utils';
import { ErrorMessages } from '../../shared/error-messages';

@ApiTags('transactions')
@ApiBearerAuth()
@Controller('transactions')
export class TransactionsController {
  constructor(
    private readonly transactionsService: TransactionsService,
    private readonly walletsService: WalletsService,
  ) {}

  @Post()
  async create(@Request() req: AuthedRequest, @Body() createTransactionDto: CreateTransactionDto) {
    const wallet = await this.walletsService.getOne(createTransactionDto.wallet_id);

    if (!wallet || wallet.is_deleted || wallet.user_id !== req.user.id) {
      throw new HttpException(ErrorMessages.FORBIDDEN_WALLET, HttpStatus.FORBIDDEN);
    }

    return this.transactionsService.create(wallet.id, wallet.currency_id, createTransactionDto);
  }

  @UseInterceptors(ClassSerializerInterceptor)
  @Get()
  async getAll(@Request() req: AuthedRequest) {
    const transactions = await this.transactionsService.getForAllWallets(
      req.user.id,
      getStartOfMonth(new Date()),
      getEndOfMonth(new Date()),
    );

    return transactions.map((transaction) => ({
      ...transaction,
      wallet: transaction.wallet.is_deleted ? null : transaction.wallet,
    }));
  }
}
