import {
  Body,
  ClassSerializerInterceptor,
  Controller,
  Delete,
  Get,
  HttpException,
  HttpStatus,
  Param,
  ParseIntPipe,
  Post,
  Query,
  Request,
  UseInterceptors,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';

import { TransactionsService } from './transactions.service';
import { TransactionQueriesService } from '@modules/transaction-queries/transaction-queries.service';
import { WalletsService } from '@modules/wallets/wallets.service';
import { CategoriesService } from '@modules/categories/categories.service';
import { SpaceAccessService } from '@modules/space-access/space-access.service';
import { CreateTransactionDto } from './dto/create-transaction.dto';
import type { AuthedRequest } from '@shared/types';
import { getEndOfMonth, getStartOfMonth, assertBelongsToSpace } from '@shared/utils';
import { ErrorMessages } from '@shared/error-messages';

@ApiTags('transactions')
@ApiBearerAuth()
@Controller('spaces/:spaceId/transactions')
export class TransactionsController {
  constructor(
    private readonly transactionsService: TransactionsService,
    private readonly transactionQueriesService: TransactionQueriesService,
    private readonly walletsService: WalletsService,
    private readonly categoriesService: CategoriesService,
    private readonly spaceAccessService: SpaceAccessService,
  ) {}

  @UseInterceptors(ClassSerializerInterceptor)
  @Post()
  async create(
    @Request() req: AuthedRequest,
    @Param('spaceId', ParseIntPipe) spaceId: number,
    @Body() createTransactionDto: CreateTransactionDto,
  ) {
    await this.spaceAccessService.assertMembership(spaceId, req.user.id);

    const wallet = await this.walletsService.getOne(createTransactionDto.wallet_id);
    assertBelongsToSpace(wallet, spaceId, ErrorMessages.FORBIDDEN_WALLET);

    if (wallet.is_deleted) {
      throw new HttpException(ErrorMessages.FORBIDDEN_WALLET, HttpStatus.FORBIDDEN);
    }

    const category = await this.categoriesService.getOne(createTransactionDto.category_id);
    assertBelongsToSpace(category, spaceId, ErrorMessages.FORBIDDEN_CATEGORY);

    if (category.is_system) {
      throw new HttpException(ErrorMessages.FORBIDDEN_CATEGORY, HttpStatus.FORBIDDEN);
    }

    return this.transactionsService.create(wallet, createTransactionDto);
  }

  @UseInterceptors(ClassSerializerInterceptor)
  @Get('latest')
  async getLatest(@Request() req: AuthedRequest, @Param('spaceId', ParseIntPipe) spaceId: number) {
    await this.spaceAccessService.assertMembership(spaceId, req.user.id);

    const transaction = await this.transactionQueriesService.getLatest(spaceId);

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
    @Param('spaceId', ParseIntPipe) spaceId: number,
    @Query('from') from: Date = getStartOfMonth(new Date()),
    @Query('to') to: Date = getEndOfMonth(new Date()),
  ) {
    await this.spaceAccessService.assertMembership(spaceId, req.user.id);

    const transactions = await this.transactionQueriesService.getForAllWallets(spaceId, from, to);

    transactions.forEach((transaction) => {
      if (transaction.wallet.is_deleted) {
        transaction.wallet = null;
      }
    });

    return transactions;
  }

  @Delete(':transactionId')
  async remove(
    @Request() req: AuthedRequest,
    @Param('spaceId', ParseIntPipe) spaceId: number,
    @Param('transactionId') transactionId: string,
  ): Promise<boolean> {
    await this.spaceAccessService.assertMembership(spaceId, req.user.id);

    const transaction = await this.transactionQueriesService.getOneWithWallet(transactionId);
    assertBelongsToSpace(transaction?.wallet, spaceId, ErrorMessages.FORBIDDEN_WALLET);

    await this.transactionsService.remove(transaction);

    return true;
  }
}
