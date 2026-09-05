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

import type { AuthedRequest } from '@shared/types';
import { LimitsService } from './limits.service';
import { TransactionsService } from '@modules/transactions/transactions.service';
import { CategoriesService } from '@modules/categories/categories.service';
import { CreateLimitDto } from './dto/create-limit.dto';
import { UpdateLimitDto } from './dto/update-limit.dto';
import { getEndOfMonth, getStartOfMonth, assertOwnership } from '@shared/utils';
import { ErrorMessages } from '@shared/error-messages';

@ApiTags('limits')
@ApiBearerAuth()
@Controller('limits')
export class LimitsController {
  constructor(
    private readonly limitsService: LimitsService,
    private readonly transactionsService: TransactionsService,
    private readonly categoriesService: CategoriesService,
  ) {}

  @UseInterceptors(ClassSerializerInterceptor)
  @Get()
  async getAll(@Request() req: AuthedRequest) {
    const limits = await this.limitsService.getAll(req.user.id);
    const transactions = await this.transactionsService.getForAllWallets(
      req.user.id,
      getStartOfMonth(new Date()),
      getEndOfMonth(new Date()),
    );

    return this.limitsService.calculateSpending(limits, transactions);
  }

  @UseInterceptors(ClassSerializerInterceptor)
  @Post()
  async create(@Request() req: AuthedRequest, @Body() createLimitDto: CreateLimitDto) {
    await this.assertCategoriesOwnership(req.user.id, createLimitDto.category_ids);

    return this.limitsService.create(req.user.id, createLimitDto);
  }

  @UseInterceptors(ClassSerializerInterceptor)
  @Put(':limitId')
  async update(
    @Request() req: AuthedRequest,
    @Param('limitId', ParseIntPipe) limitId: number,
    @Body() updateLimitDto: UpdateLimitDto,
  ) {
    const limit = await this.limitsService.getOne(limitId);
    assertOwnership(limit, req.user.id, ErrorMessages.FORBIDDEN_LIMIT);

    await this.assertCategoriesOwnership(req.user.id, updateLimitDto.category_ids);

    await this.limitsService.update(limitId, req.user.id, limit, updateLimitDto);

    return this.limitsService.getOne(limitId);
  }

  @Delete(':limitId')
  async remove(@Request() req: AuthedRequest, @Param('limitId', ParseIntPipe) limitId: number): Promise<boolean> {
    const limit = await this.limitsService.getOne(limitId);
    assertOwnership(limit, req.user.id, ErrorMessages.FORBIDDEN_LIMIT);

    await this.limitsService.remove(limitId);

    return true;
  }

  private async assertCategoriesOwnership(userId: number, categoryIds?: number[]): Promise<void> {
    for (const categoryId of categoryIds ?? []) {
      const category = await this.categoriesService.getOne(categoryId);
      assertOwnership(category, userId, ErrorMessages.FORBIDDEN_CATEGORY);
    }
  }
}
