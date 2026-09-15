import {
  Body,
  ClassSerializerInterceptor,
  Controller,
  Delete,
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
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';

import { CategoriesService } from './categories.service';
import type { AuthedRequest } from '@shared/types';
import { UpdateCategoryDto } from './dto/update-category.dto';
import { ErrorMessages } from '@shared/error-messages';
import { CreateCategoryDto } from './dto/create-category.dto';
import { ReorderCategoriesDto } from './dto/reorder-categories.dto';
import { assertBelongsToSpace } from '@shared/utils';
import { SpaceMembersService } from '@modules/spaces/space-members.service';

@ApiTags('categories')
@ApiBearerAuth()
@Controller('spaces/:spaceId/categories')
export class CategoriesController {
  constructor(
    private readonly categoriesService: CategoriesService,
    private readonly spaceMembersService: SpaceMembersService,
  ) {}

  @UseInterceptors(ClassSerializerInterceptor)
  @Get()
  async getAll(@Request() req: AuthedRequest, @Param('spaceId', ParseIntPipe) spaceId: number) {
    await this.spaceMembersService.assertMembership(spaceId, req.user.id);

    return this.categoriesService.getAll(spaceId);
  }

  @UseInterceptors(ClassSerializerInterceptor)
  @Put('reorder')
  async reorder(
    @Request() req: AuthedRequest,
    @Param('spaceId', ParseIntPipe) spaceId: number,
    @Body() body: ReorderCategoriesDto,
  ) {
    await this.spaceMembersService.assertMembership(spaceId, req.user.id);

    await this.categoriesService.reorder(spaceId, body.category_ids);
  }

  @UseInterceptors(ClassSerializerInterceptor)
  @Put(':categoryId')
  async update(
    @Request() req: AuthedRequest,
    @Param('spaceId', ParseIntPipe) spaceId: number,
    @Param('categoryId', ParseIntPipe) categoryId: number,
    @Body() updateCategory: UpdateCategoryDto,
  ) {
    await this.spaceMembersService.assertMembership(spaceId, req.user.id);

    const category = await this.categoriesService.getOne(categoryId);
    assertBelongsToSpace(category, spaceId, ErrorMessages.FORBIDDEN_CATEGORY);

    if (category.is_system) {
      throw new HttpException(ErrorMessages.CATEGORY_IS_SYSTEM, HttpStatus.BAD_REQUEST);
    }

    return this.categoriesService.update(categoryId, updateCategory);
  }

  @UseInterceptors(ClassSerializerInterceptor)
  @Post()
  async create(
    @Request() req: AuthedRequest,
    @Param('spaceId', ParseIntPipe) spaceId: number,
    @Body() createCategory: CreateCategoryDto,
  ) {
    await this.spaceMembersService.assertMembership(spaceId, req.user.id);

    return this.categoriesService.create(spaceId, createCategory);
  }

  @UseInterceptors(ClassSerializerInterceptor)
  @Delete(':categoryId')
  async remove(
    @Request() req: AuthedRequest,
    @Param('spaceId', ParseIntPipe) spaceId: number,
    @Param('categoryId', ParseIntPipe) categoryId: number,
  ) {
    await this.spaceMembersService.assertMembership(spaceId, req.user.id);

    const category = await this.categoriesService.getOne(categoryId);
    assertBelongsToSpace(category, spaceId, ErrorMessages.FORBIDDEN_CATEGORY);

    if (category.is_system) {
      throw new HttpException(ErrorMessages.CATEGORY_IS_SYSTEM, HttpStatus.BAD_REQUEST);
    }

    return this.categoriesService.deleteOrArchive(categoryId);
  }
}
