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
import { StatisticsQueryDto } from './dto/statistics-query.dto';
import { StatisticsBreakdown, StatisticsSummary, StatisticsTrend } from './dto/statistics-responses';
import type { AuthedRequest } from '@shared/types';

const CONTRACT = 'Rules: docs/statistics-contract.md.';

@ApiTags('statistics')
@ApiBearerAuth()
@ApiBadRequestResponse({ description: 'Invalid or inconsistent query parameters, as `message: [{ field, error }]`.' })
@ApiForbiddenResponse({ description: 'Not a member of the space.' })
@Controller('spaces/:spaceId/statistics')
export class StatisticsController {
  constructor(private readonly statisticsService: StatisticsService) {}

  @ApiOperation({
    summary: 'Income, expense, net and the comparison with the previous period',
    description: `Also has_any_transactions and last_transaction_date. ${CONTRACT}`,
  })
  @ApiOkResponse({ type: StatisticsSummary })
  @Get('summary')
  async getSummary(
    @Request() req: AuthedRequest,
    @Param('spaceId', ParseIntPipe) spaceId: number,
    @Query() query: StatisticsQueryDto,
  ) {
    return this.statisticsService.getSummary(req.user.id, spaceId, query);
  }

  @ApiOperation({
    summary: 'Income and expense per day, week or month of the period',
    description: `Buckets cover the whole period; future ones are null. ${CONTRACT}`,
  })
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
    summary: 'Expenses by category and by wallet, with Other',
    description: `Both groupings at once; Other children inline. ${CONTRACT}`,
  })
  @ApiOkResponse({ type: StatisticsBreakdown })
  @Get('breakdown')
  async getBreakdown(
    @Request() req: AuthedRequest,
    @Param('spaceId', ParseIntPipe) spaceId: number,
    @Query() query: StatisticsQueryDto,
  ) {
    return this.statisticsService.getBreakdown(req.user.id, spaceId, query);
  }
}
