import {
  Body,
  ClassSerializerInterceptor,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Put,
  Request,
  UseInterceptors,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';

import { CategoriesService } from './categories.service';
import type { AuthedRequest } from '../../shared/types';
import { UpdateCategoryDto } from './dto/update-category.dto';
import { ErrorMessages } from '../../shared/error-messages';
import { CreateCategoryDto } from './dto/create-category.dto';
import { assertOwnership } from '../../shared/utils';

@ApiTags('categories')
@ApiBearerAuth()
@Controller('categories')
export class CategoriesController {
  constructor(private readonly categoriesService: CategoriesService) {}

  @UseInterceptors(ClassSerializerInterceptor)
  @Get()
  async getAll(@Request() req: AuthedRequest) {
    const categories = await this.categoriesService.getAll(req.user.id);
    const [incomes, expenses] = this.categoriesService.separateCategories(categories);

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
    assertOwnership(category, req.user.id, ErrorMessages.FORBIDDEN_CATEGORY);

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
    assertOwnership(category, req.user.id, ErrorMessages.FORBIDDEN_CATEGORY);

    await this.categoriesService.moveToFront(req.user.id, category);
  }
}
