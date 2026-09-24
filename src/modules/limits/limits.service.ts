import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, Repository } from 'typeorm';

import { Limit } from '@entities/limit.entity';
import { CreateLimitDto } from './dto/create-limit.dto';
import { UpdateLimitDto } from './dto/update-limit.dto';
import { LimitType } from '@shared/enums';
import { ErrorMessages } from '@shared/error-messages';
import {
  assertBelongsToSpace,
  assertFound,
  floorPercent,
  getEndOfMonth,
  getStartOfMonth,
  moneyToNumber,
  parseMoney,
  withRelations,
} from '@shared/utils';
import type { WithRelations } from '@shared/types';
import { CategoriesService } from '@modules/categories/categories.service';
import { SpaceAccessService } from '@modules/space-access/space-access.service';
import { TransactionQueriesService } from '@modules/transaction-queries/transaction-queries.service';

export type LimitWithCategories = WithRelations<Limit, 'categories'>;

@Injectable()
export class LimitsService {
  constructor(
    @InjectRepository(Limit)
    private readonly limitRepository: Repository<Limit>,
    private readonly dataSource: DataSource,
    private readonly categoriesService: CategoriesService,
    private readonly spaceAccessService: SpaceAccessService,
    private readonly transactionQueriesService: TransactionQueriesService,
  ) {}

  async getOne(limitId: number, manager?: EntityManager): Promise<LimitWithCategories | null> {
    const repository = manager?.getRepository(Limit) ?? this.limitRepository;
    const limit = await repository.findOne({ where: { id: limitId }, relations: { categories: true } });

    return limit && withRelations(limit, 'categories');
  }

  async getAll(spaceId: number): Promise<LimitWithCategories[]> {
    const limits = await this.limitRepository
      .createQueryBuilder('limit')
      .where('limit.space_id = :spaceId', { spaceId })
      .leftJoinAndSelect('limit.categories', 'categories')
      .getMany();

    return limits.map((limit) => withRelations(limit, 'categories'));
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

  async create(userId: number, spaceId: number, createLimit: CreateLimitDto): Promise<LimitWithCategories> {
    return this.dataSource.transaction(async (manager) => {
      await this.spaceAccessService.lockSpace(spaceId, manager);
      await this.spaceAccessService.assertMembership(spaceId, userId, undefined, manager);
      await this.assertCategoriesOwnership(manager, spaceId, createLimit.category_ids);

      const categoryIds = createLimit.category_ids ?? [];
      this.assertHasNameIfGroup(categoryIds, createLimit.name);

      if (categoryIds.length === 0) {
        await this.assertNoOtherTotalLimit(manager, spaceId);
      } else {
        await this.assertCategoriesAvailable(manager, spaceId, categoryIds);
      }

      const limitRepository = manager.getRepository(Limit);
      const saved = await limitRepository.save(
        limitRepository.create({
          space_id: spaceId,
          amount: createLimit.amount,
          name: categoryIds.length > 1 ? createLimit.name : null,
          limit_type: categoryIds.length === 0 ? LimitType.OTHERS : LimitType.CATEGORY,
        }),
      );

      if (categoryIds.length) {
        await limitRepository.createQueryBuilder().relation('categories').of(saved.id).add(categoryIds);
      }

      return this.getExisting(saved.id, manager);
    });
  }

  async update(
    userId: number,
    spaceId: number,
    limitId: number,
    updateLimit: UpdateLimitDto,
  ): Promise<LimitWithCategories> {
    return this.dataSource.transaction(async (manager) => {
      await this.spaceAccessService.lockSpace(spaceId, manager);
      await this.spaceAccessService.assertMembership(spaceId, userId, undefined, manager);

      const currentLimit = await this.getSpaceLimit(spaceId, limitId, manager);
      await this.assertCategoriesOwnership(manager, spaceId, updateLimit.category_ids);

      const categoryIds = updateLimit.category_ids;
      const currentCategoryIds = currentLimit.categories.map((category) => category.id);
      const resultingCategoryIds = categoryIds ?? currentCategoryIds;
      const resultingName = updateLimit.name !== undefined ? updateLimit.name : currentLimit.name;
      this.assertHasNameIfGroup(resultingCategoryIds, resultingName);

      if (categoryIds !== undefined) {
        if (categoryIds.length === 0) {
          await this.assertNoOtherTotalLimit(manager, spaceId, limitId);
        } else {
          await this.assertCategoriesAvailable(manager, spaceId, categoryIds, limitId);
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

      const limitRepository = manager.getRepository(Limit);
      if (Object.keys(scalarUpdate).length) {
        await limitRepository.update({ id: limitId }, scalarUpdate);
      }

      if (categoryIds !== undefined) {
        const toRemove = currentCategoryIds.filter((id) => !categoryIds.includes(id));
        const toAdd = categoryIds.filter((id) => !currentCategoryIds.includes(id));
        const relation = limitRepository.createQueryBuilder().relation('categories').of(limitId);

        if (toRemove.length) {
          await relation.remove(toRemove);
        }
        if (toAdd.length) {
          await relation.add(toAdd);
        }
      }

      return this.getExisting(limitId, manager);
    });
  }

  async remove(userId: number, spaceId: number, limitId: number): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      await this.spaceAccessService.lockSpace(spaceId, manager);
      await this.spaceAccessService.assertMembership(spaceId, userId, undefined, manager);
      await this.getSpaceLimit(spaceId, limitId, manager);

      // junction rows in limit_categories cascade automatically (onDelete: CASCADE)
      await manager.getRepository(Limit).delete(limitId);
    });
  }

