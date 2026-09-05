import {
  Body,
  ClassSerializerInterceptor,
  Controller,
  Delete,
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
import type { AuthedRequest } from '@shared/types';
import { UpdateCategoryDto } from './dto/update-category.dto';
import { ErrorMessages } from '@shared/error-messages';
import { CreateCategoryDto } from './dto/create-category.dto';
import { ReorderCategoriesDto } from './dto/reorder-categories.dto';
import { assertOwnership } from '@shared/utils';

@ApiTags('categories')
@ApiBearerAuth()
@Controller('categories')
export class CategoriesController {
  constructor(private readonly categoriesService: CategoriesService) {}

  @UseInterceptors(ClassSerializerInterceptor)
  @Get()
  async getAll(@Request() req: AuthedRequest) {
    return this.categoriesService.getAll(req.user.id);
  }

  @UseInterceptors(ClassSerializerInterceptor)
  @Put('reorder')
  async reorder(@Request() req: AuthedRequest, @Body() body: ReorderCategoriesDto) {
    await this.categoriesService.reorder(req.user.id, body.category_ids);
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
  @Delete(':categoryId')
  async remove(@Request() req: AuthedRequest, @Param('categoryId', ParseIntPipe) categoryId: number) {
    const category = await this.categoriesService.getOne(categoryId);
    assertOwnership(category, req.user.id, ErrorMessages.FORBIDDEN_CATEGORY);

    return this.categoriesService.deleteOrArchive(categoryId);
  }
}
