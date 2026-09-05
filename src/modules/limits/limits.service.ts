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
    return this.limitRepository.findOne({ where: { id: limitId }, relations: { categories: true } });
  }

  async getAll(userId: number) {
    return this.limitRepository
      .createQueryBuilder('limit')
      .where('limit.user_id = :userId', { userId })
      .leftJoinAndSelect('limit.categories', 'categories')
      .getMany();
  }

  async create(userId: number, createLimit: CreateLimitDto) {
    const categoryIds = createLimit.category_ids ?? [];
    this.assertHasNameIfGroup(categoryIds, createLimit.name);

    if (categoryIds.length === 0) {
      await this.assertNoOtherTotalLimit(userId);
    } else {
      await this.assertCategoriesAvailable(userId, categoryIds);
    }

    const limit = this.limitRepository.create({
      user_id: userId,
      amount: createLimit.amount,
      name: categoryIds.length > 1 ? createLimit.name : null,
      limit_type: categoryIds.length === 0 ? LimitType.OTHERS : LimitType.CATEGORY,
    });
    const saved = await this.limitRepository.save(limit);

    if (categoryIds.length) {
      await this.limitRepository.createQueryBuilder().relation('categories').of(saved.id).add(categoryIds);
    }

    return this.getOne(saved.id);
  }

  async update(limitId: number, userId: number, currentLimit: Limit, updateLimit: UpdateLimitDto): Promise<void> {
    const categoryIds = updateLimit.category_ids;
    const currentCategoryIds = currentLimit.categories.map((category) => category.id);
    const resultingCategoryIds = categoryIds ?? currentCategoryIds;
    const resultingName = updateLimit.name !== undefined ? updateLimit.name : currentLimit.name;
    this.assertHasNameIfGroup(resultingCategoryIds, resultingName);

    if (categoryIds !== undefined) {
      if (categoryIds.length === 0) {
        await this.assertNoOtherTotalLimit(userId, limitId);
      } else {
        await this.assertCategoriesAvailable(userId, categoryIds, limitId);
      }
    }

    const scalarUpdate: Partial<Limit> = {};
    if (updateLimit.amount !== undefined) {
      scalarUpdate.amount = updateLimit.amount;
    }
    if (categoryIds !== undefined) {
      scalarUpdate.limit_type = resultingCategoryIds.length === 0 ? LimitType.OTHERS : LimitType.CATEGORY;
      scalarUpdate.name = resultingCategoryIds.length > 1 ? resultingName : null;
    } else if (updateLimit.name !== undefined) {
      scalarUpdate.name = resultingCategoryIds.length > 1 ? resultingName : null;
    }
    if (Object.keys(scalarUpdate).length) {
      await this.limitRepository.update({ id: limitId }, scalarUpdate);
    }

    if (categoryIds !== undefined) {
      const toRemove = currentCategoryIds.filter((id) => !categoryIds.includes(id));
      const toAdd = categoryIds.filter((id) => !currentCategoryIds.includes(id));
      const relation = this.limitRepository.createQueryBuilder().relation('categories').of(limitId);

      if (toRemove.length) {
        await relation.remove(toRemove);
      }
      if (toAdd.length) {
        await relation.add(toAdd);
      }
    }
  }

  async remove(limitId: number): Promise<void> {
    // junction rows in limit_categories cascade automatically (onDelete: CASCADE)
    await this.limitRepository.delete(limitId);
  }

  calculateSpending(limits: Limit[], transactions: Transaction[]) {
    const expenseTransactions = transactions.filter(
      (transaction) => transaction.transaction_type === TransactionType.EXPENSE,
    );

    const totalLimit = limits.find((limit) => limit.limit_type === LimitType.OTHERS);
    const categoryLimits = limits.filter((limit) => limit.limit_type === LimitType.CATEGORY);

    // the monthly total tracks ALL expenses independently - it is not a sum
    // of the category limits below it, and the two are allowed to disagree
    const total = totalLimit
      ? this.buildLimitView(
          totalLimit,
          expenseTransactions.reduce((sum, transaction) => sum + Number(transaction.amount), 0),
        )
      : null;

    const categories = categoryLimits.map((limit) => {
      const categoryIds = limit.categories.map((category) => category.id);
      const spent = expenseTransactions
        .filter((transaction) => categoryIds.includes(transaction.category_id))
        .reduce((sum, transaction) => sum + Number(transaction.amount), 0);

      return this.buildLimitView(limit, spent);
    });

    const categoryTotal = categoryLimits.reduce((sum, limit) => sum + Number(limit.amount), 0);
    const overAllocation =
      totalLimit && categoryTotal > Number(totalLimit.amount)
        ? { category_total: categoryTotal, difference: categoryTotal - Number(totalLimit.amount) }
        : null;

    return { total, categories, over_allocation: overAllocation };
  }

  private buildLimitView(limit: Limit, spent: number) {
    const amount = Number(limit.amount);
    const in_percent = amount > 0 ? Math.floor((spent / amount) * 100) : 0;

    return {
      id: limit.id,
      name: limit.name,
      amount: limit.amount,
      spent,
      in_percent,
      categories: limit.categories.map((category) => ({
        id: category.id,
        name: category.name,
        icon: category.icon,
        color: category.color,
      })),
    };
  }

  private assertHasNameIfGroup(categoryIds: number[], name?: string | null): void {
    if (categoryIds.length > 1 && !name) {
      throw new HttpException(ErrorMessages.LIMIT_NAME_REQUIRED, HttpStatus.BAD_REQUEST);
    }
  }

  private async assertCategoriesAvailable(
    userId: number,
    categoryIds: number[],
    excludeLimitId?: number,
  ): Promise<void> {
    const query = this.limitRepository
      .createQueryBuilder('limit')
      .innerJoin('limit.categories', 'category')
      .where('limit.user_id = :userId', { userId })
      .andWhere('category.id IN (:...categoryIds)', { categoryIds });

    if (excludeLimitId) {
      query.andWhere('limit.id != :excludeLimitId', { excludeLimitId });
    }

    const conflicting = await query.getCount();

    if (conflicting > 0) {
      throw new HttpException(ErrorMessages.LIMIT_EXISTS, HttpStatus.BAD_REQUEST);
    }
  }

  private async assertNoOtherTotalLimit(userId: number, excludeLimitId?: number): Promise<void> {
    const query = this.limitRepository
      .createQueryBuilder('limit')
      .where('limit.user_id = :userId', { userId })
      .andWhere('limit.limit_type = :limitType', { limitType: LimitType.OTHERS });

    if (excludeLimitId) {
      query.andWhere('limit.id != :excludeLimitId', { excludeLimitId });
    }

    const existing = await query.getCount();

    if (existing > 0) {
      throw new HttpException(ErrorMessages.LIMIT_EXISTS, HttpStatus.BAD_REQUEST);
    }
  }
}
