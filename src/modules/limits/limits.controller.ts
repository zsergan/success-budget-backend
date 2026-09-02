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
    if (createLimitDto.category_id) {
      const category = await this.categoriesService.getOne(createLimitDto.category_id);
      assertOwnership(category, req.user.id, ErrorMessages.FORBIDDEN_CATEGORY);
    }

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

    if (updateLimitDto.category_id) {
      const category = await this.categoriesService.getOne(updateLimitDto.category_id);
      assertOwnership(category, req.user.id, ErrorMessages.FORBIDDEN_CATEGORY);
    }

    return this.limitsService.update(limitId, req.user.id, limit.category_id, updateLimitDto);
  }
}
