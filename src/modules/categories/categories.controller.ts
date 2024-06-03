import {
  Body,
  ClassSerializerInterceptor,
  Controller,
  Get,
  HttpException,
  HttpStatus,
  Param,
  ParseIntPipe,
  Post,
  Put,
  Request,
  UseInterceptors,
} from '@nestjs/common';

import { Category } from '../../entities/category.entity';
import { CategoriesService } from './categories.service';
import { TransactionType } from '../../shared/enums';
import type { AuthedRequest } from '../../shared/types';
import { UpdateCategoryDto } from './dto/update-category.dto';
import { ErrorMessages } from '../../shared/error-messages';
import { CreateCategoryDto } from './dto/create-category.dto';

@Controller('categories')
export class CategoriesController {
  constructor(private readonly categoriesService: CategoriesService) {}

  private sortCategories(categories: Category[]): [incomes: Category[], expences: Category[]] {
    return categories.reduce(
      (acc, category) => {
        category.transaction_type === TransactionType.INCOME ? acc[0].push(category) : acc[1].push(category);

        return acc;
      },
      [[], []],
    );
  }

  @UseInterceptors(ClassSerializerInterceptor)
  @Get()
  async getAll(@Request() req: AuthedRequest) {
    const categories = await this.categoriesService.getAll(req.user.id);

    const [incomes, expenses] = this.sortCategories(categories);

    return { incomes, expenses };
  }

  @UseInterceptors(ClassSerializerInterceptor)
  @Get('active')
  async getAllActive(@Request() req: AuthedRequest) {
    const categories = await this.categoriesService.getAllActive(req.user.id);

    const [incomes, expenses] = this.sortCategories(categories);

    return { incomes, expenses };
  }

  @UseInterceptors(ClassSerializerInterceptor)
  @Put(':categoryId')
  async update(
    @Request() req: AuthedRequest,
    @Param('categoryId', ParseIntPipe) categoryId: number,
    @Body() updateCategory: UpdateCategoryDto,
  ) {
    const category = await this.categoriesService.getOne(categoryId);

    if (category.user_id !== req.user.id) {
      throw new HttpException(ErrorMessages.FORBIDDEN_CATEGORY, HttpStatus.FORBIDDEN);
    }

    return this.categoriesService.update(categoryId, updateCategory);
  }

  @UseInterceptors(ClassSerializerInterceptor)
  @Post()
  async create(@Request() req: AuthedRequest, @Body() createCategory: CreateCategoryDto) {
    return this.categoriesService.create(req.user.id, createCategory);
  }
}
