import {
  Body,
  Controller,
  Delete,
  Get,
  HttpException,
  HttpStatus,
  Param,
  ParseIntPipe,
  Post,
  Put,
  Query,
  Request,
} from '@nestjs/common';

import { WalletsService } from './wallets.service';
import { CreateWalletDto } from './dto/create-wallet.dto';
import { UpdateWalletDto } from './dto/update-wallet.dto';
import type { AuthedRequest } from '../../shared/types';
import { getEndOfMonth, getStartOfMonth } from '../../shared/utils';
import { TransactionsService } from '../transactions/transactions.service';
import { TransactionType } from '../../shared/enums';
import { Wallet } from '../../entities/wallet.entity';
import { ErrorMessages } from '../../shared/error-messages';

@Controller('wallets')
export class WalletsController {
  constructor(
    private readonly walletsService: WalletsService,
    private readonly transactionsService: TransactionsService,
  ) {}

  @Post()
  async create(@Request() req: AuthedRequest, @Body() createWalletDto: CreateWalletDto) {
    return this.walletsService.create(req.user.id, createWalletDto);
  }

  @Put(':walletId')
  async update(
    @Request() req: AuthedRequest,
    @Param('walletId', ParseIntPipe) walletId: number,
    @Body() updateWalletDto: UpdateWalletDto,
  ) {
    const wallet = await this.walletsService.getOne(walletId);

    if (wallet.user_id !== req.user.id) {
      throw new HttpException(ErrorMessages.FORBIDDEN_WALLET, HttpStatus.FORBIDDEN);
    }

    return this.walletsService.update(walletId, updateWalletDto);
  }

  @Get()
  async getAll(
    @Request() req: AuthedRequest,
    @Query('from') from: Date = getStartOfMonth(new Date()),
    @Query('to') to: Date = getEndOfMonth(new Date()),
  ): Promise<{ wallet: Wallet; totalSpend: number; totalIncome: number }[]> {
    const wallets = await this.walletsService.getAll(req.user.id);
    const transactions = await Promise.all(
      wallets.map((wallet) => this.transactionsService.getAll(wallet.id, from, to)),
    );

    return wallets.map((wallet, index) => {
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
        wallet: { ...wallet },
        totalSpend,
        totalIncome,
      };
    });
  }

  @Delete(':walletId')
  async delete(@Request() req: AuthedRequest, @Param('walletId', ParseIntPipe) walletId: number): Promise<boolean> {
    const wallet = await this.walletsService.getOne(walletId);

    if (wallet.user_id !== req.user.id) {
      throw new HttpException(ErrorMessages.FORBIDDEN_WALLET, HttpStatus.FORBIDDEN);
    }

    await this.walletsService.delete(walletId);

    return true;
  }
}
