import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { Category } from '../../entities/category.entity';
import { UpdateCategoryDto } from './dto/update-category.dto';
import { CreateCategoryDto } from './dto/create-category.dto';
import { TransactionType } from '../../shared/enums';

@Injectable()
export class CategoriesService {
  constructor(
    @InjectRepository(Category)
    private readonly categoryRepository: Repository<Category>,
  ) {}

  async getOne(categoryId: number): Promise<Category> {
    return this.categoryRepository.findOne({ where: { id: categoryId } });
  }

  async getAll(userId: number): Promise<Category[]> {
    return this.categoryRepository
      .createQueryBuilder('category')
      .where('category.user_id = :userId', { userId })
      .orderBy('category.sort', 'ASC')
      .getMany();
  }

  async initiateCategories(userId: number, categories: CreateCategoryDto[]) {
    const userCategories = categories.map((category) => ({
      ...category,
      user_id: userId,
    }));

    return this.categoryRepository.save(userCategories);
  }

  async update(categoryId: number, updateCategory: UpdateCategoryDto) {
    const category = await this.getOne(categoryId);
    return await this.categoryRepository.save({ ...category, ...updateCategory });
  }

  async create(userId: number, category: CreateCategoryDto): Promise<Category> {
    return this.categoryRepository.save({ ...category, user_id: userId });
  }

  async save(categories: Category[]): Promise<Category | Category[]> {
    return this.categoryRepository.save(categories);
  }

  separateCategories(categories: Category[]): [incomes: Category[], expenses: Category[]] {
    return categories.reduce(
      (acc, category) => {
        if (category.transaction_type === TransactionType.INCOME) {
          acc[0].push(category);
        } else {
          acc[1].push(category);
        }

        return acc;
      },
      [[], []] as [Category[], Category[]],
    );
  }

  async moveToFront(userId: number, category: Category): Promise<void> {
    const categories = await this.getAll(userId);
    const [incomes, expenses] = this.separateCategories(categories);

    const movedCategories =
      category.transaction_type === TransactionType.INCOME
        ? this.sortCategories(incomes, category.id, 100)
        : this.sortCategories(expenses, category.id, 200);

    await this.save(movedCategories);
  }

  private sortCategories(categories: Category[], movedCategoryId: number, prefix: number) {
    const movedCategory = categories.find((category) => category.id === movedCategoryId);
    const otherCategories = categories.filter((category) => category.id !== movedCategoryId);
    const otherCategoriesWithNewSort = otherCategories.map((category, index) => ({
      ...category,
      sort: prefix + index + 1,
    }));

    return [{ ...movedCategory, sort: prefix }, ...otherCategoriesWithNewSort];
  }
}
