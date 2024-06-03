import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { Category } from '../../entities/category.entity';
import { UpdateCategoryDto } from './dto/update-category.dto';
import { CreateCategoryDto } from './dto/create-category.dto';

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
    return this.categoryRepository.find({ where: { user_id: userId } });
  }

  async getAllActive(userId: number): Promise<Category[]> {
    return this.categoryRepository.find({ where: { is_active: 1, user_id: userId } });
  }

  async initiateCategories(userId: number, categories: CreateCategoryDto[]) {
    const userCategories = categories.map((category) => ({
      ...category,
      user_id: userId,
    }));

    return this.categoryRepository.save(userCategories);
  }

  async update(categoryId: number, category: UpdateCategoryDto): Promise<void> {
    await this.categoryRepository.update({ id: categoryId }, category);
  }

  async create(userId: number, category: CreateCategoryDto): Promise<Category> {
    return this.categoryRepository.save({ ...category, user_id: userId });
  }
}
