import {
  Body,
  ClassSerializerInterceptor,
  Controller,
  Delete,
  Get,
  HttpException,
  HttpStatus,
  Param,
  Post,
  Query,
  Request,
  UseInterceptors,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';

import { TransactionsService } from './transactions.service';
import { WalletsService } from '@modules/wallets/wallets.service';
import { CategoriesService } from '@modules/categories/categories.service';
import { CreateTransactionDto } from './dto/create-transaction.dto';
import type { AuthedRequest } from '@shared/types';
import { getEndOfMonth, getStartOfMonth, assertOwnership } from '@shared/utils';
import { ErrorMessages } from '@shared/error-messages';

@ApiTags('transactions')
@ApiBearerAuth()
@Controller('transactions')
export class TransactionsController {
  constructor(
    private readonly transactionsService: TransactionsService,
    private readonly walletsService: WalletsService,
    private readonly categoriesService: CategoriesService,
  ) {}

  @UseInterceptors(ClassSerializerInterceptor)
  @Post()
  async create(@Request() req: AuthedRequest, @Body() createTransactionDto: CreateTransactionDto) {
    const wallet = await this.walletsService.getOne(createTransactionDto.wallet_id);
    assertOwnership(wallet, req.user.id, ErrorMessages.FORBIDDEN_WALLET);

    if (wallet.is_deleted) {
      throw new HttpException(ErrorMessages.FORBIDDEN_WALLET, HttpStatus.FORBIDDEN);
    }

    const category = await this.categoriesService.getOne(createTransactionDto.category_id);
    assertOwnership(category, req.user.id, ErrorMessages.FORBIDDEN_CATEGORY);

    return this.transactionsService.create(wallet.id, wallet.currency_id, createTransactionDto);
  }

  @UseInterceptors(ClassSerializerInterceptor)
  @Get('latest')
  async getLatest(@Request() req: AuthedRequest) {
    const transaction = await this.transactionsService.getLatest(req.user.id);

    if (!transaction) {
      return null;
    }

    if (transaction.wallet.is_deleted) {
      transaction.wallet = null;
    }

    return transaction;
  }

  @UseInterceptors(ClassSerializerInterceptor)
  @Get()
  async getAll(
    @Request() req: AuthedRequest,
    @Query('from') from: Date = getStartOfMonth(new Date()),
    @Query('to') to: Date = getEndOfMonth(new Date()),
  ) {
    const transactions = await this.transactionsService.getForAllWallets(req.user.id, from, to);

    // Mutate the loaded entities in place rather than spreading them into
    // plain objects - a spread copy loses Transaction's @Exclude()
    // metadata (wallet_id/category_id/currency_id would leak), same class-
    // transformer gotcha documented in .private/modernization-plan.md for
    // CategoriesService/LimitsService.
    transactions.forEach((transaction) => {
      if (transaction.wallet.is_deleted) {
        transaction.wallet = null;
      }
    });

    return transactions;
  }

  @Delete(':transactionId')
  async remove(@Request() req: AuthedRequest, @Param('transactionId') transactionId: string): Promise<boolean> {
    const transaction = await this.transactionsService.getOneWithWallet(transactionId);
    assertOwnership(transaction?.wallet, req.user.id, ErrorMessages.FORBIDDEN_WALLET);

    await this.transactionsService.remove(transaction);

    return true;
  }
}
