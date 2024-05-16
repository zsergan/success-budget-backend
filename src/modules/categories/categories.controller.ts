import { Controller, Get } from '@nestjs/common';

import type { Category } from '../../entities/category.entity';
import { CategoriesService } from './categories.service';
import { TransactionType } from '../../shared/enums';

@Controller('categories')
export class CategoriesController {
  constructor(private readonly categoriesService: CategoriesService) {}

  @Get()
  async getAll() {
    const categories = await this.categoriesService.getAll();
    const [incomes, expenses]: [incomes: Category[], expences: Category[]] = categories.reduce(
      (acc, category) => {
        category.transaction_type === TransactionType.INCOME ? acc[0].push(category) : acc[1].push(category);

        return acc;
      },
      [[], []],
    );

    return { incomes, expenses };
  }
}
