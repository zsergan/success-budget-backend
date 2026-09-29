import {
  Body,
  ClassSerializerInterceptor,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Query,
  Request,
  UseInterceptors,
} from '@nestjs/common';
import { ApiBearerAuth, ApiQuery, ApiTags } from '@nestjs/swagger';

import { TransactionsService } from './transactions.service';
import { CreateTransactionDto } from './dto/create-transaction.dto';
import type { AuthedRequest } from '@shared/types';
import { TransactionType } from '@shared/enums';
import { getEndOfMonth, getStartOfMonth } from '@shared/utils';
import { ParseOptionalDatePipe } from '@shared/pipes/parse-optional-date.pipe';
import { ParseOptionalEnumPipe } from '@shared/pipes/parse-optional-enum.pipe';
import { ParseOptionalIdPipe } from '@shared/pipes/parse-optional-id.pipe';

@ApiTags('transactions')
@ApiBearerAuth()
@Controller('spaces/:spaceId/transactions')
export class TransactionsController {
  constructor(private readonly transactionsService: TransactionsService) {}

  @UseInterceptors(ClassSerializerInterceptor)
  @Post()
  async create(
    @Request() req: AuthedRequest,
    @Param('spaceId', ParseIntPipe) spaceId: number,
    @Body() createTransactionDto: CreateTransactionDto,
  ) {
    return this.transactionsService.create(req.user.id, spaceId, createTransactionDto);
  }

  @UseInterceptors(ClassSerializerInterceptor)
  @Get('latest')
  async getLatest(@Request() req: AuthedRequest, @Param('spaceId', ParseIntPipe) spaceId: number) {
    return this.transactionsService.getLatest(req.user.id, spaceId);
  }

  @ApiQuery({
    name: 'from',
    required: false,
    description: 'Inclusive; without Z/offset it is server local time. Default: start of the current month.',
  })
  @ApiQuery({ name: 'to', required: false, description: 'Inclusive, to the millisecond. Default: end of the month.' })
  @ApiQuery({ name: 'transaction_type', required: false, enum: TransactionType })
  @ApiQuery({
    name: 'category_id',
    required: false,
    type: Number,
    description: 'A category of the space, archived allowed; the system one is refused.',
  })
  @ApiQuery({ name: 'wallet_id', required: false, type: Number, description: 'An active wallet of the space.' })
  @UseInterceptors(ClassSerializerInterceptor)
  @Get()
  async getAll(
    @Request() req: AuthedRequest,
    @Param('spaceId', ParseIntPipe) spaceId: number,
    @Query('from', ParseOptionalDatePipe) from: Date = getStartOfMonth(new Date()),
    @Query('to', ParseOptionalDatePipe) to: Date = getEndOfMonth(new Date()),
    @Query('transaction_type', new ParseOptionalEnumPipe(TransactionType)) transactionType?: TransactionType,
    @Query('category_id', ParseOptionalIdPipe) categoryId?: number,
    @Query('wallet_id', ParseOptionalIdPipe) walletId?: number,
  ) {
    return this.transactionsService.getAll(req.user.id, spaceId, from, to, { transactionType, categoryId, walletId });
  }

  @Delete(':transactionId')
  async remove(
    @Request() req: AuthedRequest,
    @Param('spaceId', ParseIntPipe) spaceId: number,
    @Param('transactionId') transactionId: string,
  ): Promise<boolean> {
    await this.transactionsService.remove(req.user.id, spaceId, transactionId);

    return true;
  }
}
