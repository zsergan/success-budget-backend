import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { Limit } from '@entities/limit.entity';
import { Transaction } from '@entities/transaction.entity';
import { CreateLimitDto } from './dto/create-limit.dto';
import { UpdateLimitDto } from './dto/update-limit.dto';
import { LimitType, TransactionType } from '@shared/enums';
import { ErrorMessages } from '@shared/error-messages';

@Injectable()
export class LimitsService {
  constructor(
    @InjectRepository(Limit)
    private readonly limitRepository: Repository<Limit>,
  ) {}

  async getOne(limitId: number) {
    return this.limitRepository.findOne({ where: { id: limitId } });
  }

  async getAll(userId: number) {
    return this.limitRepository
      .createQueryBuilder('limit')
      .where('limit.user_id = :userId', { userId })
      .leftJoinAndSelect('limit.category', 'category')
      .getMany();
  }

  async create(userId: number, createLimit: CreateLimitDto) {
    await this.assertNoDuplicate(userId, createLimit.category_id);

    const limit = this.limitRepository.create({
      ...createLimit,
      user_id: userId,
      limit_type: createLimit.category_id ? LimitType.CATEGORY : LimitType.OTHERS,
    });

    return await this.limitRepository.save(limit);
  }

  async update(limitId: number, userId: number, currentCategoryId: number | null, updateLimit: UpdateLimitDto) {
    if ((currentCategoryId ?? null) !== (updateLimit.category_id ?? null)) {
      await this.assertNoDuplicate(userId, updateLimit.category_id);
    }

    await this.limitRepository.update(
      { id: limitId },
      {
        ...updateLimit,
        category_id: updateLimit.category_id ? updateLimit.category_id : null,
        limit_type: updateLimit.category_id ? LimitType.CATEGORY : LimitType.OTHERS,
      },
    );
  }

  calculateSpending(limits: Limit[], transactions: Transaction[]) {
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

  private async assertNoDuplicate(userId: number, categoryId?: number): Promise<void> {
    const limits = await this.getAll(userId);
    const limitsCategoriesIds = limits.map((limit) => limit.category_id);

    if (categoryId && limitsCategoriesIds.includes(categoryId)) {
      throw new HttpException(ErrorMessages.LIMIT_EXISTS, HttpStatus.BAD_REQUEST);
    }

    if (!categoryId && limitsCategoriesIds.includes(null)) {
      throw new HttpException(ErrorMessages.LIMIT_EXISTS, HttpStatus.BAD_REQUEST);
    }
  }
}
