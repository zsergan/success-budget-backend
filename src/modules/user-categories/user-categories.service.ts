import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { UserCategory } from '../../entities/user-category.entity';
import { Category } from '../../entities/category.entity';

@Injectable()
export class UserCategoriesService {
  constructor(
    @InjectRepository(UserCategory)
    private readonly userCategoryRepository: Repository<UserCategory>,
  ) {}

  async getAll(userId: number): Promise<UserCategory[]> {
    return this.userCategoryRepository.find({ where: { is_active: 1, user_id: userId } });
  }

  async initiateUserCategories(userId: number, categories: Category[]) {
    const userCategories = categories.map((category) => ({
      ...category,
      user_id: userId,
    }));

    return this.userCategoryRepository.save(userCategories);
  }
}
