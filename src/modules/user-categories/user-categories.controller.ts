import { ClassSerializerInterceptor, Controller, Get, Request, UseInterceptors } from '@nestjs/common';

import { UserCategory } from '../../entities/user-category.entity';
import { UserCategoriesService } from './user-categories.service';
import { TransactionType } from '../../shared/enums';
import type { AuthedRequest } from '../../shared/types';

@Controller('user-categories')
export class UserCategoriesController {
  constructor(private readonly userCategoriesService: UserCategoriesService) {}

  @UseInterceptors(ClassSerializerInterceptor)
  @Get()
  async getAll(@Request() req: AuthedRequest) {
    const categories = await this.userCategoriesService.getAll(req.user.id);

    const [incomes, expenses]: [incomes: UserCategory[], expences: UserCategory[]] = categories.reduce(
      (acc, category) => {
        category.transaction_type === TransactionType.INCOME ? acc[0].push(category) : acc[1].push(category);

        return acc;
      },
      [[], []],
    );

    return { incomes, expenses };
  }
}