  // categoryTotals are in cents
  calculateSpending(limits: LimitWithCategories[], categoryTotals: Map<number, bigint>) {
    const totalLimit = limits.find((limit) => limit.limit_type === LimitType.OTHERS);
    const categoryLimits = limits.filter((limit) => limit.limit_type === LimitType.CATEGORY);

    // the monthly total tracks ALL expenses independently - one pass over
    // every category's spend, not just the sum of the category limits below it
    let totalSpend = 0n;
    for (const spent of categoryTotals.values()) {
      totalSpend += spent;
    }

    const total = totalLimit ? this.buildLimitView(totalLimit, totalSpend) : null;

    const categories = categoryLimits.map((limit) => {
      const spent = limit.categories.reduce((sum, category) => sum + (categoryTotals.get(category.id) ?? 0n), 0n);

      return this.buildLimitView(limit, spent);
    });

    const categoryTotal = categoryLimits.reduce((sum, limit) => sum + parseMoney(limit.amount), 0n);
    const totalAmount = totalLimit && parseMoney(totalLimit.amount);
    const overAllocation =
      totalAmount !== undefined && categoryTotal > totalAmount
        ? { category_total: moneyToNumber(categoryTotal), difference: moneyToNumber(categoryTotal - totalAmount) }
        : null;

    return { total, categories, over_allocation: overAllocation };
  }

  private buildLimitView(limit: LimitWithCategories, spent: bigint) {
    return {
      id: limit.id,
      name: limit.name,
      amount: limit.amount,
      spent: moneyToNumber(spent),
      in_percent: floorPercent(spent, parseMoney(limit.amount)),
      categories: limit.categories.map((category) => ({
        id: category.id,
        name: category.name,
        icon: category.icon,
        color: category.color,
      })),
    };
  }

  private async getExisting(limitId: number, manager: EntityManager): Promise<LimitWithCategories> {
    const limit = await this.getOne(limitId, manager);
    assertFound(limit);

    return limit;
  }

  private async getSpaceLimit(spaceId: number, limitId: number, manager?: EntityManager): Promise<LimitWithCategories> {
    const limit = await this.getOne(limitId, manager);
    assertBelongsToSpace(limit, spaceId, ErrorMessages.FORBIDDEN_LIMIT);

    return limit;
  }

  private async assertCategoriesOwnership(
    manager: EntityManager,
    spaceId: number,
    categoryIds?: number[],
  ): Promise<void> {
    const ids = categoryIds ?? [];

    if (ids.length === 0) {
      return;
    }

    const categoriesById = new Map(
      (await this.categoriesService.getMany(ids, manager)).map((category) => [category.id, category]),
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
    manager: EntityManager,
    spaceId: number,
    categoryIds: number[],
    excludeLimitId?: number,
  ): Promise<void> {
    const query = manager
      .getRepository(Limit)
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

  private async assertNoOtherTotalLimit(
    manager: EntityManager,
    spaceId: number,
    excludeLimitId?: number,
  ): Promise<void> {
    const query = manager
      .getRepository(Limit)
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
