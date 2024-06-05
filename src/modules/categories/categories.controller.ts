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

  private separateCategories(categories: Category[]): [incomes: Category[], expences: Category[]] {
    return categories.reduce(
      (acc, category) => {
        category.transaction_type === TransactionType.INCOME ? acc[0].push(category) : acc[1].push(category);

        return acc;
      },
      [[], []],
    );
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

  @UseInterceptors(ClassSerializerInterceptor)
  @Get()
  async getAll(@Request() req: AuthedRequest) {
    const categories = await this.categoriesService.getAll(req.user.id);

    const [incomes, expenses] = this.separateCategories(categories);

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

  @UseInterceptors(ClassSerializerInterceptor)
  @Put('move-forward/:categoryId')
  async moveForward(@Request() req: AuthedRequest, @Param('categoryId', ParseIntPipe) categoryId: number) {
    const category = await this.categoriesService.getOne(categoryId);

    if (category.user_id !== req.user.id) {
      throw new HttpException(ErrorMessages.FORBIDDEN_CATEGORY, HttpStatus.FORBIDDEN);
    }

    const categories = await this.categoriesService.getAll(req.user.id);
    const [incomes, expenses] = this.separateCategories(categories);
    let movedCategories: Category[];

    if (category.transaction_type === TransactionType.INCOME) {
      movedCategories = this.sortCategories(incomes, categoryId, 100);
    } else {
      movedCategories = this.sortCategories(expenses, categoryId, 200);
    }

    await this.categoriesService.save(movedCategories);
  }
}
