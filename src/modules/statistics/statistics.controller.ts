import { Controller, Get, Param, ParseIntPipe, Query, Request } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';

import { StatisticsService } from './statistics.service';
import { StatisticsQueryDto } from './dto/statistics-query.dto';
import type { AuthedRequest } from '@shared/types';

@ApiTags('statistics')
@ApiBearerAuth()
@Controller('spaces/:spaceId/statistics')
export class StatisticsController {
  constructor(private readonly statisticsService: StatisticsService) {}

  @Get('summary')
  async getSummary(
    @Request() req: AuthedRequest,
    @Param('spaceId', ParseIntPipe) spaceId: number,
    @Query() query: StatisticsQueryDto,
  ) {
    return this.statisticsService.getSummary(req.user.id, spaceId, query);
  }

  @Get('trend')
  async getTrend(
    @Request() req: AuthedRequest,
    @Param('spaceId', ParseIntPipe) spaceId: number,
    @Query() query: StatisticsQueryDto,
  ) {
    return this.statisticsService.getTrend(req.user.id, spaceId, query);
  }

  @Get('breakdown')
  async getBreakdown(
    @Request() req: AuthedRequest,
    @Param('spaceId', ParseIntPipe) spaceId: number,
    @Query() query: StatisticsQueryDto,
  ) {
    return this.statisticsService.getBreakdown(req.user.id, spaceId, query);
  }
}
