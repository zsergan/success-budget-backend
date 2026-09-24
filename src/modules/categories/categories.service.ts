import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, In, Repository } from 'typeorm';

import { Category } from '@entities/category.entity';
import { Transaction } from '@entities/transaction.entity';
import { Limit } from '@entities/limit.entity';
import { UpdateCategoryDto } from './dto/update-category.dto';
import { CreateCategoryDto } from './dto/create-category.dto';
import { TransactionType } from '@shared/enums';
import { ErrorMessages } from '@shared/error-messages';
import { assertBelongsToSpace } from '@shared/utils';
import { SpaceAccessService } from '@modules/space-access/space-access.service';

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
    private readonly dataSource: DataSource,
    private readonly spaceAccessService: SpaceAccessService,
  ) {}

  async getOne(categoryId: number, manager?: EntityManager): Promise<Category | null> {
    const repository = manager?.getRepository(Category) ?? this.categoryRepository;

    return repository.findOne({ where: { id: categoryId } });
  }

  async getMany(categoryIds: number[], manager?: EntityManager): Promise<Category[]> {
    // dedup is safe here - this is a read, and the caller's original id
    // list (order, duplicates) is never touched, only what we query with
    const uniqueIds = [...new Set(categoryIds)];

    if (uniqueIds.length === 0) {
      return [];
    }

    const repository = manager?.getRepository(Category) ?? this.categoryRepository;

    return repository.find({ where: { id: In(uniqueIds) } });
  }

  async getAll(
    userId: number,
    spaceId: number,
  ): Promise<{ incomes: CategoryView[]; expenses: CategoryView[]; archived: CategoryView[] }> {
    await this.spaceAccessService.assertMembership(spaceId, userId);

    const categories = await this.categoryRepository
      .createQueryBuilder('category')
      .where('category.space_id = :spaceId', { spaceId })
      .andWhere('category.is_system = 0')
      .orderBy('category.sort', 'ASC')
      .getMany();

    const categoryIds = categories.map((category) => category.id);
    const [counts, limitMembership] = await Promise.all([
      this.getTransactionCounts(categoryIds),
      this.getLimitMembership(spaceId),
    ]);

    const views = categories.map((category) => this.buildCategoryView(category, counts, limitMembership));

    return {
      incomes: views.filter((view) => view.is_active === 1 && view.transaction_type === TransactionType.INCOME),
      expenses: views.filter((view) => view.is_active === 1 && view.transaction_type === TransactionType.EXPENSE),
      archived: views.filter((view) => view.is_active === 0),
    };
  }

  async update(
    userId: number,
    spaceId: number,
    categoryId: number,
    updateCategory: UpdateCategoryDto,
  ): Promise<Category> {
    return this.dataSource.transaction(async (manager) => {
      await this.spaceAccessService.lockSpace(spaceId, manager);
      await this.spaceAccessService.assertMembership(spaceId, userId, undefined, manager);

      const category = await this.getEditableCategory(spaceId, categoryId, manager);
      const activeChanged = updateCategory.is_active !== undefined && updateCategory.is_active !== category.is_active;

      // mutate in place, not a spread copy - a copy loses @Exclude() on serialize
      Object.assign(category, updateCategory);

      if (activeChanged) {
        if (updateCategory.is_active === 0) {
          await this.unlinkFromLimit(categoryId, manager);
          category.archived_at = new Date();
        } else {
          category.archived_at = null;
        }
      }

      return manager.getRepository(Category).save(category);
    });
  }

  async create(userId: number, spaceId: number, category: CreateCategoryDto): Promise<Category> {
    await this.spaceAccessService.assertMembership(spaceId, userId);

    const entity = this.categoryRepository.create({ ...category, space_id: spaceId });
    return this.categoryRepository.save(entity);
  }

  async deleteOrArchive(userId: number, spaceId: number, categoryId: number): Promise<{ archived: boolean }> {
    return this.dataSource.transaction(async (manager) => {
      await this.spaceAccessService.lockSpace(spaceId, manager);
      await this.spaceAccessService.assertMembership(spaceId, userId, undefined, manager);
      await this.getEditableCategory(spaceId, categoryId, manager);

      const counts = await this.getTransactionCounts([categoryId], manager);
      const count = counts.get(categoryId) ?? 0;
      const categoryRepository = manager.getRepository(Category);

      await this.unlinkFromLimit(categoryId, manager);

      if (count === 0) {
        await categoryRepository.delete(categoryId);
        return { archived: false };
      }

      await categoryRepository.update(categoryId, { is_active: 0, archived_at: new Date() });

      return { archived: true };
    });
  }

  async reorder(userId: number, spaceId: number, categoryIds: number[]): Promise<void> {
    await this.spaceAccessService.assertMembership(spaceId, userId);

    if (categoryIds.length === 0) {
      return;
    }

    const categories = await this.categoryRepository.find({ where: { id: In(categoryIds) } });

    if (categories.length !== categoryIds.length) {
      throw new HttpException(ErrorMessages.FORBIDDEN_CATEGORY, HttpStatus.FORBIDDEN);
    }

    for (const category of categories) {
      assertBelongsToSpace(category, spaceId, ErrorMessages.FORBIDDEN_CATEGORY);

      if (category.is_system) {
        throw new HttpException(ErrorMessages.CATEGORY_IS_SYSTEM, HttpStatus.BAD_REQUEST);
      }
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

  private async getEditableCategory(spaceId: number, categoryId: number, manager: EntityManager): Promise<Category> {
    const category = await this.getOne(categoryId, manager);
    assertBelongsToSpace(category, spaceId, ErrorMessages.FORBIDDEN_CATEGORY);

    if (category.is_system) {
      throw new HttpException(ErrorMessages.CATEGORY_IS_SYSTEM, HttpStatus.BAD_REQUEST);
    }

    return category;
  }

  private async getTransactionCounts(categoryIds: number[], manager?: EntityManager): Promise<Map<number, number>> {
    if (categoryIds.length === 0) {
      return new Map();
    }

    const rows = await (manager?.getRepository(Transaction) ?? this.transactionRepository)
      .createQueryBuilder('transaction')
      .select('transaction.category_id', 'category_id')
      .addSelect('COUNT(*)', 'count')
      .where('transaction.category_id IN (:...categoryIds)', { categoryIds })
      .groupBy('transaction.category_id')
      .getRawMany<{ category_id: number; count: string }>();

    return new Map(rows.map((row) => [Number(row.category_id), Number(row.count)]));
  }

  private async getLimitMembership(spaceId: number): Promise<Map<number, { id: number; name: string | null }>> {
    const rows = await this.limitRepository
      .createQueryBuilder('limit')
      .innerJoin('limit.categories', 'category')
      .where('limit.space_id = :spaceId', { spaceId })
      .select('limit.id', 'limit_id')
      .addSelect('limit.name', 'limit_name')
      .addSelect('category.id', 'category_id')
      .getRawMany<{ limit_id: number; limit_name: string | null; category_id: number }>();

    return new Map(rows.map((row) => [row.category_id, { id: row.limit_id, name: row.limit_name }]));
  }

  private async unlinkFromLimit(categoryId: number, manager: EntityManager): Promise<void> {
    const limitRepository = manager.getRepository(Limit);
    const limit = await limitRepository
      .createQueryBuilder('limit')
      .innerJoin('limit.categories', 'category')
      .where('category.id = :categoryId', { categoryId })
      .select('limit.id')
      .getOne();

    if (!limit) {
      return;
    }

    const relation = limitRepository.createQueryBuilder().relation('categories').of(limit.id);
    await relation.remove([categoryId]);

    // a category-type limit can't have zero categories - delete it with its last one
    const remaining = await relation.loadMany<Category>();
    if (remaining.length === 0) {
      await limitRepository.delete(limit.id);
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
