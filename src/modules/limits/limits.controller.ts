import {
  Body,
  ClassSerializerInterceptor,
  Controller,
  Get,
  HttpException,
  HttpStatus,
  Param,
  ParseIntPipe,
  Post,
  Put,
  Request,
  UseInterceptors,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';

import { Limit } from '../../entities/limit.entity';
import { Transaction } from '../../entities/transaction.entity';
import type { AuthedRequest } from '../../shared/types';
import { LimitsService } from './limits.service';
import { TransactionsService } from '../transactions/transactions.service';
import { CreateLimitDto } from './dto/create-limit.dto';
import { UpdateLimitDto } from './dto/update-limit.dto';
import { getEndOfMonth, getStartOfMonth } from '../../shared/utils';
import { ErrorMessages } from '../../shared/error-messages';
import { TransactionType } from '../../shared/enums';

@ApiTags('limits')
@ApiBearerAuth()
@Controller('limits')
export class LimitsController {
  constructor(
    private readonly limitsService: LimitsService,
    private readonly transactionsService: TransactionsService,
  ) {}

  private filterTransactionsForAllOtherLimits(transactions: Transaction[], specificLimitsCategoriesIds: number[]) {
    return transactions.filter(
      (transaction) =>
        !specificLimitsCategoriesIds.includes(transaction.category_id) &&
        transaction.transaction_type === TransactionType.EXPENSE,
    );
  }

  private filterTransactionsForSpecificLimit(transactions: Transaction[], limitCategoryId: number) {
    return transactions.filter(
      (transaction) =>
        transaction.category_id === limitCategoryId && transaction.transaction_type === TransactionType.EXPENSE,
    );
  }

  private countLimits(limits: Limit[], transactions: Transaction[]) {
    const specificLimitsCategoriesIds = limits.map((limit) => limit.category_id).filter((id) => id);

    const countedLimits = limits.map((limit) => {
      const transactionsForLimit =
        limit.category_id === null
          ? this.filterTransactionsForAllOtherLimits(transactions, specificLimitsCategoriesIds)
          : this.filterTransactionsForSpecificLimit(transactions, limit.category_id);
      const spent = transactionsForLimit.reduce((acc, transaction) => Number(acc) + Number(transaction.amount), 0);
      const in_percent = Number(limit.amount) > 0 ? Math.floor((spent / Number(limit.amount)) * 100) : 0;

      return {
        ...limit,
        spent,
        in_percent,
      };
    });

    const overall = countedLimits.reduce(
      (acc, limit) => {
        acc.spent += Number(limit.spent);
        acc.sum += Number(limit.amount);

        return acc;
      },
      { spent: 0, sum: 0 },
    );

    const overallInPercent = overall.sum > 0 ? Math.floor((overall.spent / overall.sum) * 100) : 0;

    return {
      limits: countedLimits,
      overall: { ...overall, in_percent: overallInPercent },
    };
  }

  private validatePermission(limit: Limit, userId: number) {
    if (limit.user_id !== userId) {
      throw new HttpException(ErrorMessages.FORBIDDEN_CATEGORY, HttpStatus.FORBIDDEN);
    }
  }

  private async validateLimit(categoryId: number, userId: number) {
    const limits = await this.limitsService.getAll(userId);
    const limitsCategoriesIds = limits.map((limit) => limit.category_id);

    if (categoryId && limitsCategoriesIds.includes(categoryId)) {
      throw new HttpException(ErrorMessages.LIMIT_EXISTS, HttpStatus.BAD_REQUEST);
    }

    if (!categoryId && limitsCategoriesIds.includes(null)) {
      throw new HttpException(ErrorMessages.LIMIT_EXISTS, HttpStatus.BAD_REQUEST);
    }
  }

  @UseInterceptors(ClassSerializerInterceptor)
  @Get()
  async getAll(@Request() req: AuthedRequest) {
    const limits = await this.limitsService.getAll(req.user.id);
    const transactions = await this.transactionsService.getForAllWallets(
      req.user.id,
      getStartOfMonth(new Date()),
      getEndOfMonth(new Date()),
    );

    return this.countLimits(limits, transactions);
  }

  @UseInterceptors(ClassSerializerInterceptor)
  @Post()
  async create(@Request() req: AuthedRequest, @Body() createLimitDto: CreateLimitDto) {
    await this.validateLimit(createLimitDto.category_id, req.user.id);

    return this.limitsService.create(req.user.id, createLimitDto);
  }

  @UseInterceptors(ClassSerializerInterceptor)
  @Put(':limitId')
  async update(
    @Request() req: AuthedRequest,
    @Param('limitId', ParseIntPipe) limitId: number,
    @Body() updateLimitDto: UpdateLimitDto,
  ) {
    const limit = await this.limitsService.getOne(limitId);
    this.validatePermission(limit, req.user.id);

    if (limit.category_id !== updateLimitDto.category_id) {
      await this.validateLimit(updateLimitDto.category_id, req.user.id);
    }

    return this.limitsService.update(limitId, updateLimitDto);
  }
}
