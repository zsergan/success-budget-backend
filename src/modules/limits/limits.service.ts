import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { Limit } from '@entities/limit.entity';
import { CreateLimitDto } from './dto/create-limit.dto';
import { UpdateLimitDto } from './dto/update-limit.dto';
import { LimitType } from '@shared/enums';
import { ErrorMessages } from '@shared/error-messages';
import { assertBelongsToSpace, getEndOfMonth, getStartOfMonth } from '@shared/utils';
import { CategoriesService } from '@modules/categories/categories.service';
import { SpaceAccessService } from '@modules/space-access/space-access.service';
import { TransactionQueriesService } from '@modules/transaction-queries/transaction-queries.service';

@Injectable()
export class LimitsService {
  constructor(
    @InjectRepository(Limit)
    private readonly limitRepository: Repository<Limit>,
    private readonly categoriesService: CategoriesService,
    private readonly spaceAccessService: SpaceAccessService,
    private readonly transactionQueriesService: TransactionQueriesService,
  ) {}

  async getOne(limitId: number) {
    return this.limitRepository.findOne({ where: { id: limitId }, relations: { categories: true } });
  }

  async getAll(spaceId: number) {
    return this.limitRepository
      .createQueryBuilder('limit')
      .where('limit.space_id = :spaceId', { spaceId })
      .leftJoinAndSelect('limit.categories', 'categories')
      .getMany();
  }

  async getSummary(userId: number, spaceId: number) {
    await this.spaceAccessService.assertMembership(spaceId, userId);

    const limits = await this.getAll(spaceId);
    const categoryTotals = await this.transactionQueriesService.getExpensesByCategory(
      spaceId,
      getStartOfMonth(new Date()),
      getEndOfMonth(new Date()),
    );

    return this.calculateSpending(limits, categoryTotals);
  }

  async create(userId: number, spaceId: number, createLimit: CreateLimitDto) {
    await this.spaceAccessService.assertMembership(spaceId, userId);
    await this.assertCategoriesOwnership(spaceId, createLimit.category_ids);

    const categoryIds = createLimit.category_ids ?? [];
    this.assertHasNameIfGroup(categoryIds, createLimit.name);

    if (categoryIds.length === 0) {
      await this.assertNoOtherTotalLimit(spaceId);
    } else {
      await this.assertCategoriesAvailable(spaceId, categoryIds);
    }

    const limit = this.limitRepository.create({
      space_id: spaceId,
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

  async update(userId: number, spaceId: number, limitId: number, updateLimit: UpdateLimitDto) {
    await this.spaceAccessService.assertMembership(spaceId, userId);

    const currentLimit = await this.getSpaceLimit(spaceId, limitId);
    await this.assertCategoriesOwnership(spaceId, updateLimit.category_ids);

    const categoryIds = updateLimit.category_ids;
    const currentCategoryIds = currentLimit.categories.map((category) => category.id);
    const resultingCategoryIds = categoryIds ?? currentCategoryIds;
    const resultingName = updateLimit.name !== undefined ? updateLimit.name : currentLimit.name;
    this.assertHasNameIfGroup(resultingCategoryIds, resultingName);

    if (categoryIds !== undefined) {
      if (categoryIds.length === 0) {
        await this.assertNoOtherTotalLimit(spaceId, limitId);
      } else {
        await this.assertCategoriesAvailable(spaceId, categoryIds, limitId);
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

    return this.getOne(limitId);
  }

  async remove(userId: number, spaceId: number, limitId: number): Promise<void> {
    await this.spaceAccessService.assertMembership(spaceId, userId);
    await this.getSpaceLimit(spaceId, limitId);

    // junction rows in limit_categories cascade automatically (onDelete: CASCADE)
    await this.limitRepository.delete(limitId);
  }

  calculateSpending(limits: Limit[], categoryTotals: Map<number, number>) {
    const totalLimit = limits.find((limit) => limit.limit_type === LimitType.OTHERS);
    const categoryLimits = limits.filter((limit) => limit.limit_type === LimitType.CATEGORY);

    // the monthly total tracks ALL expenses independently - one pass over
    // every category's spend, not just the sum of the category limits below it
    let totalSpend = 0;
    for (const spent of categoryTotals.values()) {
      totalSpend += spent;
    }

    const total = totalLimit ? this.buildLimitView(totalLimit, totalSpend) : null;

    const categories = categoryLimits.map((limit) => {
      const spent = limit.categories.reduce((sum, category) => sum + (categoryTotals.get(category.id) ?? 0), 0);

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

  private async getSpaceLimit(spaceId: number, limitId: number): Promise<Limit> {
    const limit = await this.getOne(limitId);
    assertBelongsToSpace(limit, spaceId, ErrorMessages.FORBIDDEN_LIMIT);

    return limit;
  }

  private async assertCategoriesOwnership(spaceId: number, categoryIds?: number[]): Promise<void> {
    const ids = categoryIds ?? [];

    if (ids.length === 0) {
      return;
    }

    const categoriesById = new Map(
      (await this.categoriesService.getMany(ids)).map((category) => [category.id, category]),
    );

    for (const categoryId of ids) {
      const category = categoriesById.get(categoryId);
      assertBelongsToSpace(category, spaceId, ErrorMessages.FORBIDDEN_CATEGORY);

      if (category.is_system) {
        throw new HttpException(ErrorMessages.CATEGORY_IS_SYSTEM, HttpStatus.BAD_REQUEST);
      }
    }
  }

  private assertHasNameIfGroup(categoryIds: number[], name?: string | null): void {
    if (categoryIds.length > 1 && !name) {
      throw new HttpException(ErrorMessages.LIMIT_NAME_REQUIRED, HttpStatus.BAD_REQUEST);
    }
  }

  private async assertCategoriesAvailable(
    spaceId: number,
    categoryIds: number[],
    excludeLimitId?: number,
  ): Promise<void> {
    const query = this.limitRepository
      .createQueryBuilder('limit')
      .innerJoin('limit.categories', 'category')
      .where('limit.space_id = :spaceId', { spaceId })
      .andWhere('category.id IN (:...categoryIds)', { categoryIds });

    if (excludeLimitId) {
      query.andWhere('limit.id != :excludeLimitId', { excludeLimitId });
    }

    const conflicting = await query.getCount();

    if (conflicting > 0) {
      throw new HttpException(ErrorMessages.LIMIT_EXISTS, HttpStatus.BAD_REQUEST);
    }
  }

  private async assertNoOtherTotalLimit(spaceId: number, excludeLimitId?: number): Promise<void> {
    const query = this.limitRepository
      .createQueryBuilder('limit')
      .where('limit.space_id = :spaceId', { spaceId })
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
