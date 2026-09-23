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
import { CreateCategoryDto } from './dto/create-category.dto';
import { ReorderCategoriesDto } from './dto/reorder-categories.dto';

@ApiTags('categories')
@ApiBearerAuth()
@Controller('spaces/:spaceId/categories')
export class CategoriesController {
  constructor(private readonly categoriesService: CategoriesService) {}

  @UseInterceptors(ClassSerializerInterceptor)
  @Get()
  async getAll(@Request() req: AuthedRequest, @Param('spaceId', ParseIntPipe) spaceId: number) {
    return this.categoriesService.getAll(req.user.id, spaceId);
  }

  @UseInterceptors(ClassSerializerInterceptor)
  @Put('reorder')
  async reorder(
    @Request() req: AuthedRequest,
    @Param('spaceId', ParseIntPipe) spaceId: number,
    @Body() body: ReorderCategoriesDto,
  ) {
    await this.categoriesService.reorder(req.user.id, spaceId, body.category_ids);
  }

  @UseInterceptors(ClassSerializerInterceptor)
  @Put(':categoryId')
  async update(
    @Request() req: AuthedRequest,
    @Param('spaceId', ParseIntPipe) spaceId: number,
    @Param('categoryId', ParseIntPipe) categoryId: number,
    @Body() updateCategory: UpdateCategoryDto,
  ) {
    return this.categoriesService.update(req.user.id, spaceId, categoryId, updateCategory);
  }

  @UseInterceptors(ClassSerializerInterceptor)
  @Post()
  async create(
    @Request() req: AuthedRequest,
    @Param('spaceId', ParseIntPipe) spaceId: number,
    @Body() createCategory: CreateCategoryDto,
  ) {
    return this.categoriesService.create(req.user.id, spaceId, createCategory);
  }

  @UseInterceptors(ClassSerializerInterceptor)
  @Delete(':categoryId')
  async remove(
    @Request() req: AuthedRequest,
    @Param('spaceId', ParseIntPipe) spaceId: number,
    @Param('categoryId', ParseIntPipe) categoryId: number,
  ) {
    return this.categoriesService.deleteOrArchive(req.user.id, spaceId, categoryId);
  }
}
