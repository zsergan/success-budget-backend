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

import type { AuthedRequest } from '@shared/types';
import { LimitsService } from './limits.service';
import { TransactionQueriesService } from '@modules/transaction-queries/transaction-queries.service';
import { CategoriesService } from '@modules/categories/categories.service';
import { SpaceAccessService } from '@modules/space-access/space-access.service';
import { CreateLimitDto } from './dto/create-limit.dto';
import { UpdateLimitDto } from './dto/update-limit.dto';
import { getEndOfMonth, getStartOfMonth, assertBelongsToSpace } from '@shared/utils';
import { ErrorMessages } from '@shared/error-messages';

@ApiTags('limits')
@ApiBearerAuth()
@Controller('spaces/:spaceId/limits')
export class LimitsController {
  constructor(
    private readonly limitsService: LimitsService,
    private readonly transactionQueriesService: TransactionQueriesService,
    private readonly categoriesService: CategoriesService,
    private readonly spaceAccessService: SpaceAccessService,
  ) {}

  @UseInterceptors(ClassSerializerInterceptor)
  @Get()
  async getAll(@Request() req: AuthedRequest, @Param('spaceId', ParseIntPipe) spaceId: number) {
    await this.spaceAccessService.assertMembership(spaceId, req.user.id);

    const limits = await this.limitsService.getAll(spaceId);
    const categoryTotals = await this.transactionQueriesService.getExpensesByCategory(
      spaceId,
      getStartOfMonth(new Date()),
      getEndOfMonth(new Date()),
    );

    return this.limitsService.calculateSpending(limits, categoryTotals);
  }

  @UseInterceptors(ClassSerializerInterceptor)
  @Post()
  async create(
    @Request() req: AuthedRequest,
    @Param('spaceId', ParseIntPipe) spaceId: number,
    @Body() createLimitDto: CreateLimitDto,
  ) {
    await this.spaceAccessService.assertMembership(spaceId, req.user.id);
    await this.assertCategoriesOwnership(spaceId, createLimitDto.category_ids);

    return this.limitsService.create(spaceId, createLimitDto);
  }

  @UseInterceptors(ClassSerializerInterceptor)
  @Put(':limitId')
  async update(
    @Request() req: AuthedRequest,
    @Param('spaceId', ParseIntPipe) spaceId: number,
    @Param('limitId', ParseIntPipe) limitId: number,
    @Body() updateLimitDto: UpdateLimitDto,
  ) {
    await this.spaceAccessService.assertMembership(spaceId, req.user.id);

    const limit = await this.limitsService.getOne(limitId);
    assertBelongsToSpace(limit, spaceId, ErrorMessages.FORBIDDEN_LIMIT);

    await this.assertCategoriesOwnership(spaceId, updateLimitDto.category_ids);

    await this.limitsService.update(limitId, spaceId, limit, updateLimitDto);

    return this.limitsService.getOne(limitId);
  }

  @Delete(':limitId')
  async remove(
    @Request() req: AuthedRequest,
    @Param('spaceId', ParseIntPipe) spaceId: number,
    @Param('limitId', ParseIntPipe) limitId: number,
  ): Promise<boolean> {
    await this.spaceAccessService.assertMembership(spaceId, req.user.id);

    const limit = await this.limitsService.getOne(limitId);
    assertBelongsToSpace(limit, spaceId, ErrorMessages.FORBIDDEN_LIMIT);

    await this.limitsService.remove(limitId);

    return true;
  }

  private async assertCategoriesOwnership(spaceId: number, categoryIds?: number[]): Promise<void> {
    const ids = categoryIds ?? [];

    if (ids.length === 0) {
      return;
    }

    const categoriesById = new Map(
      (await this.categoriesService.getMany(ids)).map((category) => [category.id, category]),
    );

    for (const categoryId of ids) {
      const category = categoriesById.get(categoryId);
      assertBelongsToSpace(category, spaceId, ErrorMessages.FORBIDDEN_CATEGORY);

      if (category.is_system) {
        throw new HttpException(ErrorMessages.CATEGORY_IS_SYSTEM, HttpStatus.BAD_REQUEST);
      }
    }
  }
}
