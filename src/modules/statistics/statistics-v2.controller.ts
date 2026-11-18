import { Controller, Get, Param, ParseIntPipe, Query, Request } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';

import { StatisticsService } from './statistics.service';
import { StatisticsBreakdownQueryDto, StatisticsQueryDto } from './dto/statistics-query.dto';
import { StatisticsBreakdownV2, StatisticsSummary, StatisticsTrend } from './dto/statistics-responses';
import type { AuthedRequest } from '@shared/types';

const CONTRACT = 'Rules: docs/statistics-contract.md and docs/transactions-v2-contract.md#statistics-v2.';

// The v1 blocks over the records of the space; the breakdown groups by
// assignment instead of by wallet.
@ApiTags('statistics v2')
@ApiBearerAuth()
@ApiBadRequestResponse({ description: 'Invalid or inconsistent query parameters, as `message: [{ field, error }]`.' })
@ApiForbiddenResponse({ description: 'Not a member of the space.' })
@Controller({ path: 'spaces/:spaceId/statistics', version: '2' })
export class StatisticsV2Controller {
  constructor(private readonly statisticsService: StatisticsService) {}

  @ApiOperation({ summary: 'Income, expense, net and the comparison with the previous period', description: CONTRACT })
  @ApiOkResponse({ type: StatisticsSummary })
  @Get('summary')
  async getSummary(
    @Request() req: AuthedRequest,
    @Param('spaceId', ParseIntPipe) spaceId: number,
    @Query() query: StatisticsQueryDto,
  ) {
    return this.statisticsService.getSummary(req.user.id, spaceId, query);
  }

  @ApiOperation({ summary: 'Income and expense per day, week or month of the period', description: CONTRACT })
  @ApiOkResponse({ type: StatisticsTrend })
  @Get('trend')
  async getTrend(
    @Request() req: AuthedRequest,
    @Param('spaceId', ParseIntPipe) spaceId: number,
    @Query() query: StatisticsQueryDto,
  ) {
    return this.statisticsService.getTrend(req.user.id, spaceId, query);
  }

  @ApiOperation({
    summary: 'Expenses or income by category and by assignment, with Other',
    description: `transaction_type defaults to expense. Space and unassigned are never folded. ${CONTRACT}`,
  })
  @ApiOkResponse({ type: StatisticsBreakdownV2 })
  @Get('breakdown')
  async getBreakdown(
    @Request() req: AuthedRequest,
    @Param('spaceId', ParseIntPipe) spaceId: number,
    @Query() query: StatisticsBreakdownQueryDto,
  ) {
    return this.statisticsService.getBreakdownV2(req.user.id, spaceId, query);
  }
}
