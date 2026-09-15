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
import { SpaceMembersService } from '@modules/spaces/space-members.service';
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
    private readonly transactionsService: TransactionsService,
    private readonly categoriesService: CategoriesService,
    private readonly spaceMembersService: SpaceMembersService,
  ) {}

  @UseInterceptors(ClassSerializerInterceptor)
  @Get()
  async getAll(@Request() req: AuthedRequest, @Param('spaceId', ParseIntPipe) spaceId: number) {
    await this.spaceMembersService.assertMembership(spaceId, req.user.id);

    const limits = await this.limitsService.getAll(spaceId);
    const transactions = await this.transactionsService.getForAllWallets(
      spaceId,
      getStartOfMonth(new Date()),
      getEndOfMonth(new Date()),
    );

    return this.limitsService.calculateSpending(limits, transactions);
  }

  @UseInterceptors(ClassSerializerInterceptor)
  @Post()
  async create(
    @Request() req: AuthedRequest,
    @Param('spaceId', ParseIntPipe) spaceId: number,
    @Body() createLimitDto: CreateLimitDto,
  ) {
    await this.spaceMembersService.assertMembership(spaceId, req.user.id);
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
    await this.spaceMembersService.assertMembership(spaceId, req.user.id);

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
    await this.spaceMembersService.assertMembership(spaceId, req.user.id);

    const limit = await this.limitsService.getOne(limitId);
    assertBelongsToSpace(limit, spaceId, ErrorMessages.FORBIDDEN_LIMIT);

    await this.limitsService.remove(limitId);

    return true;
  }

  private async assertCategoriesOwnership(spaceId: number, categoryIds?: number[]): Promise<void> {
    for (const categoryId of categoryIds ?? []) {
      const category = await this.categoriesService.getOne(categoryId);
      assertBelongsToSpace(category, spaceId, ErrorMessages.FORBIDDEN_CATEGORY);
    }
  }
}
