import {
  Body,
  ClassSerializerInterceptor,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Put,
  Query,
  Request,
  UseInterceptors,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';

import { WalletsService } from './wallets.service';
import { CreateWalletDto } from './dto/create-wallet.dto';
import { UpdateWalletDto } from './dto/update-wallet.dto';
import type { AuthedRequest } from '../../shared/types';
import { getEndOfMonth, getStartOfMonth, assertOwnership } from '../../shared/utils';
import { TransactionsService } from '../transactions/transactions.service';
import { TransactionType } from '../../shared/enums';
import { Wallet } from '../../entities/wallet.entity';
import { ErrorMessages } from '../../shared/error-messages';

@ApiTags('wallets')
@ApiBearerAuth()
@Controller('wallets')
export class WalletsController {
  constructor(
    private readonly walletsService: WalletsService,
    private readonly transactionsService: TransactionsService,
  ) {}

  @UseInterceptors(ClassSerializerInterceptor)
  @Post()
  async create(@Request() req: AuthedRequest, @Body() createWalletDto: CreateWalletDto) {
    return this.walletsService.create(req.user.id, createWalletDto);
  }

  @UseInterceptors(ClassSerializerInterceptor)
  @Put(':walletId')
  async update(
    @Request() req: AuthedRequest,
    @Param('walletId', ParseIntPipe) walletId: number,
    @Body() updateWalletDto: UpdateWalletDto,
  ) {
    const wallet = await this.walletsService.getOne(walletId);
    assertOwnership(wallet, req.user.id, ErrorMessages.FORBIDDEN_WALLET);

    return this.walletsService.update(walletId, updateWalletDto);
  }

  @UseInterceptors(ClassSerializerInterceptor)
  @Get()
  async getAll(
    @Request() req: AuthedRequest,
    @Query('from') from: Date = getStartOfMonth(new Date()),
    @Query('to') to: Date = getEndOfMonth(new Date()),
  ): Promise<{ wallet: Wallet; totalSpend: number; totalIncome: number }[]> {
    const wallets = await this.walletsService.getAll(req.user.id);
    const transactions = await this.transactionsService.getAllForWallets(
      wallets.map((wallet) => wallet.id),
      from,
      to,
    );

    return wallets.map((wallet) => {
      const walletTransactions = transactions.filter((transaction) => transaction.wallet_id === wallet.id);
      const { totalSpend, totalIncome } = walletTransactions.reduce(
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
        wallet,
        totalSpend,
        totalIncome,
      };
    });
  }

  @Delete(':walletId')
  async delete(@Request() req: AuthedRequest, @Param('walletId', ParseIntPipe) walletId: number): Promise<boolean> {
    const wallet = await this.walletsService.getOne(walletId);
    assertOwnership(wallet, req.user.id, ErrorMessages.FORBIDDEN_WALLET);

    await this.walletsService.delete(walletId);

    return true;
  }
}
