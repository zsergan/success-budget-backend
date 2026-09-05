import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';

import { Category } from '@entities/category.entity';
import { Transaction } from '@entities/transaction.entity';
import { Limit } from '@entities/limit.entity';
import { UpdateCategoryDto } from './dto/update-category.dto';
import { CreateCategoryDto } from './dto/create-category.dto';
import { TransactionType } from '@shared/enums';
import { ErrorMessages } from '@shared/error-messages';
import { assertOwnership } from '@shared/utils';

export interface CategoryView {
  id: number;
  name: string;
  transaction_type: TransactionType;
  icon: string;
  color: Category['color'];
  is_active: number;
  transaction_count: number;
  limit: { id: number; name: string | null } | null;
  archived_at: Date | null;
}

@Injectable()
export class CategoriesService {
  constructor(
    @InjectRepository(Category)
    private readonly categoryRepository: Repository<Category>,
    @InjectRepository(Transaction)
    private readonly transactionRepository: Repository<Transaction>,
    @InjectRepository(Limit)
    private readonly limitRepository: Repository<Limit>,
  ) {}

  async getOne(categoryId: number): Promise<Category> {
    return this.categoryRepository.findOne({ where: { id: categoryId } });
  }

  async getAll(
    userId: number,
  ): Promise<{ incomes: CategoryView[]; expenses: CategoryView[]; archived: CategoryView[] }> {
    const categories = await this.categoryRepository
      .createQueryBuilder('category')
      .where('category.user_id = :userId', { userId })
      .orderBy('category.sort', 'ASC')
      .getMany();

    const categoryIds = categories.map((category) => category.id);
    const [counts, limitMembership] = await Promise.all([
      this.getTransactionCounts(categoryIds),
      this.getLimitMembership(userId),
    ]);

    const views = categories.map((category) => this.buildCategoryView(category, counts, limitMembership));

    return {
      incomes: views.filter((view) => view.is_active === 1 && view.transaction_type === TransactionType.INCOME),
      expenses: views.filter((view) => view.is_active === 1 && view.transaction_type === TransactionType.EXPENSE),
      archived: views.filter((view) => view.is_active === 0),
    };
  }

  async initiateCategories(userId: number, categories: CreateCategoryDto[]) {
    const userCategories = categories.map((category) => ({
      ...category,
      user_id: userId,
    }));

    return this.categoryRepository.save(userCategories);
  }

  async update(categoryId: number, updateCategory: UpdateCategoryDto): Promise<Category> {
    const category = await this.getOne(categoryId);
    const activeChanged = updateCategory.is_active !== undefined && updateCategory.is_active !== category.is_active;

    // mutate in place, not a spread copy - a copy loses @Exclude() on serialize
    Object.assign(category, updateCategory);

    if (activeChanged) {
      if (updateCategory.is_active === 0) {
        await this.unlinkFromLimit(categoryId);
        category.archived_at = new Date();
      } else {
        category.archived_at = null;
      }
    }

    return this.categoryRepository.save(category);
  }

  async create(userId: number, category: CreateCategoryDto): Promise<Category> {
    const entity = this.categoryRepository.create({ ...category, user_id: userId });
    return this.categoryRepository.save(entity);
  }

  async deleteOrArchive(categoryId: number): Promise<{ archived: boolean }> {
    const counts = await this.getTransactionCounts([categoryId]);
    const count = counts.get(categoryId) ?? 0;

    if (count === 0) {
      await this.categoryRepository.delete(categoryId);
      return { archived: false };
    }

    await this.unlinkFromLimit(categoryId);
    await this.categoryRepository.update(categoryId, { is_active: 0, archived_at: new Date() });

    return { archived: true };
  }

  async reorder(userId: number, categoryIds: number[]): Promise<void> {
    if (categoryIds.length === 0) {
      return;
    }

    const categories = await this.categoryRepository.find({ where: { id: In(categoryIds) } });

    if (categories.length !== categoryIds.length) {
      throw new HttpException(ErrorMessages.FORBIDDEN_CATEGORY, HttpStatus.FORBIDDEN);
    }

    for (const category of categories) {
      assertOwnership(category, userId, ErrorMessages.FORBIDDEN_CATEGORY);
    }

    const types = new Set(categories.map((category) => category.transaction_type));
    const hasArchived = categories.some((category) => category.is_active === 0);

    if (types.size > 1 || hasArchived) {
      throw new HttpException(ErrorMessages.INVALID_REORDER, HttpStatus.BAD_REQUEST);
    }

    // 100/200 partition income vs expense sort ranges so they never collide
    const prefix = categories[0].transaction_type === TransactionType.INCOME ? 100 : 200;
    const reordered = categoryIds.map((id, index) => ({ id, sort: prefix + index + 1 }));

    await this.categoryRepository.save(reordered);
  }

  private async getTransactionCounts(categoryIds: number[]): Promise<Map<number, number>> {
    if (categoryIds.length === 0) {
      return new Map();
    }

    const rows = await this.transactionRepository
      .createQueryBuilder('transaction')
      .select('transaction.category_id', 'category_id')
      .addSelect('COUNT(*)', 'count')
      .where('transaction.category_id IN (:...categoryIds)', { categoryIds })
      .groupBy('transaction.category_id')
      .getRawMany<{ category_id: number; count: string }>();

    return new Map(rows.map((row) => [Number(row.category_id), Number(row.count)]));
  }

  private async getLimitMembership(userId: number): Promise<Map<number, { id: number; name: string | null }>> {
    const rows = await this.limitRepository
      .createQueryBuilder('limit')
      .innerJoin('limit.categories', 'category')
      .where('limit.user_id = :userId', { userId })
      .select('limit.id', 'limit_id')
      .addSelect('limit.name', 'limit_name')
      .addSelect('category.id', 'category_id')
      .getRawMany<{ limit_id: number; limit_name: string | null; category_id: number }>();

    return new Map(rows.map((row) => [row.category_id, { id: row.limit_id, name: row.limit_name }]));
  }

  private async unlinkFromLimit(categoryId: number): Promise<void> {
    const limit = await this.limitRepository
      .createQueryBuilder('limit')
      .innerJoin('limit.categories', 'category')
      .where('category.id = :categoryId', { categoryId })
      .select('limit.id')
      .getOne();

    if (!limit) {
      return;
    }

    const categoryCount = await this.limitRepository
      .createQueryBuilder('limit')
      .innerJoin('limit.categories', 'category')
      .where('limit.id = :limitId', { limitId: limit.id })
      .getCount();

    await this.limitRepository.createQueryBuilder().relation('categories').of(limit.id).remove([categoryId]);

    // a category-type limit can't have zero categories - delete it with its last one
    if (categoryCount === 1) {
      await this.limitRepository.delete(limit.id);
    }
  }

  private buildCategoryView(
    category: Category,
    counts: Map<number, number>,
    limitMembership: Map<number, { id: number; name: string | null }>,
  ): CategoryView {
    return {
      id: category.id,
      name: category.name,
      transaction_type: category.transaction_type,
      icon: category.icon,
      color: category.color,
      is_active: category.is_active,
      transaction_count: counts.get(category.id) ?? 0,
      limit: limitMembership.get(category.id) ?? null,
      archived_at: category.archived_at,
    };
  }
}
